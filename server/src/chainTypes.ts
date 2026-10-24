import type { PublicClient } from 'viem';

/**
 * Structural shape of the server chain handle (same as createChain in chain.ts).
 * `call` runs a read/send against the current RPC and handles failover.
 */
export type ChainLike = {
  client: PublicClient;
  call<T>(fn: (client: PublicClient) => Promise<T>): Promise<T>;
};
