import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { env } from './env';

export const RPC_RETRY_DELAY_MS = 150;
export const RPC_TIMEOUT_MS = 10_000;
export const GAS_PRICE_TTL_MS = 10_000;

export type Chain = {
  chainId: number;
  client: PublicClient;
  call<T>(fn: (client: PublicClient) => Promise<T>): Promise<T>;
  getGasPrice(): Promise<bigint>;
};

export type CreateChainOptions = {
  /** Test seam: use these clients instead of building one per URL. */
  clients?: PublicClient[];
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  now?: () => number;
  gasPriceTtlMs?: number;
};

type ErrorLike = {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
};

const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const RETRYABLE_STATUS = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/**
 * N10: HTTP 429, 5xx and timeouts are retryable. A revert (or any client error) is not.
 * viem wraps transport failures, so inspect the cause chain as well.
 */
export function isRetryable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== 'object') return false;
    const candidate = current as ErrorLike;

    if (typeof candidate.status === 'number' && RETRYABLE_STATUS(candidate.status)) return true;
    if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') return true;
    if (typeof candidate.code === 'string' && RETRYABLE_CODES.has(candidate.code)) return true;

    if (typeof candidate.message === 'string') {
      const message = candidate.message.toLowerCase();
      if (message.includes('reverted')) return false;
      if (
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('fetch failed') ||
        message.includes('socket hang up') ||
        message.includes('econnreset') ||
        message.includes('too many requests') ||
        message.includes('rate limit')
      ) {
        return true;
      }
      if (message.includes('status') && /\b(408|429|500|502|503|504)\b/.test(message)) return true;
    }

    current = candidate.cause;
  }
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(url: string, chainId: number): PublicClient {
  const chain = defineChain({
    id: chainId,
    name: `monad-${chainId}`,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  return createPublicClient({
    chain,
    // viem otherwise caches getBlockNumber for 4 s (~13 Monad blocks), which
    // stalls the block watcher and poller.
    cacheTime: 0,
    // Our failover owns retries; viem must not multiply them per URL.
    transport: http(url, { retryCount: 0, timeout: RPC_TIMEOUT_MS }),
  });
}

/**
 * Failover RPC handle. Each URL gets one immediate retry on a retryable error,
 * then the next URL is tried. Non-retryable errors surface immediately.
 */
export function createChain(
  rpcUrls: string[],
  chainId: number = env.chainId,
  options: CreateChainOptions = {},
): Chain {
  const clients = options.clients ?? rpcUrls.map((url) => createClient(url, chainId));
  const primary = clients[0];
  if (!primary) throw new Error('createChain: at least one RPC URL is required');

  const sleep = options.sleep ?? defaultSleep;
  const retryDelayMs = options.retryDelayMs ?? RPC_RETRY_DELAY_MS;
  const now = options.now ?? Date.now;
  const gasPriceTtlMs = options.gasPriceTtlMs ?? GAS_PRICE_TTL_MS;

  async function call<T>(fn: (client: PublicClient) => Promise<T>): Promise<T> {
    let lastError: unknown = new Error('all RPC endpoints failed');
    for (const client of clients) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await fn(client);
        } catch (error) {
          lastError = error;
          if (!isRetryable(error)) throw error;
          if (attempt === 0) await sleep(retryDelayMs);
        }
      }
    }
    throw lastError;
  }

  let cachedGasPrice: { value: bigint; at: number } | null = null;
  async function getGasPrice(): Promise<bigint> {
    const at = now();
    if (cachedGasPrice && at - cachedGasPrice.at < gasPriceTtlMs) return cachedGasPrice.value;
    const value = await call((client) => client.getGasPrice());
    cachedGasPrice = { value, at: now() };
    return value;
  }

  return { chainId, client: primary, call, getGasPrice };
}