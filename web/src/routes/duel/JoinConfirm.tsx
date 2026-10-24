import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { Screen } from '../../components/Screen';
import { ensureFunds, joinDuel } from '../../lib/actions';
import { sameAddress } from '../../lib/duelView';
import { friendlyError, toFriendly } from '../../lib/errors';
import { RevertedError } from '../../lib/actions';
import { shortHex } from '../../lib/format';
import { actionDeps } from '../../lib/player';
import { joinAndStake } from '../../lib/stakeFlows';
import { formatMon, hasStake } from '../../lib/stakeView';
import type { Config, DuelView } from '../../lib/types';
import type { StakeCtx } from '../../lib/useStake';
import { CardSlot } from './CardSlot';
import { NO_STAKE_JOIN, STAKING_CLOSED_NOTICE } from './StakeLine';
import type { StakeJoin } from './StakeLine';

export interface JoinConfirmProps {
  duel: DuelView;
  myCardId: string;
  config: Config | null;
  /** Set only when staking is enabled and this is a friend duel. */
  stakeCtx?: StakeCtx | null;
  /** Progress of join-and-stake, kept by the parent because this screen unmounts once the duel starts. */
  onStakeJoin?: (state: StakeJoin) => void;
}

// Receipts carry no revert reason. A reverted join on a duel shown as Open means someone joined first.
const ALREADY_STARTED = friendlyError({ kind: 'reverted', fn: 'joinDuel', duelStatus: 'Active' });

export function JoinConfirm({ duel, myCardId, config, stakeCtx = null, onStakeJoin = () => undefined }: JoinConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opponent = config && sameAddress(duel.p1, config.agent) ? 'AI Agent' : shortHex(duel.p1);

  // Unmounted (the socket moved the duel on): stop before sending and never set state afterwards.
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const fail = (message: string) => {
    if (unmounted.current) return;
    setError(message);
    setBusy(false);
  };

  const join = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    try {
      const deps = actionDeps(config);
      await ensureFunds(deps, deps.account.address);
      if (unmounted.current) return;
      const result = await joinDuel(deps, duel.id, myCardId);
      // Success: the socket flips the duel to Active and Duel moves to the countdown.
      if (result.status !== 'success') fail(ALREADY_STARTED);
    } catch (err) {
      fail(toFriendly(err, { fn: 'joinDuel' }));
    }
  };

  // Join, then stake during the countdown. The stake outcome is reported upward, never to this screen.
  const joinAndMatch = async (amount: bigint) => {
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await joinAndStake(actionDeps(config), duel.id, myCardId, amount, () =>
        onStakeJoin({ staking: amount, notice: null }),
      );
      if (!res.joined) return fail(ALREADY_STARTED);
      if (res.staked) {
        onStakeJoin(NO_STAKE_JOIN);
        stakeCtx?.refresh();
        return;
      }
      const notice = res.error instanceof RevertedError ? STAKING_CLOSED_NOTICE : toFriendly(res.error, { fn: 'stake' });
      onStakeJoin({ staking: null, notice });
    } catch (err) {
      fail(toFriendly(err, { fn: 'joinDuel' }));
    }
  };

  const matchWei = stakeCtx && hasStake(stakeCtx.stake) && stakeCtx.stake.p1Staked && !stakeCtx.stake.claimed ? stakeCtx.stake.amount : null;

  return (
    <Screen>
      <h1 className="display">Join duel vs {opponent}</h1>
      <div className="flex flex-col gap-3">
        <CardSlot id={String(duel.card1)} />
        <p className="label text-center text-ink-muted">vs</p>
        <CardSlot id={myCardId} />
      </div>
      <div className="mt-auto flex flex-col gap-3">
        {error && <Notice>{error}</Notice>}
        {matchWei !== null && (
          <>
            <p className="data text-center text-ink">Stake to match: {formatMon(matchWei)} MON</p>
            <Button busy={busy} busyLabel="Joining…" disabled={!config} onClick={() => void joinAndMatch(matchWei)}>
              Join and stake {formatMon(matchWei)} MON
            </Button>
          </>
        )}
        <Button
          variant={matchWei !== null ? 'secondary' : 'primary'}
          busy={busy && matchWei === null}
          busyLabel="Joining…"
          disabled={!config || busy}
          onClick={() => void join()}
        >
          {matchWei !== null ? 'Join without stake' : 'Join duel'}
        </Button>
      </div>
    </Screen>
  );
}
