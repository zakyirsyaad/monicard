import { createPublicClient, defineChain, http } from 'viem';
import type { Hex } from 'viem';
import { battleAbi } from './abi';
import { normalizeMatch } from './rules';
import type { MatchView } from './types';

/** Monad testnet public RPC: the only place the battle screen reads the chain directly. */
export const PUBLIC_RPC = 'https://testnet-rpc.monad.xyz';

const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
});

export const battleClient = createPublicClient({ chain: monadTestnet, transport: http(PUBLIC_RPC) });

export async function readBlockNumber(): Promise<number> {
  return Number(await battleClient.getBlockNumber());
}

/** `getMatch(id)`; null when the call reverts (no such match) or the RPC fails. */
export async function readMatch(address: Hex, id: string): Promise<MatchView | null> {
  try {
    const raw = await battleClient.readContract({
      address,
      abi: battleAbi,
      functionName: 'getMatch',
      args: [BigInt(id)],
    });
    const fields = raw as unknown as Record<string, unknown>;
    if (fields.p1 === undefined) return null;
    return normalizeMatch({ ...fields, id });
  } catch {
    return null;
  }
}

export async function readMatchCount(address: Hex): Promise<number> {
  try {
    return Number(await battleClient.readContract({ address, abi: battleAbi, functionName: 'matchCount' }));
  } catch {
    return 0;
  }
}
