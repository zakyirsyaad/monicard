import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blitzArenaAbi, type DuelView, type Hex } from '@nad/shared';
import { decodeFunctionData, type PublicClient, type TransactionReceipt } from 'viem';
import { describe, expect, test, vi } from 'vitest';
import { createAgentRunner, type AgentRunnerDeps } from '../src/agent/runner';
import { agentMessage, createAgentStore } from '../src/agent/store';
import type { AgentMsg } from '../src/ws';

const T0 = 1_700_000_000_000;

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;
const AGENT = addr(0xa1);
const PLAYER = addr(0xb2);
const OTHER = addr(0xc3);
const ZERO = addr(0);
const ARENA = addr(0xaa);
const CARDS = addr(0xcc);

const RECEIPT = {
  status: 'success',
  blockNumber: 1n,
  transactionHash: `0x${'11'.repeat(32)}`,
  logs: [],
} as unknown as TransactionReceipt;
const REVERTED = { ...RECEIPT, status: 'reverted' } as unknown as TransactionReceipt;

const openDuel = (over: Partial<DuelView> = {}): DuelView => ({
  id: '1',
  p1: PLAYER,
  p2: ZERO,
  hp1: 1500,
  hp2: 1500,
  atk1: 12,
  atk2: 12,
  mult1: 100,
  mult2: 100,
  lastBlock1: 0,
  lastBlock2: 0,
  skill1: false,
  skill2: false,
  status: 'Open',
  startBlock: 0,
  endBlock: 67,
  card1: 3,
  card2: 0,
  maxHp1: 1500,
  maxHp2: 1500,
  settled: false,
  ...over,
});

/** A duel the fake poller shows once the agent's join tx is sent: p1 is already at 0 HP. */
const endedDuel = (over: Partial<DuelView> = {}): DuelView =>
  openDuel({
    status: 'P2Won',
    p2: AGENT,
    hp1: 0,
    hp2: 1500,
    card2: 7,
    startBlock: 110,
    endBlock: 177,
    lastBlock1: 150,
    lastBlock2: 150,
    ...over,
  });

type SendRequest = { to: Hex; data: Hex; gas: bigint; value?: bigint };
type ReadArgs = { address: Hex; functionName: string; args?: readonly unknown[] };

const isJoin = (data: Hex): boolean => {
  try {
    return decodeFunctionData({ abi: blitzArenaAbi, data }).functionName === 'joinDuel';
  } catch {
    return false;
  }
};

const defaultRead = async ({ functionName, args }: ReadArgs): Promise<unknown> => {
  if (functionName === 'cardOf') return 7n;
  if (functionName === 'ownerOf') return AGENT;
  if (functionName === 'cards') return { element: Number(args?.[0]) === 3 ? 0 : 1 };
  if (functionName === 'getDuels') return [];
  throw new Error(`unexpected read ${functionName}`);
};

type HarnessOptions = {
  duel?: DuelView;
  created?: number;
  block?: number;
  latestBlock?: () => number;
  readContract?: (args: ReadArgs) => Promise<unknown>;
  hubWait?: (hash: Hex, timeoutMs: number) => Promise<TransactionReceipt>;
  onSend?: (req: SendRequest) => void;
  broadcast?: (msg: AgentMsg) => void;
  rng?: () => number;
  log?: (msg: string, err?: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  store?: ReturnType<typeof createAgentStore>;
};

function makeHarness(opts: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-'));
  const store = opts.store ?? createAgentStore(dir);
  const state: { view: DuelView | undefined; created: number | undefined } = {
    view: opts.duel,
    created: opts.created,
  };
  const pollerState = { block: opts.block ?? 100 };
  const poller = {
    getDuel: (id: string) => (state.view?.id === id ? state.view : undefined),
    createdBlock: (id: string) => (state.view?.id === id ? state.created : undefined),
    latestBlock: opts.latestBlock ?? (() => pollerState.block),
  };

  const sent: SendRequest[] = [];
  const queue = {
    address: AGENT,
    send: vi.fn(async (req: SendRequest) => {
      sent.push(req);
      opts.onSend?.(req);
      return `0x${'22'.repeat(32)}` as Hex;
    }),
  };
  const hub = { wait: vi.fn(opts.hubWait ?? (async () => RECEIPT)) };
  const readContract = vi.fn(opts.readContract ?? defaultRead);
  const client = { readContract } as unknown as PublicClient;
  const chain = {
    client,
    call: <T>(fn: (c: PublicClient) => Promise<T>): Promise<T> => fn(client),
  };

  const logs: { msg: string; err?: unknown }[] = [];
  const log = opts.log ?? ((msg: string, err?: unknown) => void logs.push({ msg, err }));
  const broadcast = vi.fn(opts.broadcast ?? (() => {}));
  const deps: AgentRunnerDeps = {
    queue,
    hub,
    chain,
    poller,
    store,
    broadcast,
    contracts: { cards: CARDS, arena: ARENA },
    gasLimits: { joinDuel: 200_000, attack: 70_000 },
    rng: opts.rng ?? (() => 0.9),
    now: () => T0,
    sleep: opts.sleep ?? (async () => {}),
    log,
  };
  return {
    runner: createAgentRunner(deps),
    store,
    dir,
    state,
    pollerState,
    sent,
    hub,
    queue,
    broadcast,
    logs,
    readContract,
  };
}

async function waitIdle(runner: { busy(): boolean }, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (runner.busy()) {
    if (Date.now() > deadline) throw new Error('runner stayed busy');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** End the duel as soon as the join tx goes out, so the background loop finishes at once. */
const finishOnJoin = (h: ReturnType<typeof makeHarness>) => (req: SendRequest): void => {
  if (isJoin(req.data)) h.state.view = endedDuel();
};

describe('createAgentRunner challenge guards', () => {
  test('rejects a second challenge while one is being processed', async () => {
    let finishJoin: (receipt: TransactionReceipt) => void = () => {};
    const join = new Promise<TransactionReceipt>((resolve) => {
      finishJoin = resolve;
    });
    const h = makeHarness({ duel: openDuel(), created: 90, block: 100, hubWait: () => join });

    const first = h.runner.challenge(1n);
    const second = await h.runner.challenge(2n);
    expect(second).toBe('busy');

    finishJoin(REVERTED);
    expect(await first).toBe('not_open');
    expect(h.runner.busy()).toBe(false);
  });

  test('not_open when the duel is not Open', async () => {
    const h = makeHarness({ duel: openDuel({ status: 'Active' }), created: 90, block: 100 });
    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(0);
    expect(h.runner.busy()).toBe(false);
  });

  test('not_open for a duel the agent itself created (case-insensitive p1)', async () => {
    const h = makeHarness({ duel: openDuel({ p1: '0x00000000000000000000000000000000000000A1' }), created: 90, block: 100 });
    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(0);
    expect(h.runner.busy()).toBe(false);
  });

  test('not_open and releases busy when the join transaction reverts', async () => {
    const h = makeHarness({ duel: openDuel(), created: 90, block: 100, hubWait: async () => REVERTED });
    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.runner.busy()).toBe(false);
    expect(h.logs.some((l) => l.msg.includes('join'))).toBe(true);
  });

  test('stale when the duel was created more than 200 blocks ago', async () => {
    const h = makeHarness({ duel: openDuel(), created: 100, block: 301 });
    expect(await h.runner.challenge(1n)).toBe('stale');
    expect(h.sent).toHaveLength(0);
  });

  test('not stale at exactly 200 blocks', async () => {
    const h = makeHarness({ duel: openDuel(), created: 100, block: 300, hubWait: async () => REVERTED });
    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(1);
  });

  test('reserved while another p1 holds the reservation, and case-insensitive when it matches', async () => {
    const h = makeHarness({ duel: openDuel(), created: 90, block: 100, hubWait: async () => REVERTED });
    h.runner.reserveFor(OTHER);
    expect(await h.runner.challenge(1n)).toBe('reserved');
    expect(h.sent).toHaveLength(0);

    h.runner.reserveFor('0x00000000000000000000000000000000000000B2');
    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(1);

    h.runner.reserveFor(null);
    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(2);
  });

  test('not_open when the agent wallet has no card', async () => {
    const h = makeHarness({
      duel: openDuel(),
      created: 90,
      block: 100,
      readContract: async ({ functionName }) => {
        if (functionName === 'cardOf') return 0n;
        return defaultRead({ address: CARDS, functionName });
      },
    });
    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(0);
    expect(h.logs.some((l) => l.msg.includes('no card'))).toBe(true);
    expect(h.runner.busy()).toBe(false);
  });

  test('does not cache a zero card, so the next challenge can join', async () => {
    let card = 0n;
    const h = makeHarness({
      duel: openDuel(),
      created: 90,
      block: 100,
      readContract: async ({ functionName, args }) => {
        if (functionName === 'cardOf') return card;
        return defaultRead({ address: CARDS, functionName, args });
      },
      onSend: (req) => finishOnJoin(h)(req),
    });

    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(0);

    card = 7n;
    expect(await h.runner.challenge(1n)).toBe('ok');
    await waitIdle(h.runner);

    expect(h.sent).toHaveLength(1);
    expect(decodeFunctionData({ abi: blitzArenaAbi, data: h.sent[0]!.data }).args).toEqual([1n, 7n]);
  });

  test('rejects a card the wallet no longer owns, then retries with the current card', async () => {
    let card = 5n;
    let owner: Hex = OTHER;
    const h = makeHarness({
      duel: openDuel(),
      created: 90,
      block: 100,
      readContract: async ({ functionName, args }) => {
        if (functionName === 'cardOf') return card;
        if (functionName === 'ownerOf') return owner;
        return defaultRead({ address: CARDS, functionName, args });
      },
      onSend: (req) => finishOnJoin(h)(req),
    });

    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.msg).toMatch(/card 5\b/);
    expect(h.logs[0]?.msg).toMatch(/duel 1\b/);

    card = 6n;
    owner = AGENT;
    expect(await h.runner.challenge(1n)).toBe('ok');
    await waitIdle(h.runner);

    expect(h.sent).toHaveLength(1);
    expect(decodeFunctionData({ abi: blitzArenaAbi, data: h.sent[0]!.data }).args).toEqual([1n, 6n]);
  });

  test('not_open when ownerOf throws for the cached card, and forgets it', async () => {
    let card = 7n;
    let burned = true;
    const h = makeHarness({
      duel: openDuel(),
      created: 90,
      block: 100,
      hubWait: async () => REVERTED,
      readContract: async ({ functionName, args }) => {
        if (functionName === 'cardOf') return card;
        if (functionName === 'ownerOf') {
          if (burned) throw new Error('ERC721: invalid token ID');
          return AGENT;
        }
        return defaultRead({ address: CARDS, functionName, args });
      },
    });

    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.msg).toMatch(/card 7\b/);
    expect(h.logs[0]?.msg).toMatch(/duel 1\b/);

    card = 8n;
    burned = false;
    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(1);
    expect(decodeFunctionData({ abi: blitzArenaAbi, data: h.sent[0]!.data }).args).toEqual([1n, 8n]);
  });

  test('clears the cached card after a failed join and joins with the next one', async () => {
    let card = 7n;
    let joins = 0;
    let reverted = true;
    const h = makeHarness({
      duel: openDuel(),
      created: 90,
      block: 100,
      hubWait: async () => (reverted ? REVERTED : RECEIPT),
      readContract: async ({ functionName, args }) => {
        if (functionName === 'cardOf') return card;
        return defaultRead({ address: CARDS, functionName, args });
      },
      onSend: (req) => {
        if (!isJoin(req.data)) return;
        joins += 1;
        if (joins === 2) h.state.view = endedDuel();
      },
    });

    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(h.sent).toHaveLength(1);

    card = 9n;
    reverted = false;
    expect(await h.runner.challenge(1n)).toBe('ok');
    await waitIdle(h.runner);

    expect(h.sent).toHaveLength(2);
    expect(decodeFunctionData({ abi: blitzArenaAbi, data: h.sent[1]!.data }).args).toEqual([1n, 9n]);
  });
});

describe('createAgentRunner chain fallback', () => {
  test('reads the duel from the chain and waits up to three blocks for it to appear', async () => {
    let head = 100;
    let reads = 0;
    const rawOpen = {
      p1: PLAYER,
      p2: ZERO,
      hp1: 1500,
      hp2: 1500,
      atk1: 12,
      atk2: 12,
      mult1: 100,
      mult2: 100,
      lastBlock1: 0,
      lastBlock2: 0,
      skill1: false,
      skill2: false,
      status: 0,
      startBlock: 0,
      card1: 3,
      card2: 0,
      maxHp1: 1500,
      maxHp2: 1500,
      settled: false,
    };

    const h = makeHarness({
      duel: undefined,
      latestBlock: () => {
        head += 1;
        return head;
      },
      readContract: async ({ functionName, args }) => {
        if (functionName === 'getDuels') {
          reads += 1;
          return head >= 103 ? [rawOpen] : [];
        }
        return defaultRead({ address: CARDS, functionName, args });
      },
      onSend: (req) => finishOnJoin(h)(req),
    });

    expect(await h.runner.challenge(1n)).toBe('ok');
    await waitIdle(h.runner);

    const joins = h.sent.filter((r) => isJoin(r.data));
    expect(joins).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: blitzArenaAbi, data: joins[0]!.data });
    expect(decoded.functionName).toBe('joinDuel');
    expect(decoded.args).toEqual([1n, 7n]);
    expect(joins[0]!.to).toBe(ARENA);
    expect(joins[0]!.gas).toBe(200_000n);
    expect(reads).toBe(3);
  });

  test('answers not_open once the head has advanced three blocks without the duel', async () => {
    let head = 100;
    let reads = 0;
    const h = makeHarness({
      duel: undefined,
      latestBlock: () => {
        head += 1;
        return head;
      },
      readContract: async ({ functionName }) => {
        if (functionName === 'getDuels') {
          reads += 1;
          return [];
        }
        throw new Error(`unexpected read ${functionName}`);
      },
    });

    expect(await h.runner.challenge(1n)).toBe('not_open');
    expect(reads).toBe(3);
    expect(h.sent).toHaveLength(0);
    expect(h.runner.busy()).toBe(false);
  });
});

describe('createAgentRunner background duel', () => {
  test('coaches, updates the store, broadcasts and releases busy when the policy was followed', async () => {
    const h = makeHarness({
      duel: openDuel(),
      created: 90,
      block: 100,
      rng: () => 0.9,
      onSend: (req) => finishOnJoin(h)(req),
    });

    expect(await h.runner.challenge(1n)).toBe('ok');
    await waitIdle(h.runner);

    const data = h.store.get();
    expect(data.testnet).toEqual({ duels: 1, wins: 1 });
    expect(data.sim).toEqual({ duels: 0, wins: 0 });
    expect(data.opponents[PLAYER]).toEqual({ lastResult: 'win', skillHpPct: null });
    expect(data.lessons).toHaveLength(1);
    expect(data.lessons[0]?.duelId).toBe('1');
    expect(data.lessons[0]?.at).toBe(T0);
    expect(data.lessons[0]?.thresholdFrom).toBe(30);
    expect(data.lessons[0]?.thresholdTo).toBe(33);
    expect(data.policy.skillHpThreshold).toBe(33);

    expect(h.broadcast).toHaveBeenCalledTimes(1);
    const message = h.broadcast.mock.calls[0]?.[0] as AgentMsg;
    expect(message).toEqual(agentMessage(data));
    expect(message.level).toBe(1);
    expect(h.runner.busy()).toBe(false);
  });

  test('does not coach when the policy was ignored, but still updates and broadcasts', async () => {
    const h = makeHarness({
      duel: openDuel(),
      created: 90,
      block: 100,
      rng: () => 0.1,
      onSend: (req) => finishOnJoin(h)(req),
    });

    expect(await h.runner.challenge(1n)).toBe('ok');
    await waitIdle(h.runner);

    const data = h.store.get();
    expect(data.testnet).toEqual({ duels: 1, wins: 1 });
    expect(data.lessons).toHaveLength(0);
    expect(data.policy.skillHpThreshold).toBe(30);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.runner.busy()).toBe(false);
  });

  test('releases busy and logs when the background duel throws', async () => {
    const h = makeHarness({
      duel: openDuel(),
      created: 90,
      block: 100,
      rng: () => 0.9,
      broadcast: () => {
        throw new Error('ws down');
      },
      onSend: (req) => finishOnJoin(h)(req),
    });

    expect(await h.runner.challenge(1n)).toBe('ok');
    await waitIdle(h.runner);

    expect(h.runner.busy()).toBe(false);
    expect(h.logs.some((l) => l.msg.includes('duel 1'))).toBe(true);
  });
});
