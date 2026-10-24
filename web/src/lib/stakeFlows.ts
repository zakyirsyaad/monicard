import { FundError, MIN_FUND_WEI, ensureFunds, joinDuel, mustSucceed, waitForTxGap } from './actions';
import type { ActionDeps } from './actions';
import { claimCall, stakeCall } from './stakeActions';
import type { RelayResult } from './types';

/** The burner cannot cover the stake plus the 0.1 MON reserve, and the faucet will not top it up. */
export class StakeFundsError extends Error {
  constructor() {
    super('Not enough test MON to stake');
    this.name = 'StakeFundsError';
  }
}

/** Makes sure the burner holds `stake + 0.1 MON`; a refused top-up (limits, budget) means it is short. */
async function ensureStakeFunds(deps: ActionDeps, stakeWei: bigint): Promise<void> {
  const minWei = stakeWei + MIN_FUND_WEI;
  try {
    const account = await ensureFunds(deps, deps.account.address, minWei);
    if (BigInt(account.balance) < minWei) throw new StakeFundsError();
  } catch (err) {
    if (err instanceof FundError && err.reason !== 'disabled') throw new StakeFundsError();
    throw err;
  }
}

/** Funds if needed, waits out the reserve-balance gap and stakes `stakeWei` on a duel. */
export async function stakeOnDuel(deps: ActionDeps, duelId: string, stakeWei: bigint): Promise<RelayResult> {
  await ensureStakeFunds(deps, stakeWei);
  await waitForTxGap(deps);
  return mustSucceed(await stakeCall(deps, duelId, stakeWei), 'stake');
}

export type JoinAndStake =
  | { joined: false }
  | { joined: true; staked: true; result: RelayResult }
  | { joined: true; staked: false; error: unknown };

/**
 * The challenger joins, then stakes before the countdown ends (the contract only accepts participants).
 * Funds cover `stake + 0.1 MON` BEFORE the join. A failed stake leaves the duel running without one.
 */
export async function joinAndStake(
  deps: ActionDeps,
  duelId: string,
  cardId: string,
  stakeWei: bigint,
  onJoined: () => void = () => undefined,
): Promise<JoinAndStake> {
  await ensureStakeFunds(deps, stakeWei);
  const joinResult = await joinDuel(deps, duelId, cardId);
  if (joinResult.status !== 'success') return { joined: false };
  onJoined();
  try {
    await waitForTxGap(deps);
    const result = mustSucceed(await stakeCall(deps, duelId, stakeWei), 'stake');
    return { joined: true, staked: true, result };
  } catch (error) {
    return { joined: true, staked: false, error };
  }
}

/** Pays the duel out. Anyone may call; value 0. */
export async function claimStake(deps: ActionDeps, duelId: string): Promise<RelayResult> {
  await ensureFunds(deps, deps.account.address);
  return mustSucceed(await claimCall(deps, duelId), 'claim');
}
