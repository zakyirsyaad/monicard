import type { Hex, TransactionReceipt } from 'viem';

export type TxReceipt = TransactionReceipt;

export type IngestListener = (block: bigint, receipts: TxReceipt[]) => void;

export type ReceiptHub = {
  /** Resolves with the receipt (immediately if already retained); rejects with Error('timeout'). */
  wait(hash: Hex, timeoutMs: number): Promise<TxReceipt>;
  ingest(blockNumber: bigint, receipts: TxReceipt[]): void;
  onIngest(cb: IngestListener): void;
  /** Number of waiters still pending (for tests and diagnostics). */
  pendingCount(): number;
};

/** Receipts are retained for this many blocks behind the newest ingested block. */
export const RETAIN_BLOCKS = 200n;

type Waiter = { resolve: (r: TxReceipt) => void; timer: ReturnType<typeof setTimeout> };
type Stored = { receipt: TxReceipt; block: bigint };

const keyOf = (hash: Hex): string => hash.toLowerCase();

export function createReceiptHub(): ReceiptHub {
  const receipts = new Map<string, Stored>();
  const blocks = new Map<bigint, string[]>();
  const waiters = new Map<string, Set<Waiter>>();
  const listeners: IngestListener[] = [];
  let newest = -1n;
  let listenerErrorLogged = false;

  function evictOld(): void {
    for (const [block, keys] of blocks) {
      if (newest - block <= RETAIN_BLOCKS) continue;
      for (const key of keys) {
        if (receipts.get(key)?.block === block) receipts.delete(key);
      }
      blocks.delete(block);
    }
  }

  function resolveWaiters(key: string, receipt: TxReceipt): void {
    const set = waiters.get(key);
    if (!set) return;
    waiters.delete(key);
    for (const w of set) {
      clearTimeout(w.timer);
      w.resolve(receipt);
    }
  }

  function notify(block: bigint, list: TxReceipt[]): void {
    for (const cb of listeners) {
      try {
        cb(block, list);
      } catch (err) {
        if (listenerErrorLogged) continue;
        listenerErrorLogged = true;
        console.error('receiptHub: onIngest listener threw', err);
      }
    }
  }

  function wait(hash: Hex, timeoutMs: number): Promise<TxReceipt> {
    const key = keyOf(hash);
    const known = receipts.get(key);
    if (known) return Promise.resolve(known.receipt);
    return new Promise<TxReceipt>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const set = waiters.get(key);
          set?.delete(waiter);
          if (set?.size === 0) waiters.delete(key);
          reject(new Error('timeout'));
        }, timeoutMs),
      };
      const set = waiters.get(key) ?? new Set<Waiter>();
      set.add(waiter);
      waiters.set(key, set);
    });
  }

  function ingest(blockNumber: bigint, list: TxReceipt[]): void {
    const keys = blocks.get(blockNumber) ?? [];
    for (const receipt of list) {
      const key = keyOf(receipt.transactionHash);
      receipts.set(key, { receipt, block: blockNumber });
      keys.push(key);
    }
    blocks.set(blockNumber, keys);
    if (blockNumber > newest) newest = blockNumber;
    evictOld();
    for (const receipt of list) resolveWaiters(keyOf(receipt.transactionHash), receipt);
    notify(blockNumber, list);
  }

  return {
    wait,
    ingest,
    onIngest: (cb) => {
      listeners.push(cb);
    },
    pendingCount: () => [...waiters.values()].reduce((n, set) => n + set.size, 0),
  };
}
