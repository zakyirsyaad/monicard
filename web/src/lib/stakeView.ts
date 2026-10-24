import type { Hex } from 'viem';
import { isFinal, mySide, sameAddress } from './duelView';
import { formatMon as formatMonString } from './format';
import type { Config, DuelView, StakeView } from './types';

export const RAKE_BPS = 500n;
const BPS = 10_000n;

/** Stake amounts offered to p1, in wei (0.01, 0.05, 0.1 MON). */
export const STAKE_CHOICES_WEI: readonly bigint[] = [
  10_000_000_000_000_000n,
  50_000_000_000_000_000n,
  100_000_000_000_000_000n,
];

/** MON amount without trailing zeros: 50000000000000000n -> "0.05". */
export const formatMon = (wei: bigint): string => formatMonString(wei);

/** The whole stake UI is behind `/config`: the vault address and both stake gas limits must be present. */
export function stakeEnabled(config: Config | null): boolean {
  return (
    config !== null &&
    config.contracts.stakeVault !== undefined &&
    config.gasLimits.stake !== undefined &&
    config.gasLimits.claim !== undefined
  );
}

/** True when anyone put MON into the duel. */
export function hasStake(stake: StakeView | null): stake is StakeView {
  return stake !== null && (stake.p1Staked || stake.p2Staked);
}

/** Mirrors `StakeVault.stake`: only a participant, only while Open or during the countdown, once per side. */
export function canStake(duel: DuelView, block: number, me: Hex, stake: StakeView | null): boolean {
  const side = mySide(duel, me);
  if (side === null || stake?.claimed) return false;
  const open = duel.status === 'Open';
  const counting = duel.status === 'Active' && block < duel.startBlock;
  if (!open && !counting) return false;
  return !(side === 1 ? stake?.p1Staked : stake?.p2Staked);
}

/** Both sides staked: twice the stake. Otherwise nothing is at stake against an opponent. */
export function potWei(stake: StakeView | null): bigint {
  return stake !== null && stake.p1Staked && stake.p2Staked ? 2n * stake.amount : 0n;
}

/** What the winner receives: the pot minus the 5% rake, floored like the contract. */
export function winnerPayoutWei(amount: bigint): bigint {
  const pot = 2n * amount;
  return pot - (pot * RAKE_BPS) / BPS;
}

export type StakeOutcome = 'win' | 'lose' | 'refund' | 'none';

/** Where my stake goes once the duel is final. `none` while it is still running or when nothing is staked. */
export function stakeOutcome(duel: DuelView, me: Hex, stake: StakeView | null): StakeOutcome {
  if (!hasStake(stake) || !isFinal(duel) || mySide(duel, me) === null) return 'none';
  if (duel.status === 'Draw' || !(stake.p1Staked && stake.p2Staked)) return 'refund';
  const winner = duel.status === 'P1Won' ? duel.p1 : duel.p2;
  return sameAddress(winner, me) ? 'win' : 'lose';
}
