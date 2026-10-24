import { useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { shortHex } from '../../lib/format';
import type { BattleSide, MatchView } from '../../lib/battle/types';

export type OpenRoomProps = {
  match: MatchView;
  side: BattleSide | null;
  busy: 'join' | 'agent' | null;
  error: string | null;
  onJoin: () => void;
  onFightAgent: () => void;
};

/** An Open match: the creator shares a QR, everyone else joins from the same link. */
export function OpenRoom({ match, side, busy, error, onJoin, onFightAgent }: OpenRoomProps) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/battle/${match.id}`;
  const isCreator = side === 1;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-surface text-ink">
      <div className="mx-auto flex min-h-[100dvh] max-w-[420px] flex-col gap-6 px-4 py-6">
        <header className="flex items-center justify-between gap-3">
          <Link to="/battle" className="label text-ink-muted">
            ← Card Battle
          </Link>
          <span className="data text-ink-muted">Match #{match.id}</span>
        </header>

        <div className="flex flex-col gap-1">
          <p className="label text-ink-muted">{isCreator ? 'Your room' : 'Open match'}</p>
          <h1 className="display">{isCreator ? 'Waiting for an opponent' : 'Join this match'}</h1>
          <p className="body text-ink-muted">
            {isCreator
              ? 'Share the link or let the AI Agent take the other side.'
              : `${shortHex(match.p1)} is waiting. Cards are drawn onchain when you join.`}
          </p>
        </div>

        {isCreator ? (
          <section className="flex flex-col gap-4 rounded-card border border-line bg-surface-raised p-4" aria-label="Invite an opponent">
            <div className="flex items-center gap-4">
              <div className="shrink-0 rounded-card border border-line bg-surface p-2 text-ink">
                <QRCodeSVG value={link} size={128} fgColor="currentColor" bgColor="transparent" />
              </div>
              <div className="min-w-0">
                <p className="label text-ink-muted">Invite link</p>
                <p className="body break-all text-ink">{link}</p>
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="label mt-2 rounded-chip border border-line px-3 py-2 text-ink [touch-action:manipulation]"
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
            <Button busy={busy === 'agent'} busyLabel="AI Agent joining…" disabled={busy !== null} onClick={onFightAgent}>
              Fight AI Agent
            </Button>
          </section>
        ) : (
          <section className="flex flex-col gap-3 rounded-card border border-line bg-surface-raised p-4" aria-label="Join match">
            <div className="flex items-baseline justify-between gap-3">
              <span className="label text-ink-muted">Creator</span>
              <span className="data text-ink">{shortHex(match.p1)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="label text-ink-muted">Format</span>
              <span className="data text-ink">Best of 3 · 2 KOs</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="label text-ink-muted">Cards</span>
              <span className="data text-ink">10 draws each · onchain</span>
            </div>
            <Button busy={busy === 'join'} busyLabel="Joining…" disabled={busy !== null} onClick={onJoin}>
              Join match
            </Button>
          </section>
        )}

        {error && <Notice>{error}</Notice>}

        <p className="body mt-auto text-center text-ink-muted">
          Both players draw one card when the match starts. The first turn is drawn at random.
        </p>
      </div>
    </main>
  );
}
