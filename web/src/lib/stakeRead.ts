import { createPublicClient, defineChain, http } from 'viem';
import type { Hex } from 'viem';
import { stakeVaultAbi } from './abi';
import type { StakeView } from './types';

/** Monad testnet public RPC: the one place web reads the chain directly (ruling A, N15). */
export const PUBLIC_RPC = 'https://testnet-rpc.monad.xyz';

const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
});

/** Reads `StakeVault.stakes(duelId)`. Throws on transient RPC errors: callers retry on their next trigger. */
export type StakeReader = (vault: Hex, duelId: string) => Promise<StakeView>;

/** `stakes()` returns (amount, openedBlock, p1Staked, p2Staked, claimed). */
export function parseStakeTuple(tuple: readonly [bigint, number, boolean, boolean, boolean]): StakeView {
  const [amount, , p1Staked, p2Staked, claimed] = tuple;
  return { amount, p1Staked, p2Staked, claimed };
}

export function createStakeReader(rpcUrl: string = PUBLIC_RPC): StakeReader {
  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  return async (vault, duelId) =>
    parseStakeTuple(
      await client.readContract({
        address: vault,
        abi: stakeVaultAbi,
        functionName: 'stakes',
        args: [BigInt(duelId)],
      }),
    );
}
