import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { toFriendly } from '../../lib/errors';
import { actionDeps } from '../../lib/player';
import { stakeOnDuel } from '../../lib/stakeFlows';
import { STAKE_CHOICES_WEI, formatMon } from '../../lib/stakeView';
import type { StakeCtx } from '../../lib/useStake';

const DEFAULT_CHOICE = 1;

export interface StakePanelProps {
  duelId: string;
  ctx: StakeCtx;
}

/** p1 in the waiting room: optionally stake before the opponent joins. */
export function StakePanel({ duelId, ctx }: StakePanelProps) {
  const [choice, setChoice] = useState<bigint>(STAKE_CHOICES_WEI[DEFAULT_CHOICE] ?? 0n);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remembered after our own tx so the panel does not flicker back while the chain read catches up.
  const [stakedWei, setStakedWei] = useState<bigint | null>(null);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const amount = ctx.stake?.p1Staked ? ctx.stake.amount : stakedWei;
  if (amount !== null) {
    return (
      <p className="body rounded-card border border-line bg-surface-raised px-4 py-3 text-ink">
        You staked {formatMon(amount)} MON. Your opponent must match it.
      </p>
    );
  }

  const stake = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await stakeOnDuel(actionDeps(ctx.config), duelId, choice);
      if (unmounted.current) return;
      setStakedWei(choice);
      ctx.refresh();
    } catch (err) {
      if (unmounted.current) return;
      setError(toFriendly(err, { fn: 'stake' }));
    }
    if (!unmounted.current) setBusy(false);
  };

  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-surface-raised px-4 py-3">
      <h2 className="title text-ink">Add a stake (optional)</h2>
      <div className="flex gap-2">
        {STAKE_CHOICES_WEI.map((wei) => (
          <button
            key={wei.toString()}
            type="button"
            aria-pressed={wei === choice}
            disabled={busy}
            onClick={() => setChoice(wei)}
            className={`data rounded-chip px-3 py-2 [touch-action:manipulation] ${
              wei === choice ? 'bg-purple-tint text-purple-ink' : 'bg-surface-sunken text-ink'
            }`}
          >
            {formatMon(wei)} MON
          </button>
        ))}
      </div>
      {error && <Notice>{error}</Notice>}
      <Button variant="secondary" busy={busy} busyLabel="Staking…" onClick={() => void stake()}>
        Stake {formatMon(choice)} MON
      </Button>
    </section>
  );
}
