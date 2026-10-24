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
/** onError reports the first failure, then at most one summary (with a suppressed count) per interval. */
export const ERROR_LOG_INTERVAL_MS = 5_000;
/** After failed ticks the delay doubles from pollMs up to this ceiling; a good tick resets it. */
export const MAX_BACKOFF_MS = 2_000;

export type WatcherOptions = {
  pollMs?: number;
  /** Called when a tick fails; the watcher retries on the next tick without skipping blocks. */
  onError?: (err: unknown) => void;
  /** Called once when a stuck block is skipped (onError also receives an unthrottled message). */
  onStuck?: (block: bigint) => void;
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

/** Callbacks are for logging; a throwing one must never kill the watcher loop. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // intentionally ignored: see above
  }
}

export function startBlockWatcher(chain: ChainLike, hub: ReceiptHub, opts: WatcherOptions = {}): BlockWatcher {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;
  let cursor: bigint | null = null; // last handled block (ingested, or skipped as stuck)
  let head = 0n;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let lastReportAt: number | null = null;
  let suppressed = 0;
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
    safely(() => opts.onError?.(new Error(`block ${block} stuck for over ${STUCK_BLOCK_MS} ms, skipping to head ${head}`)));
    safely(() => opts.onStuck?.(block));
    cursor = head;
    failing = null;
  }

  /** Throttled error reporting: first error at once, then one summary per interval. */
  function report(err: unknown): void {
    const t = now();
    if (lastReportAt !== null && t - lastReportAt < ERROR_LOG_INTERVAL_MS) {
      suppressed += 1;
      return;
    }
    const extra = suppressed;
    lastReportAt = t;
    suppressed = 0;
    const shown = extra === 0 ? err : new Error(`${(err as Error)?.message ?? String(err)} (+${extra} similar errors suppressed)`, { cause: err });
    safely(() => opts.onError?.(shown));
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
    let delay = pollMs;
    try {
      more = await tick();
      consecutiveFailures = 0;
      delay = more ? 0 : pollMs;
    } catch (err) {
      report(err);
      consecutiveFailures += 1;
      delay = Math.min(pollMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
    }
    if (!stopped) timer = setTimeout(loop, delay);
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
