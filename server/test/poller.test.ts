import { DUEL_BLOCKS, blitzArenaAbi, type DuelView, type Hex } from '@nad/shared';
import { encodeAbiParameters, encodeEventTopics, type TransactionReceipt } from 'viem';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChainLike } from '../src/chainTypes';
import {
  SETTLE_RETRY_BLOCKS,
  TREASURY_REFRESH_MS,
  activeWindow,
  getFeatured,
  pickFeatured,
  selectSettleable,
  setFeatured,
  startPoller,
} from '../src/poller';
import type { ReceiptHub } from '../src/receiptHub';
import type { ConnectCallback, WsMessage } from '../src/ws';

// poller.ts only imports types from ws.ts; the mock keeps the integration test independent of the `ws` package.
vi.mock('ws', () => ({ WebSocketServer: class {} }));

const ARENA = '0x00000000000000000000000000000000000000a1' as Hex;
const CARDS = '0x00000000000000000000000000000000000000c1' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;
const BOT = addr(0xb0);
const AGENT = addr(0xa9);

const view = (over: Partial<DuelView> = {}): DuelView => ({
  id: '0', p1: addr(1), p2: addr(2), hp1: 100, hp2: 100, atk1: 10, atk2: 10, mult1: 1, mult2: 1,
  lastBlock1: 0, lastBlock2: 0, skill1: false, skill2: false, status: 'Active', startBlock: 100,
  endBlock: 167, card1: 1, card2: 2, maxHp1: 100, maxHp2: 100, settled: false, ...over,
});

describe('selectSettleable', () => {
  test('selects finished unsettled duels', () => {
    const duels = [view({ id: '0', status: 'P1Won' }), view({ id: '1', status: 'P2Won' }), view({ id: '2', status: 'Draw' })];
    expect(selectSettleable(duels, 120)).toEqual(['0', '1', '2']);
  });
  test('selects active duels past endBlock (covers server restart mid-duel)', () => {
    expect(selectSettleable([view({ status: 'Active', startBlock: 100, endBlock: 167 })], 167)).toEqual(['0']);
  });
  test('ignores active duels still running, open duels and already-settled duels', () => {
    const duels = [
      view({ id: '0', status: 'Active', endBlock: 167 }),
      view({ id: '1', status: 'Open', endBlock: 167 }),
      view({ id: '2', status: 'P1Won', settled: true }),
    ];
    expect(selectSettleable(duels, 166)).toEqual([]);
  });
});

describe('activeWindow', () => {
  test('covers the last 64 duels', () => expect(activeWindow(100n)).toEqual({ from: 36n, count: 64n }));
  test('starts at 0 when fewer than 64 duels exist', () => {
    expect(activeWindow(10n)).toEqual({ from: 0n, count: 10n });
    expect(activeWindow(0n)).toEqual({ from: 0n, count: 0n });
  });
  test('honours a custom size', () => expect(activeWindow(10n, 4)).toEqual({ from: 6n, count: 4n }));
});

describe('pickFeatured', () => {
  const bots = new Set<Hex>([BOT]);
  test('prefers the newest duel with no bot', () => {
    const duels = [
      view({ id: '3', p1: addr(1), p2: addr(2) }),
      view({ id: '9', p1: BOT, p2: addr(2) }),
      view({ id: '7', p1: addr(5), p2: ZERO, status: 'Open' }),
      view({ id: '8', p1: addr(5), p2: BOT }),
    ];
    expect(pickFeatured(duels, bots)).toBe('7');
  });
  test('compares ids numerically, not lexically', () => {
    expect(pickFeatured([view({ id: '9' }), view({ id: '10' })], bots)).toBe('10');
  });
  test('the AI Agent is not a bot, and bot comparison ignores case', () => {
    const mixed = new Set<Hex>([BOT.toLowerCase() as Hex]);
    const duels = [view({ id: '1', p1: AGENT, p2: addr(2) }), view({ id: '2', p1: BOT.toUpperCase().replace('0X', '0x') as Hex })];
    expect(pickFeatured(duels, mixed)).toBe('1');
  });
  test('returns null when every duel involves a bot or there are none', () => {
    expect(pickFeatured([view({ p1: BOT })], bots)).toBeNull();
    expect(pickFeatured([], bots)).toBeNull();
  });
});

describe('featured override', () => {
  afterEach(() => setFeatured(null));
  test('set and reset', () => {
    expect(getFeatured()).toBeNull();
    setFeatured('12');
    expect(getFeatured()).toBe('12');
    setFeatured(null);
    expect(getFeatured()).toBeNull();
  });
});

// ------------------------------------------------------------------ startPoller

type Raw = Record<string, unknown>;
const raw = (over: Partial<DuelView> = {}): Raw => {
  const v = view(over);
  const statusIndex = ['Open', 'Active', 'P1Won', 'P2Won', 'Draw'].indexOf(v.status);
  return { ...v, status: statusIndex, startBlock: BigInt(v.endBlock - DUEL_BLOCKS) };
};

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(opts: { duelCount?: bigint; table?: Raw[]; failCountReads?: number } = {}) {
  const state = {
    duelCount: opts.duelCount ?? 3n,
    table: opts.table ?? [raw({ id: '0' }), raw({ id: '1' }), raw({ id: '2' })],
    balance: 777n,
    clock: 0,
    getDuelsImpl: null as null | ((from: bigint, count: bigint) => Promise<Raw[]>),
    countFailures: opts.failCountReads ?? 0,
  };
  const getDuelsCalls: { from: bigint; count: bigint }[] = [];
  let running = 0;
  let maxRunning = 0;
  const client = {
    readContract: vi.fn(async (p: { functionName: string; args?: bigint[] }) => {
      if (p.functionName === 'duelCount') {
        if (state.countFailures > 0) {
          state.countFailures -= 1;
          throw new Error('rpc down');
        }
        return state.duelCount;
      }
      const [from, count] = p.args as [bigint, bigint];
      getDuelsCalls.push({ from, count });
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        if (state.getDuelsImpl) return await state.getDuelsImpl(from, count);
        return state.table.slice(Number(from), Number(from + count));
      } finally {
        running -= 1;
      }
    }),
    getBalance: vi.fn(async () => state.balance),
  };
  const chain = { client, call: <T>(fn: (c: unknown) => Promise<T>) => fn(client) } as unknown as ChainLike;

  const ingestListeners: ((block: bigint, receipts: TransactionReceipt[]) => void)[] = [];
  const hub = { onIngest: (cb: (typeof ingestListeners)[number]) => void ingestListeners.push(cb) } as unknown as ReceiptHub;
  const connectCbs: ConnectCallback[] = [];
  const sent: WsMessage[] = [];
  const ws = { broadcast: vi.fn((m: WsMessage) => void sent.push(m)), onConnect: (cb: ConnectCallback) => void connectCbs.push(cb) };
  const operator = { send: vi.fn(async () => '0xabc' as Hex) };
  const agentMsg = { current: null as WsMessage | null };
  const stats = { snapshot: vi.fn(() => ({ txTotal: 5, txPerSec: 1.5, avgLatencyMs: 40, lastTxHash: '0xdead' as Hex })) };

  const poller = startPoller({
    chain, hub, ws, stats, arena: ARENA, cards: CARDS, operator, settleGas: 100_000n,
    bots: () => [BOT], getAgentMessage: () => (agentMsg.current as never) ?? null, pollMs: 1, now: () => state.clock,
  });

  return {
    state, client, ws, sent, operator, poller, getDuelsCalls, agentMsg, stats, connectCbs,
    maxRunning: () => maxRunning,
    ingest: (block: number, receipts: TransactionReceipt[] = []) => ingestListeners.forEach((cb) => cb(BigInt(block), receipts)),
    types: (t: string) => sent.filter((m) => m.type === t),
  };
}

const duelCreatedReceipt = (id: bigint, block: bigint): TransactionReceipt => {
  const topics = encodeEventTopics({ abi: blitzArenaAbi, eventName: 'DuelCreated', args: { id, p1: addr(1) } });
  const data = encodeAbiParameters([{ type: 'uint256' }], [7n]);
  return {
    transactionHash: '0x01', blockNumber: block, status: 'success', to: ARENA,
    logs: [{ address: ARENA, topics, data }],
  } as unknown as TransactionReceipt;
};

const flush = async (h: Harness, polls: number) => vi.waitFor(() => expect(h.types('duels')).toHaveLength(polls));

describe('startPoller', () => {
  let h: Harness;
  beforeEach(() => setFeatured(null));
  afterEach(() => h?.poller.stop());

  test('reads duelCount once and polls the active window on a new block', async () => {
    h = makeHarness({ duelCount: 100n, table: Array.from({ length: 100 }, (_, i) => raw({ id: String(i) })) });
    h.ingest(500);
    await flush(h, 1);
    expect(h.client.readContract.mock.calls.filter(([p]) => p.functionName === 'duelCount')).toHaveLength(1);
    expect(h.getDuelsCalls).toEqual([{ from: 36n, count: 64n }]);
    const msg = h.types('duels')[0]!;
    expect(msg).toMatchObject({ type: 'duels', block: '500', featuredId: '99' });
    expect(h.poller.duels()).toHaveLength(64);
    expect(h.poller.getDuel('99')?.id).toBe('99');
    expect(h.poller.getDuel('0')).toBeUndefined();
  });

  test('retries duelCount with backoff until it succeeds', async () => {
    h = makeHarness({ failCountReads: 2 });
    h.ingest(10); // arrives while duelCount is still unknown: queued, not lost
    await flush(h, 1);
    expect(h.client.readContract.mock.calls.filter(([p]) => p.functionName === 'duelCount')).toHaveLength(3);
    expect(h.poller.latestBlock()).toBe(10);
  });

  test('broadcasts stats with zeroed leaderboard-derived fields and the last tx hash', async () => {
    h = makeHarness();
    h.ingest(500);
    await flush(h, 1);
    expect(h.types('stats')[0]).toEqual({
      type: 'stats', block: '500', txTotal: 5, txPerSec: 1.5, avgLatencyMs: 40, lastTxHash: '0xdead',
      uniquePlayers: 0, totalDuels: 0, treasury: '0',
    });
  });

  test('never sends a leaderboard message', async () => {
    h = makeHarness();
    h.ingest(500);
    await flush(h, 1);
    expect(h.sent.some((m) => m.type === 'leaderboard')).toBe(false);
  });

  test('admin featured override wins over the automatic pick', async () => {
    h = makeHarness();
    setFeatured('0');
    h.ingest(500);
    await flush(h, 1);
    expect(h.types('duels')[0]).toMatchObject({ featuredId: '0' });
    setFeatured(null);
    h.ingest(501);
    await flush(h, 2);
    expect(h.types('duels')[1]).toMatchObject({ featuredId: '2' });
  });

  test('bumps duelCount from DuelCreated logs so the next window includes the new duel', async () => {
    const table = [raw({ id: '0' }), raw({ id: '1' }), raw({ id: '2' }), raw({ id: '3' })];
    h = makeHarness({ duelCount: 3n, table });
    h.ingest(500);
    await flush(h, 1);
    expect(h.getDuelsCalls[0]).toEqual({ from: 0n, count: 3n });
    h.ingest(501, [duelCreatedReceipt(3n, 501n)]);
    await flush(h, 2);
    expect(h.getDuelsCalls[1]).toEqual({ from: 0n, count: 4n });
    expect(h.poller.getDuel('3')).toBeDefined();
  });

  test('a DuelCreated log for an id already counted does not double count', async () => {
    h = makeHarness({ duelCount: 4n, table: [0, 1, 2, 3].map((i) => raw({ id: String(i) })) });
    h.ingest(500, [duelCreatedReceipt(3n, 500n)]);
    await flush(h, 1);
    expect(h.getDuelsCalls[0]).toEqual({ from: 0n, count: 4n });
  });

  test('ignores DuelCreated logs emitted by other contracts', async () => {
    h = makeHarness({ duelCount: 3n });
    const r = duelCreatedReceipt(50n, 500n);
    (r.logs[0] as { address: Hex }).address = addr(0xee);
    h.ingest(500, [r]);
    await flush(h, 1);
    expect(h.getDuelsCalls[0]).toEqual({ from: 0n, count: 3n });
    expect(h.poller.createdBlock('50')).toBeUndefined();
  });

  test('createdBlock records the block of the DuelCreated log, undefined for older duels', async () => {
    h = makeHarness({ duelCount: 3n, table: [0, 1, 2, 3].map((i) => raw({ id: String(i) })) });
    h.ingest(777, [duelCreatedReceipt(3n, 776n)]);
    await flush(h, 1);
    expect(h.poller.createdBlock('3')).toBe(776);
    expect(h.poller.createdBlock('1')).toBeUndefined();
  });

  test('latestBlock advances only together with a successful snapshot', async () => {
    h = makeHarness();
    expect(h.poller.latestBlock()).toBe(0);
    h.ingest(500);
    await flush(h, 1);
    expect(h.poller.latestBlock()).toBe(500);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = h.state.table;
    h.state.getDuelsImpl = async () => {
      throw new Error('rpc timeout');
    };
    h.ingest(501);
    await vi.waitFor(() => expect(h.getDuelsCalls).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.poller.latestBlock()).toBe(500);
    expect(h.types('duels')).toHaveLength(1); // no stale-as-new broadcast

    h.state.getDuelsImpl = null;
    h.state.table = original;
    h.ingest(502);
    await flush(h, 2);
    expect(h.poller.latestBlock()).toBe(502);
  });

  test('latestBlock is not published while the read is still in flight', async () => {
    h = makeHarness();
    let release!: () => void;
    h.state.getDuelsImpl = () => new Promise((resolve) => { release = () => resolve(h.state.table); });
    h.ingest(500);
    await vi.waitFor(() => expect(h.getDuelsCalls).toHaveLength(1));
    expect(h.poller.latestBlock()).toBe(0);
    expect(h.poller.duels()).toEqual([]);
    release();
    await flush(h, 1);
    expect(h.poller.latestBlock()).toBe(500);
  });

  test('overlapping block triggers coalesce: never concurrent, one extra poll for the newest block', async () => {
    h = makeHarness();
    const releases: (() => void)[] = [];
    h.state.getDuelsImpl = () => new Promise((resolve) => releases.push(() => resolve(h.state.table)));
    h.ingest(501);
    await vi.waitFor(() => expect(h.getDuelsCalls).toHaveLength(1));
    h.ingest(502);
    h.ingest(503);
    h.ingest(504);
    releases[0]!();
    await vi.waitFor(() => expect(h.getDuelsCalls).toHaveLength(2));
    releases[1]!();
    await flush(h, 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.getDuelsCalls).toHaveLength(2);
    expect(h.maxRunning()).toBe(1);
    expect(h.types('duels').map((m) => (m as { block: string }).block)).toEqual(['501', '504']);
  });

  test('treasury is refreshed at most every TREASURY_REFRESH_MS and the last value is kept', async () => {
    h = makeHarness();
    h.ingest(500);
    await flush(h, 1);
    await vi.waitFor(() => expect(h.client.getBalance).toHaveBeenCalledTimes(1));
    expect(h.client.getBalance).toHaveBeenCalledWith({ address: CARDS });
    h.state.clock = TREASURY_REFRESH_MS - 1;
    h.ingest(501);
    await flush(h, 2);
    expect(h.client.getBalance).toHaveBeenCalledTimes(1);
    expect(h.types('stats')[1]).toMatchObject({ treasury: '777' });
    h.state.balance = 999n;
    h.state.clock = TREASURY_REFRESH_MS;
    h.ingest(502);
    await flush(h, 3);
    await vi.waitFor(() => expect(h.client.getBalance).toHaveBeenCalledTimes(2));
    h.ingest(503);
    await flush(h, 4);
    expect(h.types('stats')[3]).toMatchObject({ treasury: '999' });
  });

  test('a failing treasury read keeps the last value and does not stop polling', async () => {
    h = makeHarness();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.client.getBalance.mockRejectedValue(new Error('boom'));
    h.ingest(500);
    await flush(h, 1);
    h.state.clock = TREASURY_REFRESH_MS;
    h.ingest(501);
    await flush(h, 2);
    expect(h.types('stats')[1]).toMatchObject({ treasury: '0' });
  });
});

describe('auto-settle', () => {
  let h: Harness;
  afterEach(() => h?.poller.stop());
  const running = (id: string): Raw => raw({ id, endBlock: 99_999 });
  const finished = (): Raw[] => [raw({ id: '0', status: 'P1Won' }), running('1')];

  test('sends settle(id) once per id despite repeated polls', async () => {
    h = makeHarness({ duelCount: 2n, table: finished() });
    h.ingest(500);
    await flush(h, 1);
    h.ingest(501);
    await flush(h, 2);
    h.ingest(502);
    await flush(h, 3);
    expect(h.operator.send).toHaveBeenCalledTimes(1);
    const req = (h.operator.send.mock.calls[0] as unknown as [{ to: Hex; data: Hex; gas: bigint }])[0];
    expect(req.to).toBe(ARENA);
    expect(req.gas).toBe(100_000n);
    expect(req.data.startsWith('0x')).toBe(true);
    expect(req.data.endsWith('0'.repeat(63) + '0')).toBe(true); // settle(0)
  });

  test('settles active duels past endBlock but not running ones', async () => {
    h = makeHarness({ duelCount: 2n, table: [raw({ id: '0', endBlock: 167 }), raw({ id: '1', endBlock: 400 })] });
    h.ingest(170);
    await flush(h, 1);
    expect(h.operator.send).toHaveBeenCalledTimes(1);
  });

  test('retries after SETTLE_RETRY_BLOCKS when the duel is still unsettled', async () => {
    h = makeHarness({ duelCount: 2n, table: finished() });
    h.ingest(500);
    await flush(h, 1);
    h.ingest(500 + SETTLE_RETRY_BLOCKS - 1);
    await flush(h, 2);
    expect(h.operator.send).toHaveBeenCalledTimes(1);
    h.ingest(500 + SETTLE_RETRY_BLOCKS);
    await flush(h, 3);
    expect(h.operator.send).toHaveBeenCalledTimes(2);
  });

  test('a settled duel is dropped from the in-flight set', async () => {
    h = makeHarness({ duelCount: 2n, table: finished() });
    h.ingest(500);
    await flush(h, 1);
    h.state.table = [raw({ id: '0', status: 'P1Won', settled: true }), running('1')];
    h.ingest(501);
    await flush(h, 2);
    expect(h.operator.send).toHaveBeenCalledTimes(1);
    h.state.table = finished(); // (hypothetical regression) shows unsettled again: allowed to send again
    h.ingest(502);
    await flush(h, 3);
    expect(h.operator.send).toHaveBeenCalledTimes(2);
  });

  test('a failed send is logged once per id and retried after the retry window', async () => {
    h = makeHarness({ duelCount: 2n, table: finished() });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.operator.send.mockRejectedValue(new Error('nonce too low'));
    h.ingest(500);
    await flush(h, 1);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    h.ingest(500 + SETTLE_RETRY_BLOCKS);
    await flush(h, 2);
    await vi.waitFor(() => expect(h.operator.send).toHaveBeenCalledTimes(2));
    expect(errors.mock.calls.filter(([m]) => String(m).includes('settle'))).toHaveLength(1);
  });
});

describe('snapshot on connect', () => {
  let h: Harness;
  afterEach(() => h?.poller.stop());

  test('sends last duels + stats + agent and never a leaderboard', async () => {
    h = makeHarness();
    h.agentMsg.current = { type: 'agent', level: 2, threshold: 5, finisher: false, sim: { duels: 1, wins: 1 }, testnet: { duels: 0, wins: 0 }, lessons: [] };
    h.ingest(500);
    await flush(h, 1);
    const out: WsMessage[] = [];
    h.connectCbs[0]!((m) => void out.push(m), 'all');
    expect(out.map((m) => m.type)).toEqual(['duels', 'stats', 'agent']);
    expect((out[0] as { duels: unknown[] }).duels).toHaveLength(3);
  });

  test('before the first poll only the agent snapshot is available; null agent is skipped', async () => {
    h = makeHarness();
    const out: WsMessage[] = [];
    h.connectCbs[0]!((m) => void out.push(m), 'all');
    expect(out).toEqual([]);
    h.agentMsg.current = { type: 'agent', level: 1, threshold: 1, finisher: false, sim: { duels: 0, wins: 0 }, testnet: { duels: 0, wins: 0 }, lessons: [] };
    h.connectCbs[0]!((m) => void out.push(m), 'all');
    expect(out.map((m) => m.type)).toEqual(['agent']);
  });

  test('goes through the hub filter, so a phone gets only its own duel', async () => {
    const { createWsHubCore } = await import('../src/ws');
    h = makeHarness();
    const core = createWsHubCore();
    core.onConnect(h.connectCbs[0]!);
    h.ingest(500);
    await flush(h, 1);
    const sent: string[] = [];
    core.add({ send: (d) => void sent.push(d), readyState: 1 }, { duelId: '1' });
    const parsed = sent.map((s) => JSON.parse(s) as WsMessage);
    expect(parsed.map((m) => m.type)).toEqual(['duels', 'stats']);
    expect((parsed[0] as { duels: { id: string }[] }).duels.map((d) => d.id)).toEqual(['1']);
  });
});
