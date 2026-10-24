import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import type { StakeCtx } from '../../lib/useStake';
import { CardSlot } from './CardSlot';
import { StakePanel } from './StakePanel';

const COPIED_MS = 1500;
const QR_SIZE = 240;

type CopyState = 'idle' | 'copied' | 'failed';

export interface WaitingRoomProps {
  duelId: string;
  myCardId: string;
  /** Set only when staking is enabled and this is a friend duel. */
  stakeCtx?: StakeCtx | null;
}

export function WaitingRoom({ duelId, myCardId, stakeCtx = null }: WaitingRoomProps) {
  const link = `${location.origin}/duel/${duelId}`;
  const [copy, setCopy] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = (state: CopyState) => {
    setCopy(state);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy('idle'), COPIED_MS);
  };

  const copyLink = () => {
    if (!navigator.clipboard) {
      flash('failed');
      return;
    }
    navigator.clipboard.writeText(link).then(
      () => flash('copied'),
      () => flash('failed'),
    );
  };

  const label = copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy link';

  return (
    <Screen>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="display">Waiting for opponent…</h1>
        <p className="body text-ink-muted">Open this link in your browser</p>
      </header>
      <div className="mx-auto rounded-card border border-line bg-surface-raised p-4 text-ink">
        <QRCodeSVG value={link} size={QR_SIZE} fgColor="currentColor" bgColor="transparent" />
      </div>
      <Button variant="secondary" onClick={copyLink}>
        {label}
      </Button>
      {stakeCtx && <StakePanel duelId={duelId} ctx={stakeCtx} />}
      <div className="mt-auto">
        <CardSlot id={myCardId} />
      </div>
    </Screen>
  );
}
