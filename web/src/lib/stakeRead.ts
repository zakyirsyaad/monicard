import { createPublicClient, http } from 'viem';
import { monadChain, NETWORK } from './network';
import type { Hex } from 'viem';
import { stakeVaultAbi } from './abi';
import type { StakeView } from './types';

/** Public RPC of this host's network: the one place web reads the chain directly (ruling A, N15). */
export const PUBLIC_RPC = NETWORK.rpc;

/** Reads `StakeVault.stakes(duelId)`. Throws on transient RPC errors: callers retry on their next trigger. */
export type StakeReader = (vault: Hex, duelId: string) => Promise<StakeView>;

/** `stakes()` returns (amount, openedBlock, p1Staked, p2Staked, claimed). */
export function parseStakeTuple(tuple: readonly [bigint, number, boolean, boolean, boolean]): StakeView {
  const [amount, , p1Staked, p2Staked, claimed] = tuple;
  return { amount, p1Staked, p2Staked, claimed };
}

export function createStakeReader(rpcUrl: string = PUBLIC_RPC): StakeReader {
  const client = createPublicClient({ chain: monadChain, transport: http(rpcUrl) });
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
