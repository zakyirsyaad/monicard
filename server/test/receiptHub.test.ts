import type { Hex, TransactionReceipt } from 'viem';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createReceiptHub } from '../src/receiptHub';

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const receipt = (hash: Hex, blockNumber = 100n) => ({ transactionHash: hash, blockNumber, status: 'success', logs: [] }) as unknown as TransactionReceipt;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('receipt hub', () => {
  test('resolves a waiter when its receipt is ingested', async () => {
    const hub = createReceiptHub();
    const p = hub.wait(h(1), 5000);
    hub.ingest(100n, [receipt(h(1))]);
    expect((await p).transactionHash).toBe(h(1));
  });

  test('a waiter registered after ingest resolves immediately', async () => {
    const hub = createReceiptHub();
    hub.ingest(100n, [receipt(h(1))]);
    expect((await hub.wait(h(1), 100)).transactionHash).toBe(h(1));
  });

  test('several waiters on one hash all resolve', async () => {
    const hub = createReceiptHub();
    const [a, b] = [hub.wait(h(1), 5000), hub.wait(h(1), 5000)];
    hub.ingest(100n, [receipt(h(1))]);
    expect((await a).transactionHash).toBe(h(1));
    expect((await b).transactionHash).toBe(h(1));
  });

  test('hashes are compared case-insensitively', async () => {
    const hub = createReceiptHub();
    const mixed = '0xABCDEF0000000000000000000000000000000000000000000000000000000001' as Hex;
    const p = hub.wait(mixed.toLowerCase() as Hex, 5000);
    hub.ingest(100n, [receipt(mixed)]);
    expect((await p).transactionHash).toBe(mixed);
    expect((await hub.wait(mixed, 10)).transactionHash).toBe(mixed);
  });

  test('rejects with timeout and cleans the waiter up', async () => {
    vi.useFakeTimers();
    const hub = createReceiptHub();
    const p = hub.wait(h(1), 5000);
    const assertion = expect(p).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(hub.pendingCount()).toBe(0);
    hub.ingest(100n, [receipt(h(1))]); // must not throw or resolve anything stale
  });

  test('a resolved waiter does not time out later', async () => {
    vi.useFakeTimers();
    const hub = createReceiptHub();
    const p = hub.wait(h(1), 5000);
    hub.ingest(100n, [receipt(h(1))]);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  test('evicts blocks more than 200 behind the newest ingested block', async () => {
    const hub = createReceiptHub();
    hub.ingest(100n, [receipt(h(1), 100n)]);
    hub.ingest(300n, [receipt(h(2), 300n)]);
    expect((await hub.wait(h(1), 10)).transactionHash).toBe(h(1)); // exactly 200 behind: kept
    hub.ingest(301n, []);
    await expect(hub.wait(h(1), 10)).rejects.toThrow('timeout');
    expect((await hub.wait(h(2), 10)).transactionHash).toBe(h(2));
  });

  test('onIngest listeners run after waiters resolve and get block + receipts', async () => {
    const hub = createReceiptHub();
    const order: string[] = [];
    const p = hub.wait(h(1), 5000).then(() => order.push('waiter'));
    hub.onIngest((block, rs) => order.push(`listener:${block}:${rs.length}`));
    hub.ingest(100n, [receipt(h(1))]);
    await p;
    expect(order).toEqual(['listener:100:1', 'waiter']); // promise callbacks are microtasks; resolve() already called
  });

  test('a throwing listener does not break ingest and is logged once', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hub = createReceiptHub();
    const seen: bigint[] = [];
    hub.onIngest(() => {
      throw new Error('boom');
    });
    hub.onIngest((b) => seen.push(b));
    const p = hub.wait(h(1), 5000);
    hub.ingest(100n, [receipt(h(1))]);
    hub.ingest(101n, []);
    expect((await p).transactionHash).toBe(h(1));
    expect(seen).toEqual([100n, 101n]);
    expect(err).toHaveBeenCalledTimes(1);
  });
});
