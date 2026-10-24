import { encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import { stakeVaultAbi } from './abi';
import { sendCall } from './actions';
import type { ActionDeps } from './actions';
import type { RelayResult } from './types';

function vaultOf({ config }: ActionDeps): { vault: Hex; stakeGas: number; claimGas: number } {
  const { stakeVault } = config.contracts;
  const { stake, claim } = config.gasLimits;
  if (stakeVault === undefined || stake === undefined || claim === undefined) {
    throw new Error('Staking is not enabled');
  }
  return { vault: stakeVault, stakeGas: stake, claimGas: claim };
}

/** `StakeVault.stake(duelId)` with `valueWei`. A value tx: never re-signed after a timeout. */
export function stakeCall(deps: ActionDeps, duelId: string, valueWei: bigint): Promise<RelayResult> {
  const { vault, stakeGas } = vaultOf(deps);
  return sendCall(deps, {
    fn: 'stake',
    to: vault,
    data: encodeFunctionData({ abi: stakeVaultAbi, functionName: 'stake', args: [BigInt(duelId)] }),
    gas: stakeGas,
    value: valueWei,
  });
}

/** `StakeVault.claim(duelId)`: pays the result out. Value 0. */
export function claimCall(deps: ActionDeps, duelId: string): Promise<RelayResult> {
  const { vault, claimGas } = vaultOf(deps);
  return sendCall(deps, {
    fn: 'claim',
    to: vault,
    data: encodeFunctionData({ abi: stakeVaultAbi, functionName: 'claim', args: [BigInt(duelId)] }),
    gas: claimGas,
  });
}
