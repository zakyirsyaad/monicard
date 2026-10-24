import {
  parseEther,
  parseGwei,
  type Account,
  type Hex,
  type TransactionSerializable,
} from 'viem';
import type { ChainLike } from './chainTypes';

/** N9: below 10 MON a value tx is only allowed after three quiet blocks. */
export const RESERVE_BALANCE_WEI = parseEther('10');
export const RESERVE_BLOCKS = 3n;
export const DEFAULT_POLL_MS = 300;
export const PRIORITY_FEE_WEI = parseGwei('2');

export type SendRequest = {
  to: Hex;
  data: Hex;
  gas: bigint;
  value?: bigint;
};

export type WalletQueue = {
  address: Hex;
  send(req: SendRequest): Promise<Hex>;
  resyncNonce(): Promise<void>;
};

export type WalletChain = ChainLike & {
  chainId: number;
  getGasPrice(): Promise<bigint>;
};

export type WalletQueueOptions = {
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
};

type SigningAccount = Account & {
  signTransaction(args: TransactionSerializable): Promise<Hex>;
};

const NONCE_ERROR = /nonce too low|nonce has already been used|nonce is too low|invalid nonce/i;

function errorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    else if (typeof current === 'object' && 'message' in current) {
      parts.push(String((current as { message: unknown }).message));
    } else break;
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One sequential queue per wallet. The local nonce advances only after the node
 * accepts the raw tx; any failure resyncs from the chain, so a rejected tx never
 * leaves a permanent gap.
 */
export function createWalletQueue(
  account: Account,
  chain: WalletChain,
  options: WalletQueueOptions = {},
): WalletQueue {
  const signer = account as SigningAccount;
  if (typeof signer.signTransaction !== 'function') {
    throw new Error('wallet queue requires a local signing account');
  }
  const address = account.address as Hex;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  let nonce: number | null = null;
  let lastTxBlock: bigint | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const readNonce = (): Promise<number> =>
    chain.call((client) => client.getTransactionCount({ address, blockTag: 'pending' }));

  async function resyncNonce(): Promise<void> {
    nonce = await readNonce();
  }

  async function ensureNonce(): Promise<number> {
    if (nonce === null) nonce = await readNonce();
    return nonce;
  }

  async function markTxBlock(): Promise<void> {
    try {
      lastTxBlock = await chain.call((client) => client.getBlockNumber());
    } catch {
      // Bookkeeping must never turn a successful send into a failure.
    }
  }

  async function waitForReserve(): Promise<void> {
    if (lastTxBlock === null) return;
    const balance = await chain.call((client) => client.getBalance({ address }));
    if (balance >= RESERVE_BALANCE_WEI) return;
    const target = lastTxBlock + RESERVE_BLOCKS;
    for (;;) {
      const block = await chain.call((client) => client.getBlockNumber());
      if (block >= target) return;
      await sleep(pollMs);
    }
  }

  async function sendOnce(req: SendRequest): Promise<Hex> {
    const value = req.value ?? 0n;
    if (value > 0n) await waitForReserve();
    const gasPrice = await chain.getGasPrice();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const txNonce = await ensureNonce();
      const serialized = await signer.signTransaction({
        chainId: chain.chainId,
        type: 'eip1559',
        nonce: txNonce,
        to: req.to,
        data: req.data,
        value,
        gas: req.gas,
        // Headroom only: the effective price is still base fee + priority.
        maxFeePerGas: gasPrice * 2n,
        maxPriorityFeePerGas: PRIORITY_FEE_WEI,
      });

      try {
        const hash = await chain.call((client) =>
          client.sendRawTransaction({ serializedTransaction: serialized }),
        );
        nonce = txNonce + 1;
        await markTxBlock();
        return hash;
      } catch (error) {
        await markTxBlock();
        await resyncNonce();
        if (attempt === 0 && NONCE_ERROR.test(errorMessage(error))) continue;
        throw error;
      }
    }
    throw new Error('wallet queue: send failed');
  }

  function send(req: SendRequest): Promise<Hex> {
    const run = tail.then(() => sendOnce(req));
    // Keep the chain alive after a rejection; callers see their own failure.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return { address, send, resyncNonce };
}