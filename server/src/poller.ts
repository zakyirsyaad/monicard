import { blitzArenaAbi, decodeDuels, type DuelStatus, type DuelView, type Hex } from '@nad/shared';
import { encodeFunctionData, parseEventLogs } from 'viem';
import type { ChainLike } from './chainTypes';
import type { ReceiptHub, TxReceipt } from './receiptHub';
import type { StatsSnapshot } from './stats';
import type { AgentMsg, ConnectCallback, DuelsMsg, StatsMsg, WsMessage } from './ws';

/** Duels read per poll: the most recent ones; older duels are long finished. */
export const ACTIVE_WINDOW_SIZE = 64;
/** The NadCards balance (treasury) is read at most this often. */
export const TREASURY_REFRESH_MS = 10_000;
/** A settle that is still not visible on chain after this many blocks may be sent again. */
export const SETTLE_RETRY_BLOCKS = 10;
/** Poll/startup errors are logged at most once per this interval. */
export const POLL_ERROR_LOG_MS = 60_000;
const DEFAULT_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;

const FINISHED: ReadonlySet<DuelStatus> = new Set<DuelStatus>(['P1Won', 'P2Won', 'Draw']);

/** Ids of unsettled duels that `settle` can act on: finished, or Active past `endBlock`. */
export function selectSettleable(duels: readonly DuelView[], block: number): string[] {
  return duels
    .filter((d) => !d.settled && (FINISHED.has(d.status) || (d.status === 'Active' && block >= d.endBlock)))
    .map((d) => d.id);
}

export function activeWindow(duelCount: bigint, size = ACTIVE_WINDOW_SIZE): { from: bigint; count: bigint } {
  const count = duelCount < BigInt(size) ? duelCount : BigInt(size);
  return { from: duelCount - count, count };
}

let featuredOverride: string | null = null;

/** Admin override of the featured duel; `null` hands control back to `pickFeatured`. */
export function setFeatured(id: string | null): void {
  featuredOverride = id;
}

export function getFeatured(): string | null {
  return featuredOverride;
}

/** Newest duel (highest id) in which neither player is a bot. The AI Agent is not a bot. */
export function pickFeatured(duels: readonly DuelView[], bots: ReadonlySet<Hex>): string | null {
  let best: bigint | null = null;
  for (const d of duels) {
    if (bots.has(d.p1.toLowerCase() as Hex) || bots.has(d.p2.toLowerCase() as Hex)) continue;
    const id = BigInt(d.id);
    if (best === null || id > best) best = id;
  }
  return best === null ? null : best.toString();
}

export type PollerDeps = {
  chain: ChainLike;
  hub: ReceiptHub;
  ws: { broadcast(m: WsMessage): void; onConnect(cb: ConnectCallback): void };
  stats: { snapshot(): StatsSnapshot };
  arena: Hex;
  cards: Hex;
  operator: { send(req: { to: Hex; data: Hex; gas: bigint }): Promise<Hex> };
  settleGas: bigint;
  bots: () => Hex[];
  getAgentMessage: () => AgentMsg | null;
  /** Base delay for retrying the startup `duelCount` read. */
  pollMs?: number;
  now?: () => number;
};

export type Poller = {
  getDuel(id: string): DuelView | undefined;
  /** Block (decimal) at which `id` was created, from the DuelCreated log; undefined for duels created before startup. */
  createdBlock(id: string): number | undefined;
  /** Cached duels, ordered by id. */
  duels(): DuelView[];
  /** Block the current duel snapshot was read at (0 before the first successful read). */
  latestBlock(): number;
  stop(): void;
};

export function startPoller(deps: PollerDeps): Poller {
  const { chain, ws, arena, cards } = deps;
  const arenaLower = arena.toLowerCase();
  const now = deps.now ?? Date.now;
  const retryBase = deps.pollMs ?? DEFAULT_RETRY_MS;

  let stopped = false;
  let ready = false;
  let running = false;
  let pendingBlock: bigint | null = null;
  let knownCount = 0n;
  let cache = new Map<string, DuelView>();
  let created = new Map<string, number>();
  let snapshotBlock = 0;
  let lastDuels: DuelsMsg | null = null;
  let lastStats: StatsMsg | null = null;
  let treasury = '0';
  let treasuryAt: number | null = null;
  let lastErrorLogAt: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const settleInFlight = new Map<string, number>();
  const settleErrorsLogged = new Set<string>();

  function logError(what: string, err: unknown): void {
    const t = now();
    if (lastErrorLogAt !== null && t - lastErrorLogAt < POLL_ERROR_LOG_MS) return;
    lastErrorLogAt = t;
    console.error(`poller: ${what}`, err);
  }

  const readCount = (): Promise<bigint> =>
    chain.call((c) => c.readContract({ address: arena, abi: blitzArenaAbi, functionName: 'duelCount' }));

  const readDuels = (from: bigint, count: bigint): Promise<readonly unknown[]> =>
    chain.call((c) =>
      c.readContract({ address: arena, abi: blitzArenaAbi, functionName: 'getDuels', args: [from, count] }),
    );

  /** Counts DuelCreated logs: the count only ever grows to `id + 1`, so a startup race cannot double count. */
  function recordCreated(receipts: readonly TxReceipt[], block: bigint): void {
    for (const receipt of receipts) {
      const logs = receipt.logs.filter((l) => l.address.toLowerCase() === arenaLower);
      if (logs.length === 0) continue;
      for (const event of parseEventLogs({ abi: blitzArenaAbi, eventName: 'DuelCreated', logs })) {
        const id = event.args.id;
        if (id + 1n > knownCount) knownCount = id + 1n;
        created = new Map(created).set(id.toString(), Number(receipt.blockNumber ?? block));
      }
    }
  }

  function refreshTreasury(): void {
    if (treasuryAt !== null && now() - treasuryAt < TREASURY_REFRESH_MS) return;
    treasuryAt = now();
    chain
      .call((c) => c.getBalance({ address: cards }))
      .then((wei) => {
        treasury = wei.toString();
      })
      .catch((err: unknown) => logError('treasury read failed', err));
  }

  function sendSettle(id: string): void {
    const data = encodeFunctionData({ abi: blitzArenaAbi, functionName: 'settle', args: [BigInt(id)] });
    deps.operator.send({ to: arena, data, gas: deps.settleGas }).catch((err: unknown) => {
      if (settleErrorsLogged.has(id)) return;
      settleErrorsLogged.add(id);
      console.error(`poller: settle(${id}) send failed`, err);
    });
  }

  function settleDue(duels: readonly DuelView[], block: number): void {
    const byId = new Map(duels.map((d) => [d.id, d]));
    for (const [id, sentAt] of settleInFlight) {
      const d = byId.get(id);
      if (!d || d.settled || block - sentAt >= SETTLE_RETRY_BLOCKS) settleInFlight.delete(id);
    }
    for (const id of selectSettleable(duels, block)) {
      if (settleInFlight.has(id)) continue;
      settleInFlight.set(id, block);
      sendSettle(id);
    }
  }

  /** Publishes a successfully read snapshot: cache and block number move together (never block-ahead-of-cache). */
  function publish(duels: DuelView[], from: bigint, block: bigint): void {
    cache = new Map(duels.map((d) => [d.id, d]));
    created = new Map([...created].filter(([id]) => BigInt(id) >= from));
    snapshotBlock = Number(block);
  }

  function broadcastSnapshot(duels: DuelView[], block: bigint): void {
    const bots = new Set(deps.bots().map((b) => b.toLowerCase() as Hex));
    refreshTreasury();
    lastDuels = { type: 'duels', block: block.toString(), duels, featuredId: getFeatured() ?? pickFeatured(duels, bots) };
    lastStats = {
      type: 'stats',
      block: block.toString(),
      ...deps.stats.snapshot(),
      uniquePlayers: 0,
      totalDuels: 0,
      treasury,
    };
    ws.broadcast(lastDuels);
    ws.broadcast(lastStats);
  }

  async function pollOnce(block: bigint): Promise<void> {
    const { from, count } = activeWindow(knownCount);
    let duels: DuelView[];
    try {
      duels = count === 0n ? [] : decodeDuels(await readDuels(from, count), from);
    } catch (err) {
      logError('getDuels failed', err);
      return;
    }
    publish(duels, from, block);
    broadcastSnapshot(duels, block);
    settleDue(duels, Number(block));
  }

  async function drain(): Promise<void> {
    try {
      while (pendingBlock !== null && !stopped) {
        const block = pendingBlock;
        pendingBlock = null;
        await pollOnce(block);
      }
    } finally {
      running = false;
    }
  }

  /** Never overlaps: a trigger during a running poll only remembers the newest block. */
  function requestPoll(block: bigint): void {
    if (pendingBlock === null || block > pendingBlock) pendingBlock = block;
    if (running || !ready || stopped) return;
    running = true;
    void drain();
  }

  async function init(): Promise<void> {
    let delay = retryBase;
    while (!stopped) {
      try {
        const onChain = await readCount();
        if (onChain > knownCount) knownCount = onChain;
        ready = true;
        if (pendingBlock !== null) requestPoll(pendingBlock);
        return;
      } catch (err) {
        logError('duelCount read failed, retrying', err);
        await new Promise<void>((resolve) => (retryTimer = setTimeout(resolve, delay)));
        delay = Math.min(delay * 2, MAX_RETRY_MS);
      }
    }
  }

  deps.hub.onIngest((block, receipts) => {
    recordCreated(receipts, block);
    requestPoll(block);
  });

  // The hub's `send` applies the connection's scope filter, so a phone only sees its own duel.
  ws.onConnect((send) => {
    if (lastDuels) send(lastDuels);
    if (lastStats) send(lastStats);
    const agent = deps.getAgentMessage();
    if (agent) send(agent);
  });

  void init();

  return {
    getDuel: (id) => cache.get(id),
    createdBlock: (id) => created.get(id),
    duels: () => [...cache.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)),
    latestBlock: () => snapshotBlock,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
    },
  };
}
