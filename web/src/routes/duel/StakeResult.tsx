import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import type { Side } from '../../lib/duelView';
import { toFriendly } from '../../lib/errors';
import { explorerTx } from '../../lib/format';
import { actionDeps } from '../../lib/player';
import { claimStake } from '../../lib/stakeFlows';
import { formatMon, stakeOutcome, winnerPayoutWei } from '../../lib/stakeView';
import type { StakeOutcome } from '../../lib/stakeView';
import type { DuelView, StakeView } from '../../lib/types';
import type { StakeCtx } from '../../lib/useStake';

export interface StakeResultProps {
  duel: DuelView;
  side: Side;
  ctx: StakeCtx;
  stake: StakeView;
  /** Hash of the claim tx this browser sent, kept by the parent. */
  claimTx: string | null;
  onClaimed: (hash: string) => void;
}

function outcomeText(outcome: StakeOutcome, stake: StakeView): string | null {
  if (outcome === 'win') return `You win ${formatMon(winnerPayoutWei(stake.amount))} MON`;
  if (outcome === 'lose') return 'Your stake goes to the winner.';
  if (outcome === 'refund') return 'Stakes are refunded.';
  return null;
}

/** Result screen, stake part: what happens to the MON, and the Claim button that pays it out. */
export function StakeResult({ duel, side, ctx, stake, claimTx, onClaimed }: StakeResultProps) {
  const me = side === 1 ? duel.p1 : duel.p2;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const claim = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await claimStake(actionDeps(ctx.config), duel.id);
      if (unmounted.current) return;
      onClaimed(result.hash);
      ctx.refresh();
    } catch (err) {
      if (unmounted.current) return;
      setError(toFriendly(err, { fn: 'claim' }));
    }
    if (!unmounted.current) setBusy(false);
  };

  const claimed = stake.claimed || claimTx !== null;
  if (claimed) {
    return (
      <section className="flex flex-col gap-2 rounded-card border border-line bg-surface-raised px-4 py-3">
        {claimTx !== null && <p className="title text-purple-ink">Claimed</p>}
        <p className="body text-ink">Stake settled onchain</p>
        {claimTx !== null && (
          <a
            href={explorerTx(claimTx)}
            target="_blank"
            rel="noopener noreferrer"
            className="data text-purple-ink underline"
          >
            View claim on MonadScan
          </a>
        )}
      </section>
    );
  }

  const text = outcomeText(stakeOutcome(duel, me, stake), stake);
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-surface-raised px-4 py-3">
      {text && <p className="title text-ink">{text}</p>}
      {error && <Notice>{error}</Notice>}
      <Button busy={busy} busyLabel="Claiming…" disabled={!duel.settled} onClick={() => void claim()}>
        Claim
      </Button>
    </section>
  );
}
