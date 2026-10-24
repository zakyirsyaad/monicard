import type { Hex, PublicClient } from 'viem';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ERROR_LOG_INTERVAL_MS, MAX_BACKOFF_MS, RECEIPT_CONCURRENCY, STUCK_BLOCK_MS, startBlockWatcher } from '../src/blockWatcher';
import type { ChainLike } from '../src/chainTypes';

const POLL_MS = 150;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** Raw RPC receipt as returned by eth_getBlockReceipts (hex numbers, 0x1 status). */
const rawReceipt = (block: number, i: number) => ({
  transactionHash: h(block * 100 + i),
  blockNumber: `0x${block.toString(16)}`,
  blockHash: h(9999),
  transactionIndex: '0x0',
  from: '0x2222222222222222222222222222222222222222',
  to: '0x1111111111111111111111111111111111111111',
  cumulativeGasUsed: '0x5208',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x1',
  contractAddress: null,
  logs: [],
  logsBloom: '0x00',
  status: '0x1',
  type: '0x2',
});

function fakeChain(startHead: number) {
  const state = { head: startHead, failReceiptsFor: new Set<number>(), failHead: false, headCalls: 0, receiptCalls: [] as number[], latency: new Map<number, number>(), inFlight: 0, maxInFlight: 0 };
  const client = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_blockNumber') {
        state.headCalls += 1;
        if (state.failHead) throw new Error('head down');
        return `0x${state.head.toString(16)}`;
      }
      if (method === 'eth_getBlockReceipts') {
        const n = Number(BigInt(params![0] as string));
        state.receiptCalls.push(n);
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        try {
          const ms = state.latency.get(n);
          if (ms) await new Promise((r) => setTimeout(r, ms));
          if (state.failReceiptsFor.has(n)) throw new Error(`rpc error block ${n}`);
          return [rawReceipt(n, 1)];
        } finally {
          state.inFlight -= 1;
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const chain: ChainLike = { client: client as unknown as PublicClient, call: (fn) => fn(client as unknown as PublicClient) };
  return { chain, state };
}

function fakeHub() {
  const ingested: { block: bigint; hashes: Hex[]; status: string[]; numbers: unknown[] }[] = [];
  const hub = {
    wait: async () => {
      throw new Error('unused');
    },
    onIngest: () => undefined,
    pendingCount: () => 0,
    ingest: (block: bigint, rs: { transactionHash: Hex; status: string; blockNumber: unknown }[]) =>
      ingested.push({ block, hashes: rs.map((r) => r.transactionHash), status: rs.map((r) => r.status), numbers: rs.map((r) => r.blockNumber) }),
  };
  return { hub, ingested };
}

const tick = (ms = POLL_MS) => vi.advanceTimersByTimeAsync(ms);

afterEach(() => vi.useRealTimers());

describe('block watcher', () => {
  test('starts at the current block, ingests it, and formats receipts', async () => {
    vi.useFakeTimers();
    const { chain } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS });
    await tick(0);
    expect(ingested.map((i) => i.block)).toEqual([10n]);
    expect(ingested[0]!.status).toEqual(['success']);
    expect(ingested[0]!.numbers).toEqual([10n]);
    expect(w.latestBlock()).toBe(10n);
    w.stop();
  });

  test('does not re-ingest a block when the head did not move', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS });
    await tick(0);
    await tick();
    await tick();
    expect(ingested).toHaveLength(1);
    state.head = 11;
    await tick();
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n]);
    w.stop();
  });

  test('ingests skipped blocks in ascending order, one getBlockReceipts per block', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS });
    await tick(0);
    state.head = 14;
    await tick();
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n, 12n, 13n, 14n]);
    expect(state.receiptCalls).toEqual([10, 11, 12, 13, 14]);
    expect(w.latestBlock()).toBe(14n);
    w.stop();
  });

  test('an error does not skip blocks; the next tick retries from the failed block', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const errors: unknown[] = [];
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS, onError: (e) => errors.push(e) });
    await tick(0);
    state.head = 13;
    state.failReceiptsFor.add(12);
    await tick();
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n]);
    expect(w.latestBlock()).toBe(11n);
    expect(errors).toHaveLength(1);
    state.failReceiptsFor.clear();
    await tick(MAX_BACKOFF_MS);
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n, 12n, 13n]);
    w.stop();
  });

  test('a head lookup failure at startup is retried and the start block is not lost', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    state.failHead = true;
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS, onError: () => undefined });
    await tick(0);
    expect(ingested).toHaveLength(0);
    expect(w.latestBlock()).toBe(0n);
    state.failHead = false;
    await tick(MAX_BACKOFF_MS);
    expect(ingested.map((i) => i.block)).toEqual([10n]);
    w.stop();
  });

  test('caps catch-up at 50 blocks per tick, then continues in order', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS });
    await tick(0);
    const headCallsBefore = state.headCalls;
    state.head = 130;
    await tick();
    for (let i = 0; i < 10; i++) await tick(1); // capped ticks reschedule with zero delay (< pollMs)
    expect(state.headCalls - headCallsBefore).toBeGreaterThanOrEqual(3); // 120 blocks / 50 per tick
    expect(w.latestBlock()).toBe(130n);
    expect(ingested.map((i) => i.block)).toEqual(Array.from({ length: 121 }, (_, i) => BigInt(10 + i)));
    w.stop();
  });

  test('fetches with bounded concurrency (RECEIPT_CONCURRENCY in flight at most)', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS });
    await tick(0);
    state.head = 40;
    for (let n = 11; n <= 40; n++) state.latency.set(n, 20);
    await tick(POLL_MS);
    for (let i = 0; i < 40; i++) await tick(10);
    expect(RECEIPT_CONCURRENCY).toBe(6);
    expect(state.maxInFlight).toBe(RECEIPT_CONCURRENCY);
    expect(ingested.map((i) => i.block)).toEqual(Array.from({ length: 31 }, (_, i) => BigInt(10 + i)));
    w.stop();
  });

  test('ingests in ascending order even when responses arrive out of order', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS });
    await tick(0);
    state.head = 16;
    [11, 12, 13, 14, 15, 16].forEach((n, i) => state.latency.set(n, 100 - i * 15)); // 11 slowest, 16 fastest
    await tick(POLL_MS);
    await tick(200);
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n, 12n, 13n, 14n, 15n, 16n]);
    w.stop();
  });

  test('a failure inside a chunk ingests the successful prefix and retries from the failed block', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const errors: unknown[] = [];
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS, onError: (e) => errors.push(e) });
    await tick(0);
    state.head = 16;
    state.failReceiptsFor.add(13);
    await tick(POLL_MS);
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n, 12n]); // 14..16 fetched but not ingested past the gap
    expect(w.latestBlock()).toBe(12n);
    expect(errors).toHaveLength(1);
    state.failReceiptsFor.clear();
    await tick(MAX_BACKOFF_MS);
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n, 12n, 13n, 14n, 15n, 16n]);
    w.stop();
  });

  test('a block failing for over STUCK_BLOCK_MS is reported once and skipped to head', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const errors: Error[] = [];
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS, onError: (e) => errors.push(e as Error) });
    await tick(0);
    state.head = 14;
    state.failReceiptsFor.add(12);
    await tick(STUCK_BLOCK_MS - 500);
    expect(w.latestBlock()).toBe(11n);
    expect(errors.some((e) => /stuck/.test(e.message))).toBe(false);
    await tick(3_000);
    const stuck = errors.filter((e) => /stuck/.test(e.message));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.message).toContain('12');
    expect(w.latestBlock()).toBe(14n);
    expect(w.lag()).toBe(0n);
    state.head = 15;
    await tick(MAX_BACKOFF_MS);
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n, 15n]);
    expect(errors.filter((e) => /stuck/.test(e.message))).toHaveLength(1);
    w.stop();
  });

  test('lag() is head minus the last handled block', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS, onError: () => undefined });
    expect(w.lag()).toBe(0n);
    await tick(0);
    expect(w.lag()).toBe(0n);
    state.head = 14;
    state.failReceiptsFor.add(12);
    await tick(POLL_MS);
    expect(w.lag()).toBe(3n); // handled 11, head 14
    state.failReceiptsFor.clear();
    await tick(MAX_BACKOFF_MS);
    expect(w.lag()).toBe(0n);
    w.stop();
  });

  test('onStuck is called once with the skipped block', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub } = fakeHub();
    const stuck: bigint[] = [];
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS, onError: () => undefined, onStuck: (b) => stuck.push(b) });
    await tick(0);
    state.head = 14;
    state.failReceiptsFor.add(12);
    await tick(STUCK_BLOCK_MS + 5_000);
    expect(stuck).toEqual([12n]);
    w.stop();
  });

  test('onError is throttled: first error at once, then one summary per interval with a suppressed count', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub } = fakeHub();
    const errors: Error[] = [];
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS, onError: (e) => errors.push(e as Error) });
    await tick(0);
    state.head = 12;
    state.failReceiptsFor.add(11); // fails forever, but not for long enough to count as stuck
    await tick(ERROR_LOG_INTERVAL_MS - 1_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('rpc error block 11');
    await tick(3_000); // crosses the 5 s interval
    expect(errors).toHaveLength(2);
    const match = /\(\+(\d+) similar errors suppressed\)/.exec(errors[1]!.message);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(2);
    w.stop();
  });

  test('throwing callbacks never kill the loop', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, {
      pollMs: POLL_MS,
      onError: () => {
        throw new Error('logger broke');
      },
    });
    await tick(0);
    state.head = 11;
    state.failReceiptsFor.add(11);
    await tick(MAX_BACKOFF_MS);
    state.failReceiptsFor.clear();
    await tick(MAX_BACKOFF_MS);
    expect(ingested.map((i) => i.block)).toEqual([10n, 11n]);
    w.stop();
  });

  test('failed ticks back off exponentially up to MAX_BACKOFF_MS and a good tick resets to pollMs', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub } = fakeHub();
    state.failHead = true;
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS, onError: () => undefined });
    await tick(0);
    expect(state.headCalls).toBe(1); // t=0, fails -> next in 300
    await tick(299);
    expect(state.headCalls).toBe(1);
    await tick(1);
    expect(state.headCalls).toBe(2); // t=300, fails -> next in 600
    await tick(599);
    expect(state.headCalls).toBe(2);
    await tick(1);
    expect(state.headCalls).toBe(3); // t=900, fails -> next in 1200
    await tick(1_200); // t=2100, fails -> capped at 2000
    expect(state.headCalls).toBe(4);
    await tick(1_999);
    expect(state.headCalls).toBe(4);
    state.failHead = false;
    await tick(1);
    expect(state.headCalls).toBe(5); // success, delay back to pollMs
    await tick(POLL_MS);
    expect(state.headCalls).toBe(6);
    await tick(POLL_MS);
    expect(state.headCalls).toBe(7);
    w.stop();
  });

  test('stop() ends the loop', async () => {
    vi.useFakeTimers();
    const { chain, state } = fakeChain(10);
    const { hub, ingested } = fakeHub();
    const w = startBlockWatcher(chain, hub as never, { pollMs: POLL_MS });
    await tick(0);
    w.stop();
    state.head = 12;
    await tick(1_000);
    expect(ingested).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
