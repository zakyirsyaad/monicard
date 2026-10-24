import type { Hex, PublicClient } from 'viem';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { startBlockWatcher } from '../src/blockWatcher';
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
  const state = { head: startHead, failReceiptsFor: new Set<number>(), failHead: false, headCalls: 0, receiptCalls: [] as number[] };
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
        if (state.failReceiptsFor.has(n)) throw new Error(`rpc error block ${n}`);
        return [rawReceipt(n, 1)];
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
    await tick();
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
    await tick();
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
