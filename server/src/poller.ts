import { blitzArenaAbi, decodeDuels, type DuelStatus, type DuelView, type Hex } from '@nad/shared';
import { encodeFunctionData, parseEventLogs } from 'viem';
import { battleAbi } from './battleAbi';
import { decodeMatches, matchWindow, pickFeaturedMatch, type BattleMatch } from './battle';
import type { ChainLike } from './chainTypes';
import type { ReceiptHub, TxReceipt } from './receiptHub';
import type { StatsSnapshot } from './stats';
import type { AgentMsg, ConnectCallback, DuelsMsg, MatchesMsg, StatsMsg, WsMessage } from './ws';

/** Duels read per poll: the most recent ones; older duels are long finished. */
export const ACTIVE_WINDOW_SIZE = 64;
/** The NadCards balance (treasury) is read at most this often. */
export const TREASURY_REFRESH_MS = 10_000;
/** First wait (in blocks) before a settle whose send finished but is still not visible is sent again; doubles per attempt. */
export const SETTLE_RETRY_BLOCKS = 10;
/** After this many sends for one duel the poller pauses it (logged once per cycle). */
export const MAX_SETTLE_ATTEMPTS = 5;
/** A paused settle becomes eligible again (attempts reset to 0) after this many blocks (~3 min). */
export const SETTLE_COOLOFF_BLOCKS = 600;
/** Hard cap on unsubscribed duels kept outside the window (unsettled, waiting for settle); oldest ids dropped first. */
export const MAX_UNSETTLED_STICKY = 64;
/** Settle sends whose operator.send promise is still pending; the rest wait for the next poll. */
export const MAX_SETTLES_IN_FLIGHT = 8;
/** `duelCount()` is re-read this often (alongside the treasury) to heal missed DuelCreated logs. */
export const DUEL_COUNT_RESYNC_MS = 10_000;
/** Duels outside the window that are re-read (`getDuels(id, 1)`) per poll. */
export const STICKY_READS_PER_POLL = 8;
/** Subscribed Card Battle matches outside the window that are re-read (`getMatch`) per poll. */
export const STICKY_MATCH_READS_PER_POLL = 8;
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

const newestId = (duels: readonly DuelView[]): string | null =>
  duels.reduce<bigint | null>((best, d) => (best === null || BigInt(d.id) > best ? BigInt(d.id) : best), null)?.toString() ??
  null;

/**
 * Newest Active duel in which neither player is a bot, else the newest non-bot duel of any status.
 * The AI Agent is not a bot.
 */
export function pickFeatured(duels: readonly DuelView[], bots: ReadonlySet<Hex>): string | null {
  const human = duels.filter((d) => !bots.has(d.p1.toLowerCase() as Hex) && !bots.has(d.p2.toLowerCase() as Hex));
  return newestId(human.filter((d) => d.status === 'Active')) ?? newestId(human);
}

export type PollerDeps = {
  chain: ChainLike;
  hub: ReceiptHub;
  ws: {
    broadcast(m: WsMessage): void;
    onConnect(cb: ConnectCallback): void;
    /** Duel ids that scoped (phone) connections are subscribed to; keeps them out of the eviction window. */
    subscribedIds?(): ReadonlySet<string>;
    /** Card Battle match ids that scoped connections are subscribed to. */
    subscribedMatchIds?(): ReadonlySet<string>;
  };
  stats: { snapshot(): StatsSnapshot };
  arena: Hex;
  cards: Hex;
  /** CardBattle address; battle polling is skipped when absent. */
  battle?: Hex;
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
  /** Cached Card Battle match (`getMatch` fallback for the agent runner), if read. */
  battleMatch(id: string): BattleMatch | undefined;
  /** Cached Card Battle matches, ordered by id. */
  battleMatches(): BattleMatch[];
  /** Block the current duel snapshot was read at (0 before the first successful read). */
  latestBlock(): number;
  stop(): void;
};

type SettleState = { attempts: number; pending: boolean; retryAt: number; gaveUp: boolean };

const NO_IDS: ReadonlySet<string> = new Set();
const isDecimalId = (id: string): boolean => /^\d{1,20}$/.test(id);
const byIdAscending = (a: DuelView, b: DuelView): number => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
const matchByIdAscending = (a: BattleMatch, b: BattleMatch): number => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
/** Blocks to wait after the `attempts`-th settle send finished: 10, 20, 40, ... */
const settleBackoff = (attempts: number): number => SETTLE_RETRY_BLOCKS * 2 ** (attempts - 1);

export function startPoller(deps: PollerDeps): Poller {
  const { chain, ws, arena, cards } = deps;
  const arenaLower = arena.toLowerCase();
  const now = deps.now ?? Date.now;
  const retryBase = deps.pollMs ?? DEFAULT_RETRY_MS;

  let stopped = false;
  let ready = false;
  let running = false;
  let pendingBlock: bigint | null = null;
  let latestSeen = 0;
  let knownCount = 0n;
  /** Window duels plus "sticky" duels that left the window but are subscribed or still need settling. */
  let cache = new Map<string, DuelView>();
  let created = new Map<string, number>();
  let snapshotBlock = 0;
  let lastDuels: DuelsMsg | null = null;
  let lastStats: StatsMsg | null = null;
  let lastMatches: MatchesMsg | null = null;
  /** Card Battle window (plus subscribed matches outside it); `getMatch` is the runner's fallback. */
  let matchCache = new Map<string, BattleMatch>();
  let treasury = '0';
  let treasuryAt: number | null = null;
  let countAt = 0;
  let lastErrorLogAt: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const settleState = new Map<string, SettleState>();
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

  const readMatchCount = (): Promise<bigint> =>
    chain.call((c) => c.readContract({ address: deps.battle!, abi: battleAbi, functionName: 'matchCount' }));

  const readMatches = (from: bigint, count: bigint): Promise<readonly unknown[]> =>
    chain.call((c) =>
      c.readContract({ address: deps.battle!, abi: battleAbi, functionName: 'getMatches', args: [from, count] }),
    );

  const readMatch = (id: bigint): Promise<unknown> =>
    chain.call((c) => c.readContract({ address: deps.battle!, abi: battleAbi, functionName: 'getMatch', args: [id] }));

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

  /** Heals a duelCount that missed DuelCreated logs (e.g. a watcher gap); the count never shrinks. */
  function resyncDuelCount(): void {
    if (now() - countAt < DUEL_COUNT_RESYNC_MS) return;
    countAt = now();
    readCount()
      .then((onChain) => {
        if (onChain > knownCount) knownCount = onChain;
      })
      .catch((err: unknown) => logError('duelCount resync failed', err));
  }

  // ------------------------------------------------------------------ sticky duels

  /** Does a duel outside the window still deserve a cache slot? */
  function keepSticky(d: DuelView, subs: ReadonlySet<string>): boolean {
    if (subs.has(d.id)) return true;
    return d.status !== 'Open' && !d.settled;
  }

  /** Keeps at most MAX_UNSETTLED_STICKY unsubscribed duels (newest ids win); subscribed ones are never dropped. */
  function capUnsubscribed(next: Map<string, DuelView>, subs: ReadonlySet<string>): Map<string, DuelView> {
    const loose = [...next.keys()].filter((id) => !subs.has(id)).sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1));
    const dropped = new Set(loose.slice(MAX_UNSETTLED_STICKY));
    return dropped.size === 0 ? next : new Map([...next].filter(([id]) => !dropped.has(id)));
  }

  async function readOne(id: string): Promise<DuelView | null> {
    try {
      return decodeDuels(await readDuels(BigInt(id), 1n), BigInt(id))[0] ?? null;
    } catch (err) {
      logError(`getDuels(${id}, 1) failed`, err);
      return null;
    }
  }

  /**
   * Ids to re-read, subscribed first, then newest first, capped. Subscribed duels are read every poll until
   * settled; unsubscribed ones only once they are finished or past endBlock (to learn that settle landed).
   */
  function pickReads(ids: string[], views: Map<string, DuelView>, subs: ReadonlySet<string>, block: number): string[] {
    const due = (id: string): boolean => {
      const d = views.get(id);
      if (!d) return true;
      if (d.settled) return false;
      const st = settleState.get(id);
      if (!subs.has(id) && st?.gaveUp && block < st.retryAt) return false; // cooling off: nothing new to learn
      return subs.has(id) || FINISHED.has(d.status) || block >= d.endBlock;
    };
    return ids
      .filter(due)
      .sort((a, b) => Number(subs.has(b)) - Number(subs.has(a)) || (BigInt(a) < BigInt(b) ? 1 : -1))
      .slice(0, STICKY_READS_PER_POLL);
  }

  /**
   * Duels that left the 64-window. A phone's reducer replaces its duel map with every `duels` message, so a
   * subscribed duel must keep being sent. Settled ones reuse their last view; the rest are re-read (see pickReads).
   */
  async function resolveSticky(
    window: ReadonlyMap<string, DuelView>,
    subs: ReadonlySet<string>,
    block: number,
  ): Promise<Map<string, DuelView>> {
    const views = new Map<string, DuelView>();
    for (const [id, d] of cache) if (!window.has(id)) views.set(id, d);
    const known = (id: string): boolean => isDecimalId(id) && BigInt(id) < knownCount;
    const wanted = new Set([...views.keys(), ...[...subs].filter((id) => !window.has(id) && known(id))]);
    const ids = [...wanted].filter((id) => subs.has(id) || (views.has(id) && keepSticky(views.get(id)!, subs)));
    const reads = pickReads(ids, views, subs, block);
    const fresh = await Promise.all(reads.map(readOne));
    const next = new Map<string, DuelView>();
    for (const id of ids) {
      const d = fresh[reads.indexOf(id)] ?? views.get(id);
      if (d && keepSticky(d, subs)) next.set(id, d);
    }
    return capUnsubscribed(next, subs);
  }

  // ------------------------------------------------------------------ settle

  function startSettle(id: string, attempts: number): void {
    const state: SettleState = { attempts, pending: true, retryAt: Number.POSITIVE_INFINITY, gaveUp: false };
    settleState.set(id, state);
    const data = encodeFunctionData({ abi: blitzArenaAbi, functionName: 'settle', args: [BigInt(id)] });
    let sent: Promise<unknown>;
    try {
      sent = deps.operator.send({ to: arena, data, gas: deps.settleGas });
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent
      .catch((err: unknown) => {
        if (settleErrorsLogged.has(id)) return;
        settleErrorsLogged.add(id);
        console.error(`poller: settle(${id}) send failed`, err);
      })
      .finally(() => {
        // The retry wait only starts once the send is over, so a slow queue never causes duplicates.
        state.pending = false;
        state.retryAt = latestSeen + settleBackoff(attempts);
      });
  }

  function dropFinishedSettleState(byId: ReadonlyMap<string, DuelView>): void {
    for (const [id, st] of settleState) {
      const d = byId.get(id);
      if (d?.settled || (!d && !st.pending)) settleState.delete(id);
    }
  }

  function settleDue(views: readonly DuelView[], block: number): void {
    dropFinishedSettleState(new Map(views.map((d) => [d.id, d])));
    let pending = [...settleState.values()].filter((st) => st.pending).length;
    for (const id of selectSettleable(views, block)) {
      let st = settleState.get(id);
      if (st && (st.pending || block < st.retryAt)) continue;
      if (st?.gaveUp) {
        console.error(`poller: settle retry after cool-off for duel ${id}`);
        settleErrorsLogged.delete(id);
        st = undefined; // new cycle: attempts back to 0
      } else if (st && st.attempts >= MAX_SETTLE_ATTEMPTS) {
        settleState.set(id, { ...st, gaveUp: true, retryAt: block + SETTLE_COOLOFF_BLOCKS });
        console.error(`poller: giving up on settle(${id}) after ${st.attempts} attempts, cool-off ${SETTLE_COOLOFF_BLOCKS} blocks`);
        continue;
      }
      if (pending >= MAX_SETTLES_IN_FLIGHT) return;
      startSettle(id, (st?.attempts ?? 0) + 1);
      pending += 1;
    }
  }

  /** Reads the 64-match battle window plus subscribed matches outside it; never blocks the duel feed. */
  async function refreshMatches(block: bigint): Promise<void> {
    if (deps.battle === undefined) return;
    try {
      const total = await readMatchCount();
      const { from, count } = matchWindow(total);
      const window = count === 0n ? [] : decodeMatches(await readMatches(from, count), from);
      const subs = ws.subscribedMatchIds?.() ?? NO_IDS;
      const outside = [...subs]
        .filter((id) => isDecimalId(id) && !window.some((m) => m.id === id))
        .slice(0, STICKY_MATCH_READS_PER_POLL);
      const extra: BattleMatch[] = [];
      for (const id of outside) {
        try {
          const one = decodeMatches([await readMatch(BigInt(id))], BigInt(id))[0];
          if (one) extra.push(one);
        } catch {
          // A failed sticky read keeps the previous cached view (added below).
        }
      }
      const next = new Map<string, BattleMatch>();
      for (const m of [...window, ...extra]) next.set(m.id, m);
      for (const [id, m] of matchCache) if (subs.has(id) && !next.has(id)) next.set(id, m);
      matchCache = next;
      const bots = new Set(deps.bots().map((b) => b.toLowerCase() as Hex));
      lastMatches = {
        type: 'matches',
        block: block.toString(),
        featuredId: pickFeaturedMatch(window, bots),
        matches: [...matchCache.values()].sort(matchByIdAscending),
      };
      ws.broadcast(lastMatches);
    } catch (err) {
      logError('getMatches failed', err);
    }
  }

  // ------------------------------------------------------------------ polling

  const statsMsg = (block: bigint): StatsMsg => ({
    type: 'stats',
    block: block.toString(),
    ...deps.stats.snapshot(),
    uniquePlayers: 0,
    totalDuels: 0,
    treasury,
  });

  /** Publishes a successfully read snapshot: cache and block move together (never block-ahead-of-cache). */
  function publish(window: DuelView[], sticky: Map<string, DuelView>, from: bigint, block: bigint): void {
    cache = new Map([...sticky, ...window.map((d): [string, DuelView] => [d.id, d])]);
    created = new Map([...created].filter(([id]) => BigInt(id) >= from || sticky.has(id)));
    snapshotBlock = Number(block);
  }

  function broadcastSnapshot(window: DuelView[], sticky: Map<string, DuelView>, subs: ReadonlySet<string>, block: bigint): void {
    const bots = new Set(deps.bots().map((b) => b.toLowerCase() as Hex));
    const shown = [...[...sticky.values()].filter((d) => subs.has(d.id)).sort(byIdAscending), ...window];
    const override = getFeatured();
    const featuredId = override !== null && shown.some((d) => d.id === override) ? override : pickFeatured(window, bots);
    lastDuels = { type: 'duels', block: block.toString(), duels: shown, featuredId };
    lastStats = statsMsg(block);
    ws.broadcast(lastDuels);
    ws.broadcast(lastStats);
  }

  async function pollOnce(block: bigint): Promise<void> {
    refreshTreasury();
    resyncDuelCount();
    const { from, count } = activeWindow(knownCount);
    let window: DuelView[];
    let sticky: Map<string, DuelView>;
    const subs = ws.subscribedIds?.() ?? NO_IDS;
    try {
      window = count === 0n ? [] : decodeDuels(await readDuels(from, count), from);
      sticky = await resolveSticky(new Map(window.map((d) => [d.id, d])), subs, Number(block));
    } catch (err) {
      logError('getDuels failed', err);
      lastStats = statsMsg(block); // keep screens' clocks moving; duels stay at the last good snapshot
      ws.broadcast(lastStats);
      return;
    }
    publish(window, sticky, from, block);
    broadcastSnapshot(window, sticky, subs, block);
    settleDue([...cache.values()], Number(block));
    await refreshMatches(block);
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
    if (Number(block) > latestSeen) latestSeen = Number(block);
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
        countAt = now();
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

  /** The last snapshot plus the phone's own duel when it is cached but was not part of that broadcast. */
  function replayFor(msg: DuelsMsg, duelId: string): DuelsMsg {
    const cached = cache.get(duelId);
    if (!cached || msg.duels.some((d) => d.id === duelId)) return msg;
    return { ...msg, duels: [...msg.duels, cached] };
  }

  /** Same idea for a match-scoped phone whose match has left the 64-window but is still cached. */
  function replayMatchFor(msg: MatchesMsg, matchId: string): MatchesMsg {
    const cached = matchCache.get(matchId);
    if (!cached || msg.matches.some((m) => m.id === matchId)) return msg;
    return { ...msg, matches: [...msg.matches, cached] };
  }

  // The hub's `send` applies the connection's scope filter, so a phone only sees its own duel/match.
  ws.onConnect((send, scope) => {
    if (lastDuels) send(scope !== 'all' && 'duelId' in scope ? replayFor(lastDuels, scope.duelId) : lastDuels);
    if (lastMatches) send(scope !== 'all' && 'matchId' in scope ? replayMatchFor(lastMatches, scope.matchId) : lastMatches);
    if (lastStats) send(lastStats);
    const agent = deps.getAgentMessage();
    if (agent) send(agent);
  });

  void init();

  return {
    getDuel: (id) => cache.get(id),
    createdBlock: (id) => created.get(id),
    duels: () => [...cache.values()].sort(byIdAscending),
    battleMatch: (id) => matchCache.get(id),
    battleMatches: () => [...matchCache.values()].sort(matchByIdAscending),
    latestBlock: () => snapshotBlock,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
    },
  };
}
