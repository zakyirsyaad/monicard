import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { Screen } from '../../components/Screen';
import { ensureFunds, joinDuel } from '../../lib/actions';
import { sameAddress } from '../../lib/duelView';
import { friendlyError, toFriendly } from '../../lib/errors';
import { shortHex } from '../../lib/format';
import { actionDeps } from '../../lib/player';
import type { Config, DuelView } from '../../lib/types';
import { CardSlot } from './CardSlot';

export interface JoinConfirmProps {
  duel: DuelView;
  myCardId: string;
  config: Config | null;
}

// Receipts carry no revert reason. A reverted join on a duel shown as Open means someone joined first.
const ALREADY_STARTED = friendlyError({ kind: 'reverted', fn: 'joinDuel', duelStatus: 'Active' });

export function JoinConfirm({ duel, myCardId, config }: JoinConfirmProps) {
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
        <Button busy={busy} busyLabel="Joining…" disabled={!config} onClick={() => void join()}>
          Join duel
        </Button>
      </div>
    </Screen>
  );
}
