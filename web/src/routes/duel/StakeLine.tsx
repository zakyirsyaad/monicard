import { Notice } from '../../components/Notice';
import { formatMon, hasStake, potWei } from '../../lib/stakeView';
import type { StakeView } from '../../lib/types';

/** What the challenger's join+stake sequence reports to the duel screens (it outlives JoinConfirm). */
export type StakeJoin = { staking: bigint | null; notice: string | null };
export const NO_STAKE_JOIN: StakeJoin = { staking: null, notice: null };

export const STAKING_CLOSED_NOTICE = 'Staking closed for this duel. It runs without a stake.';

export interface StakeLineProps {
  stake: StakeView | null;
  join: StakeJoin;
}

/** Small line under the status row: pot, an unmatched stake, or the challenger's stake in flight. */
export function StakeLine({ stake, join }: StakeLineProps) {
  if (join.notice) return <Notice tone="info">{join.notice}</Notice>;
  const pot = potWei(stake);
  if (pot > 0n) return <p className="data text-ink-muted">Pot {formatMon(pot)} MON</p>;
  if (join.staking !== null) {
    return <p className="data text-ink-muted">Staking {formatMon(join.staking)} MON before the duel starts…</p>;
  }
  if (hasStake(stake)) return <p className="data text-ink-muted">Stake {formatMon(stake.amount)} MON · not matched</p>;
  return null;
}
