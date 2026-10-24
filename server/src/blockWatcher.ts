import { formatTransactionReceipt, hexToBigInt, toHex, type Hex } from 'viem';
import type { ChainLike } from './chainTypes';
import type { ReceiptHub, TxReceipt } from './receiptHub';

export type { ChainLike } from './chainTypes';

export const DEFAULT_POLL_MS = 150;
/** Upper bound on blocks fetched in a single tick, so one tick stays short. */
export const MAX_CATCHUP_BLOCKS = 50;
/** Blocks fetched in parallel per chunk (RTT to the public RPC can exceed the ~300 ms block time). */
export const RECEIPT_CONCURRENCY = 6;
/** A block that keeps failing for this long is skipped (loudly) so the watcher can catch up. */
export const STUCK_BLOCK_MS = 10_000;

export type WatcherOptions = {
  pollMs?: number;
  /** Called when a tick fails; the watcher retries on the next tick without skipping blocks. */
  onError?: (err: unknown) => void;
  now?: () => number;
};

export type BlockWatcher = {
  latestBlock(): bigint;
  /** Chain head minus last handled block, as of the last successful head poll. */
  lag(): bigint;
  stop(): void;
};

type RawReceipt = Parameters<typeof formatTransactionReceipt>[0];

async function fetchHead(chain: ChainLike): Promise<bigint> {
  const hex = await chain.call((c) => c.request({ method: 'eth_blockNumber' }));
  return hexToBigInt(hex as Hex);
}

async function fetchBlockReceipts(chain: ChainLike, block: bigint): Promise<TxReceipt[]> {
  const raw = (await chain.call((c) =>
    c.request({ method: 'eth_getBlockReceipts', params: [toHex(block)] }),
  )) as RawReceipt[] | null;
  if (!raw) throw new Error(`eth_getBlockReceipts returned null for block ${block}`);
  return raw.map((r) => formatTransactionReceipt(r));
}

export function startBlockWatcher(chain: ChainLike, hub: ReceiptHub, opts: WatcherOptions = {}): BlockWatcher {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;
  let cursor: bigint | null = null; // last handled block (ingested, or skipped as stuck)
  let head = 0n;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failing: { block: bigint; since: number; reported: boolean } | null = null;

  /** Fetch a chunk in parallel, ingest the successful prefix in order, throw the first failure. */
  async function ingestChunk(blocks: bigint[]): Promise<void> {
    const results = await Promise.allSettled(blocks.map((b) => fetchBlockReceipts(chain, b)));
    for (const [i, result] of results.entries()) {
      const block = blocks[i]!;
      if (stopped) return;
      if (result.status === 'rejected') {
        noteFailure(block);
        throw result.reason;
      }
      hub.ingest(block, result.value);
      cursor = block;
      failing = null;
    }
  }

  /** Same block failing for too long: report once and jump to the head. */
  function noteFailure(block: bigint): void {
    if (failing?.block !== block) failing = { block, since: now(), reported: false };
    if (failing.reported || now() - failing.since <= STUCK_BLOCK_MS) return;
    failing.reported = true;
    opts.onError?.(new Error(`block ${block} stuck for over ${STUCK_BLOCK_MS} ms, skipping to head ${head}`));
    cursor = head;
    failing = null;
  }

  /** Returns true when more blocks remain (catch-up was capped). */
  async function tick(): Promise<boolean> {
    head = await fetchHead(chain);
    const first = cursor === null ? head : cursor + 1n;
    const last = head < first + BigInt(MAX_CATCHUP_BLOCKS) - 1n ? head : first + BigInt(MAX_CATCHUP_BLOCKS) - 1n;
    const pending: bigint[] = [];
    for (let n = first; n <= last; n++) pending.push(n);
    for (let i = 0; i < pending.length && !stopped; i += RECEIPT_CONCURRENCY) {
      await ingestChunk(pending.slice(i, i + RECEIPT_CONCURRENCY));
    }
    return last < head;
  }

  async function loop(): Promise<void> {
    let more = false;
    try {
      more = await tick();
    } catch (err) {
      opts.onError?.(err);
    }
    if (!stopped) timer = setTimeout(loop, more ? 0 : pollMs);
  }

  timer = setTimeout(loop, 0);

  return {
    latestBlock: () => cursor ?? 0n,
    lag: () => (cursor === null || head < cursor ? 0n : head - cursor),
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
