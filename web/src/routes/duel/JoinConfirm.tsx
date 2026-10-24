import { useState } from 'react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { Screen } from '../../components/Screen';
import { ensureFunds, joinDuel } from '../../lib/actions';
import { sameAddress } from '../../lib/duelView';
import { friendlyError, toFriendly } from '../../lib/errors';
import { shortHex } from '../../lib/format';
import { actionDeps } from '../../lib/player';
import type { Config, DuelStatus, DuelView } from '../../lib/types';
import { CardSlot } from './CardSlot';

export interface JoinConfirmProps {
  duel: DuelView;
  myCardId: string;
  config: Config | null;
  /** Latest duel status from the socket, read after the join tx comes back. */
  latestStatus: () => DuelStatus | undefined;
}

export function JoinConfirm({ duel, myCardId, config, latestStatus }: JoinConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opponent = config && sameAddress(duel.p1, config.agent) ? 'AI Agent' : shortHex(duel.p1);

  const join = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    try {
      const deps = actionDeps(config);
      await ensureFunds(deps, deps.account.address);
      const result = await joinDuel(deps, duel.id, myCardId);
      if (result.status !== 'success') {
        setError(friendlyError({ kind: 'reverted', fn: 'joinDuel', duelStatus: latestStatus() }));
        setBusy(false);
      }
      // Success: the socket flips the duel to Active and the screen moves to the countdown.
    } catch (err) {
      setError(toFriendly(err, { fn: 'joinDuel', duelStatus: latestStatus() }));
      setBusy(false);
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
