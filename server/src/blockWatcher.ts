import { formatTransactionReceipt, hexToBigInt, toHex, type Hex } from 'viem';
import type { ChainLike } from './chainTypes';
import type { ReceiptHub, TxReceipt } from './receiptHub';

export type { ChainLike } from './chainTypes';

export const DEFAULT_POLL_MS = 150;
/** Upper bound on blocks fetched in a single tick, so one tick stays short. */
export const MAX_CATCHUP_BLOCKS = 50;

export type WatcherOptions = {
  pollMs?: number;
  /** Called when a tick fails; the watcher retries on the next tick without skipping blocks. */
  onError?: (err: unknown) => void;
};

export type BlockWatcher = { latestBlock(): bigint; stop(): void };

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
  let cursor: bigint | null = null; // last fully ingested block
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Returns true when more blocks remain (catch-up was capped). */
  async function tick(): Promise<boolean> {
    const head = await fetchHead(chain);
    const first = cursor === null ? head : cursor + 1n;
    const last = head < first + BigInt(MAX_CATCHUP_BLOCKS) - 1n ? head : first + BigInt(MAX_CATCHUP_BLOCKS) - 1n;
    for (let n = first; n <= last; n++) {
      if (stopped) return false;
      hub.ingest(n, await fetchBlockReceipts(chain, n));
      cursor = n;
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
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
