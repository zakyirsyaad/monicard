import { DUEL_BLOCKS, blitzArenaAbi, type DuelView, type Hex } from '@nad/shared';
import { encodeAbiParameters, encodeEventTopics, type TransactionReceipt } from 'viem';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChainLike } from '../src/chainTypes';
import {
  DUEL_COUNT_RESYNC_MS,
  MAX_SETTLES_IN_FLIGHT,
  MAX_SETTLE_ATTEMPTS,
  MAX_UNSETTLED_STICKY,
  SETTLE_COOLOFF_BLOCKS,
  SETTLE_RETRY_BLOCKS,
  STICKY_READS_PER_POLL,
  TREASURY_REFRESH_MS,
  activeWindow,
  getFeatured,
  pickFeatured,
  selectSettleable,
  setFeatured,
  startPoller,
} from '../src/poller';
import type { ReceiptHub } from '../src/receiptHub';
import type { ConnectCallback, DuelsMsg, WsMessage } from '../src/ws';

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
  test('prefers the newest Active duel with no bot', () => {
    const duels = [
      view({ id: '3', p1: addr(1), p2: addr(2) }),
      view({ id: '9', p1: BOT, p2: addr(2) }),
      view({ id: '7', p1: addr(5), p2: ZERO, status: 'Open' }),
      view({ id: '8', p1: addr(5), p2: BOT }),
      view({ id: '6', status: 'P1Won' }),
    ];
    expect(pickFeatured(duels, bots)).toBe('3');
  });
  test('falls back to the newest non-bot duel of any status when none is Active', () => {
    const duels = [
      view({ id: '3', status: 'P2Won' }),
      view({ id: '7', p1: addr(5), p2: ZERO, status: 'Open' }),
      view({ id: '9', p1: BOT, status: 'Active' }),
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
  const subs = new Set<string>();
  const ws = {
    broadcast: vi.fn((m: WsMessage) => void sent.push(m)),
    onConnect: (cb: ConnectCallback) => void connectCbs.push(cb),
    subscribedIds: () => subs,
  };
  const operator = { send: vi.fn(async () => '0xabc' as Hex) };
  const agentMsg = { current: null as WsMessage | null };
  const stats = { snapshot: vi.fn(() => ({ txTotal: 5, txPerSec: 1.5, avgLatencyMs: 40, lastTxHash: '0xdead' as Hex })) };

  const poller = startPoller({
    chain, hub, ws, stats, arena: ARENA, cards: CARDS, operator, settleGas: 100_000n,
    bots: () => [BOT], getAgentMessage: () => (agentMsg.current as never) ?? null, pollMs: 1, now: () => state.clock,
  });

  return {
    state, client, ws, sent, subs, operator, poller, getDuelsCalls, agentMsg, stats, connectCbs,
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

  test('broadcasts stats with zeroed leaderboard-derived fields, the treasury and the last tx hash', async () => {
    h = makeHarness();
    h.ingest(500);
    await flush(h, 1);
    expect(h.types('stats')[0]).toEqual({
      type: 'stats', block: '500', txTotal: 5, txPerSec: 1.5, avgLatencyMs: 40, lastTxHash: '0xdead',
      uniquePlayers: 0, totalDuels: 0, treasury: '777',
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

  test('an admin-featured id that is not in the snapshot falls back to the automatic pick', async () => {
    h = makeHarness();
    setFeatured('999');
    h.ingest(500);
    await flush(h, 1);
    expect(h.types('duels')[0]).toMatchObject({ featuredId: '2' });
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

// ------------------------------------------------------------------ fix round 1

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const bigTable = (n: number, over: (i: number) => Partial<DuelView> = () => ({})): Raw[] =>
  Array.from({ length: n }, (_, i) => raw({ id: String(i), endBlock: 99_999, ...over(i) }));
const settleCalls = (h: Harness) => h.operator.send.mock.calls as unknown as [{ data: Hex }][];
const singleReads = (h: Harness) => h.getDuelsCalls.filter((c) => c.count === 1n).map((c) => Number(c.from));
const idsOf = (m: WsMessage | undefined) => (m as DuelsMsg).duels.map((d) => d.id);

describe('sticky duels (subscribed duels that leave the 64-window)', () => {
  let h: Harness;
  afterEach(() => h?.poller.stop());

  /** 60 duels exist (window 0..59), then 10 more are created: duels 0..5 leave the window. */
  async function evictFromWindow(table: Raw[]): Promise<void> {
    h = makeHarness({ duelCount: 60n, table });
    h.subs.add('5');
    h.ingest(500);
    await flush(h, 1);
    h.ingest(501, [duelCreatedReceipt(69n, 501n)]);
    await flush(h, 2);
  }

  test('an unsettled subscribed duel keeps being sent and re-read after it leaves the window', async () => {
    await evictFromWindow(bigTable(70, (i) => (i === 5 ? { status: 'Open', p2: ZERO } : {})));
    expect(h.getDuelsCalls.at(-1)).toEqual({ from: 5n, count: 1n } satisfies { from: bigint; count: bigint });
    const second = h.types('duels')[1]!;
    expect(idsOf(second)).toContain('5');
    expect(idsOf(second)).toHaveLength(65); // 64 window duels + the sticky one
    expect(h.poller.getDuel('5')?.status).toBe('Open');
    h.state.table = bigTable(70, (i) => (i === 5 ? { status: 'Active' } : {}));
    h.ingest(502);
    await flush(h, 3);
    expect(h.poller.getDuel('5')?.status).toBe('Active');
    expect(singleReads(h)).toEqual([5, 5]);
  });

  test('a settled subscribed duel is reused without any RPC', async () => {
    await evictFromWindow(bigTable(70, (i) => (i === 5 ? { status: 'P1Won', settled: true } : {})));
    h.ingest(502);
    await flush(h, 3);
    expect(singleReads(h)).toEqual([]);
    expect(idsOf(h.types('duels')[2])).toContain('5');
    expect(h.poller.getDuel('5')?.settled).toBe(true);
  });

  test('is dropped once settled and no longer subscribed', async () => {
    await evictFromWindow(bigTable(70, (i) => (i === 5 ? { status: 'P1Won', settled: true } : {})));
    h.subs.delete('5');
    h.ingest(502);
    await flush(h, 3);
    expect(h.poller.getDuel('5')).toBeUndefined();
    expect(idsOf(h.types('duels')[2])).not.toContain('5');
  });

  test('an unsubscribed Open duel outside the window is dropped (nothing to settle)', async () => {
    await evictFromWindow(bigTable(70, (i) => (i === 5 ? { status: 'Open', p2: ZERO } : {})));
    h.subs.delete('5');
    h.ingest(502);
    await flush(h, 3);
    expect(h.poller.getDuel('5')).toBeUndefined();
  });

  test('a subscribed duel never seen in the window is fetched with getDuels(id, 1)', async () => {
    h = makeHarness({ duelCount: 100n, table: bigTable(100) });
    h.subs.add('10');
    h.ingest(500);
    await flush(h, 1);
    expect(idsOf(h.types('duels')[0])).toContain('10');
    expect(singleReads(h)).toEqual([10]);
  });

  test('a subscription to a duel that does not exist yet or is not numeric costs no RPC', async () => {
    h = makeHarness({ duelCount: 100n, table: bigTable(100) });
    h.subs.add('5000');
    h.subs.add('abc');
    h.ingest(500);
    await flush(h, 1);
    expect(singleReads(h)).toEqual([]);
  });

  test('re-reads are capped per poll and the newest ids win', async () => {
    h = makeHarness({ duelCount: 100n, table: bigTable(100) });
    for (let i = 0; i < 12; i++) h.subs.add(String(i));
    h.ingest(500);
    await flush(h, 1);
    expect(STICKY_READS_PER_POLL).toBe(8);
    expect(singleReads(h).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('an unsubscribed duel that finishes outside the window is still settled', async () => {
    h = makeHarness({ duelCount: 60n, table: bigTable(70, (i) => (i === 5 ? { endBlock: 600 } : {})) });
    h.ingest(500);
    await flush(h, 1);
    expect(h.operator.send).not.toHaveBeenCalled();
    h.ingest(520, [duelCreatedReceipt(69n, 520n)]); // duel 5 leaves the window while still running
    await flush(h, 2);
    expect(singleReads(h)).toEqual([]); // running, unsubscribed: no RPC
    h.state.table = bigTable(70, (i) => (i === 5 ? { endBlock: 600, status: 'P1Won' } : {}));
    h.ingest(601);
    await flush(h, 3);
    await vi.waitFor(() => expect(h.operator.send).toHaveBeenCalledTimes(1));
    expect(settleCalls(h)[0]![0].data.endsWith('5'.padStart(64, '0'))).toBe(true);
    expect(singleReads(h)).toEqual([5]); // past endBlock: re-read to learn when settle lands
    expect(h.poller.getDuel('5')?.status).toBe('P1Won');
    expect(idsOf(h.types('duels')[2])).not.toContain('5'); // cached, but not broadcast (nobody subscribed)
  });

  test('scoped sockets still receive the sticky duel through the hub filter', async () => {
    const { createWsHubCore } = await import('../src/ws');
    await evictFromWindow(bigTable(70, (i) => (i === 5 ? { status: 'Open', p2: ZERO } : {})));
    const core = createWsHubCore();
    core.onConnect(h.connectCbs[0]!);
    const out: string[] = [];
    core.add({ send: (d) => void out.push(d), readyState: 1 }, { duelId: '5' });
    const duels = (JSON.parse(out[0]!) as DuelsMsg).duels;
    expect(duels.map((d) => d.id)).toEqual(['5']);
  });
});

describe('settle in flight, backoff and caps', () => {
  let h: Harness;
  afterEach(() => h?.poller.stop());
  const one = (): Raw[] => [raw({ id: '0', status: 'P1Won' })];

  test('stays in flight while operator.send is pending, then waits SETTLE_RETRY_BLOCKS from resolution', async () => {
    h = makeHarness({ duelCount: 1n, table: one() });
    const resolvers: (() => void)[] = [];
    h.operator.send.mockImplementation(() => new Promise<Hex>((res) => resolvers.push(() => res('0x1' as Hex))));
    h.ingest(500);
    await flush(h, 1);
    for (const [i, block] of [520, 600, 900].entries()) {
      h.ingest(block);
      await flush(h, i + 2);
    }
    expect(h.operator.send).toHaveBeenCalledTimes(1);
    resolvers[0]!();
    await tick();
    h.ingest(900 + SETTLE_RETRY_BLOCKS - 1);
    await flush(h, 5);
    expect(h.operator.send).toHaveBeenCalledTimes(1);
    h.ingest(900 + SETTLE_RETRY_BLOCKS);
    await flush(h, 6);
    expect(h.operator.send).toHaveBeenCalledTimes(2);
  });

  test('backs off 10 -> 20 -> 40 blocks and gives up after MAX_SETTLE_ATTEMPTS (logged once per cycle)', async () => {
    h = makeHarness({ duelCount: 1n, table: one() });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let polls = 0;
    const pollAt = async (block: number) => {
      h.ingest(block);
      await flush(h, ++polls);
      await tick();
    };
    await pollAt(500); // attempt 1
    await pollAt(509);
    expect(h.operator.send).toHaveBeenCalledTimes(1);
    await pollAt(510); // attempt 2, next wait 20
    await pollAt(529);
    expect(h.operator.send).toHaveBeenCalledTimes(2);
    await pollAt(530); // attempt 3, next wait 40
    await pollAt(569);
    expect(h.operator.send).toHaveBeenCalledTimes(3);
    await pollAt(570); // attempt 4, wait 80
    await pollAt(650); // attempt 5, wait 160
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS);
    await pollAt(809);
    expect(errors.mock.calls.filter(([m]) => String(m).includes('giving up'))).toHaveLength(0);
    await pollAt(810); // wait over, attempts exhausted: pause
    await pollAt(2000 - 600); // still cooling off (810 + 600 = 1410)
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS);
    expect(errors.mock.calls.filter(([m]) => String(m).includes('giving up'))).toHaveLength(1);
  });

  test('caps concurrently pending settles at MAX_SETTLES_IN_FLIGHT', async () => {
    const table = Array.from({ length: 12 }, (_, i) => raw({ id: String(i), status: 'P1Won' }));
    h = makeHarness({ duelCount: 12n, table });
    const resolvers: (() => void)[] = [];
    h.operator.send.mockImplementation(() => new Promise<Hex>((res) => resolvers.push(() => res('0x1' as Hex))));
    h.ingest(500);
    await flush(h, 1);
    h.ingest(501);
    await flush(h, 2);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLES_IN_FLIGHT);
    resolvers[0]!();
    await tick();
    h.ingest(502);
    await flush(h, 3);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLES_IN_FLIGHT + 1);
    const ids = new Set(settleCalls(h).map(([r]) => r.data.slice(-2)));
    expect(ids.size).toBe(MAX_SETTLES_IN_FLIGHT + 1); // no duplicates
  });
});

describe('duelCount resync and failed polls', () => {
  let h: Harness;
  afterEach(() => h?.poller.stop());
  const countReads = (x: Harness) => x.client.readContract.mock.calls.filter(([p]) => p.functionName === 'duelCount').length;

  test('re-reads duelCount every DUEL_COUNT_RESYNC_MS and takes the max', async () => {
    h = makeHarness({ duelCount: 3n, table: bigTable(5) });
    h.ingest(500);
    await flush(h, 1);
    expect(countReads(h)).toBe(1);
    h.state.duelCount = 5n; // two DuelCreated logs were missed
    h.state.clock = DUEL_COUNT_RESYNC_MS - 1;
    h.ingest(501);
    await flush(h, 2);
    expect(countReads(h)).toBe(1);
    h.state.clock = DUEL_COUNT_RESYNC_MS;
    h.ingest(502);
    await flush(h, 3);
    await vi.waitFor(() => expect(countReads(h)).toBe(2));
    h.ingest(503);
    await flush(h, 4);
    expect(h.getDuelsCalls.at(-1)).toEqual({ from: 0n, count: 5n });
  });

  test('the resync never lowers the local count', async () => {
    h = makeHarness({ duelCount: 3n, table: bigTable(5) });
    h.ingest(500, [duelCreatedReceipt(4n, 500n)]);
    await flush(h, 1);
    h.state.clock = DUEL_COUNT_RESYNC_MS;
    h.ingest(501);
    await flush(h, 2);
    await vi.waitFor(() => expect(countReads(h)).toBe(2));
    h.ingest(502);
    await flush(h, 3);
    expect(h.getDuelsCalls.at(-1)).toEqual({ from: 0n, count: 5n });
  });

  test('a failed poll still broadcasts stats with the triggering block, but no duels', async () => {
    h = makeHarness();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.ingest(500);
    await flush(h, 1);
    h.state.getDuelsImpl = async () => {
      throw new Error('rpc timeout');
    };
    h.ingest(501);
    await vi.waitFor(() => expect(h.types('stats')).toHaveLength(2));
    expect(h.types('stats')[1]).toMatchObject({ block: '501', txTotal: 5 });
    expect(h.types('duels')).toHaveLength(1);
    expect(h.poller.latestBlock()).toBe(500);
  });
});

describe('settle cool-off and unsettled sticky cap', () => {
  let h: Harness;
  afterEach(() => h?.poller.stop());
  const logs = (spy: { mock: { calls: unknown[][] } }, text: string) =>
    spy.mock.calls.filter(([m]) => String(m).includes(text)).length;

  /** Polls at `block` and waits until the poll finished and the send promise handlers ran. */
  function poller() {
    let polls = 0;
    return async (block: number, receipts: TransactionReceipt[] = []) => {
      h.ingest(block, receipts);
      await flush(h, ++polls);
      await tick();
    };
  }

  test('after giving up, retries once SETTLE_COOLOFF_BLOCKS passed, resets attempts and succeeds', async () => {
    h = makeHarness({ duelCount: 1n, table: [raw({ id: '0', status: 'P1Won' })] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.operator.send.mockRejectedValue(new Error('out of gas'));
    const at = poller();
    for (const block of [500, 510, 530, 570, 650]) await at(block);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS);
    await at(810); // gives up, cool-off starts here
    expect(logs(errors, 'giving up')).toBe(1);
    await at(810 + SETTLE_COOLOFF_BLOCKS - 1);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS);
    h.operator.send.mockResolvedValue('0xabc' as Hex); // operator recovered
    await at(810 + SETTLE_COOLOFF_BLOCKS);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS + 1);
    expect(logs(errors, 'retry after cool-off')).toBe(1);
    // attempts were reset: the next wait is the first backoff (10), not the fifth (160)
    await at(810 + SETTLE_COOLOFF_BLOCKS + SETTLE_RETRY_BLOCKS - 1);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS + 1);
    await at(810 + SETTLE_COOLOFF_BLOCKS + SETTLE_RETRY_BLOCKS);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS + 2);
  });

  test('a settled duel clears its settle state, so a later unsettled view is settled afresh', async () => {
    h = makeHarness({ duelCount: 1n, table: [raw({ id: '0', status: 'P1Won' })] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.operator.send.mockRejectedValue(new Error('x'));
    const at = poller();
    for (const block of [500, 510, 530, 570, 650, 810]) await at(block); // gave up
    h.state.table = [raw({ id: '0', status: 'P1Won', settled: true })];
    await at(811);
    h.state.table = [raw({ id: '0', status: 'P1Won' })];
    await at(812); // no cool-off, no backoff left over
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS + 1);
  });

  test('an evicted, finished, unsubscribed duel stays cached through give-up and cool-off until settled', async () => {
    h = makeHarness({ duelCount: 60n, table: bigTable(70, (i) => (i === 5 ? { status: 'P1Won' } : {})) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.operator.send.mockRejectedValue(new Error('rpc down'));
    const at = poller();
    await at(500); // attempt 1, duel 5 still in the window
    await at(501, [duelCreatedReceipt(69n, 501n)]); // duel 5 leaves the window
    expect(h.poller.getDuel('5')).toBeDefined();
    expect(idsOf(h.types('duels')[1])).not.toContain('5'); // not re-broadcast to scope all
    for (const block of [510, 530, 570, 650, 810]) await at(block);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS);
    expect(h.poller.getDuel('5')).toBeDefined(); // paused, but still cached
    const readsDuringCooloff = singleReads(h).length;
    await at(900);
    expect(singleReads(h)).toHaveLength(readsDuringCooloff); // no re-reads while cooling off
    h.operator.send.mockResolvedValue('0xabc' as Hex);
    await at(810 + SETTLE_COOLOFF_BLOCKS);
    expect(h.operator.send).toHaveBeenCalledTimes(MAX_SETTLE_ATTEMPTS + 1);
    h.state.table = bigTable(70, (i) => (i === 5 ? { status: 'P1Won', settled: true } : {}));
    await at(810 + SETTLE_COOLOFF_BLOCKS + 1);
    await at(810 + SETTLE_COOLOFF_BLOCKS + 2);
    expect(h.poller.getDuel('5')).toBeUndefined(); // settled and unsubscribed: dropped
  });

  test('unsubscribed unsettled sticky duels are capped at MAX_UNSETTLED_STICKY, oldest dropped first', async () => {
    h = makeHarness({ duelCount: 70n, table: bigTable(200) });
    const at = poller();
    await at(500); // window 6..69
    await at(501, [duelCreatedReceipt(99n, 501n)]); // window 36..99; 6..35 become sticky
    await at(502, [duelCreatedReceipt(135n, 502n)]); // window 72..135; 36..71 join them: 66 unsubscribed
    expect(h.poller.duels()).toHaveLength(64 + MAX_UNSETTLED_STICKY);
    expect(h.poller.getDuel('71')).toBeDefined();
    expect(h.poller.getDuel('8')).toBeDefined();
    expect(h.poller.getDuel('7')).toBeUndefined();
    expect(h.poller.getDuel('6')).toBeUndefined();
    expect(idsOf(h.types('duels')[2])).toHaveLength(64);
  });

  test('subscribed sticky duels do not count towards the cap and are never dropped by it', async () => {
    h = makeHarness({ duelCount: 70n, table: bigTable(200) });
    h.subs.add('6');
    const at = poller();
    await at(500);
    await at(501, [duelCreatedReceipt(99n, 501n)]);
    await at(502, [duelCreatedReceipt(135n, 502n)]);
    expect(h.poller.getDuel('6')).toBeDefined();
    expect(h.poller.getDuel('7')).toBeUndefined(); // oldest unsubscribed one is dropped instead
    expect(h.poller.duels()).toHaveLength(64 + MAX_UNSETTLED_STICKY + 1);
  });
});

describe('reconnecting phone', () => {
  let h: Harness;
  afterEach(() => h?.poller.stop());

  test('gets its cached out-of-window duel in the replayed snapshot straight away', async () => {
    const { createWsHubCore } = await import('../src/ws');
    // duel 5 is unsubscribed and running: cached as sticky but not part of the last broadcast
    h = makeHarness({ duelCount: 60n, table: bigTable(70) });
    h.ingest(500);
    await flush(h, 1);
    h.ingest(501, [duelCreatedReceipt(69n, 501n)]);
    await flush(h, 2);
    expect(idsOf(h.types('duels')[1])).not.toContain('5');
    const core = createWsHubCore();
    core.onConnect(h.connectCbs[0]!);
    const out: string[] = [];
    core.add({ send: (d) => void out.push(d), readyState: 1 }, { duelId: '5' });
    expect((JSON.parse(out[0]!) as DuelsMsg).duels.map((d) => d.id)).toEqual(['5']);
    // an 'all' connection still gets the unmodified broadcast
    const all: string[] = [];
    core.add({ send: (d) => void all.push(d), readyState: 1 }, 'all');
    expect(idsOf(JSON.parse(all[0]!) as DuelsMsg)).not.toContain('5');
  });
});
