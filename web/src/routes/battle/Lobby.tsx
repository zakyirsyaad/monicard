import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { burnerAccount } from '../../lib/player';
import { shortHex } from '../../lib/format';
import { toFriendly } from '../../lib/errors';
import { useConfig } from '../../lib/useConfig';
import { battleAvailable, challengeBattleAgent, createBattle } from '../../lib/battle/actions';

type Busy = 'create' | 'agent' | null;

const RULES = [
  { n: '01', title: 'Draw', body: 'Every turn draws one random card. Ten per player, made onchain.' },
  { n: '02', title: 'Place', body: 'Hold cards in hand or place up to three on your board.' },
  { n: '03', title: 'Win', body: 'All board cards strike the front card. Two KOs win the match.' },
] as const;

function SharePanel({
  id,
  onFight,
  onNew,
  busy,
}: {
  id: string;
  onFight: () => void;
  onNew: () => void;
  busy: Busy;
}) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/battle/${id}`;

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
    <section className="flex flex-col gap-4 rounded-card border border-line bg-surface-raised p-4" aria-labelledby="room-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="room-title" className="title text-ink">
          Room ready
        </h2>
        <span className="data text-ink-muted">Match #{id}</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="shrink-0 rounded-card border border-line bg-surface p-2 text-ink">
          <QRCodeSVG value={link} size={124} fgColor="currentColor" bgColor="transparent" />
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
      <div className="flex flex-col gap-3">
        <Button onClick={() => navigate(`/battle/${id}`)}>Open match room</Button>
        <Button variant="secondary" busy={busy === 'agent'} busyLabel="AI Agent joining…" disabled={busy !== null} onClick={onFight}>
          Fight AI Agent
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={onNew}>
          New match
        </Button>
      </div>
    </section>
  );
}

export function BattleLobby() {
  const { config, failed } = useConfig();
  const [busy, setBusy] = useState<Busy>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address = burnerAccount().address;

  const available = battleAvailable(config);
  const ready = config !== null && available;
  const unavailable = failed || (config !== null && !available);

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<string | null>) => {
    if (busy || !config) return;
    setBusy(kind);
    setError(null);
    try {
      const id = await action();
      if (id !== null) setCreatedId(id);
    } catch (err) {
      setError(toFriendly(err, { fn: 'createMatch' }));
    } finally {
      setBusy(null);
    }
  };

  const create = () =>
    run('create', async () => {
      const result = await createBattle(config as NonNullable<typeof config>);
      return result.id;
    });

  const fightAgent = async () => {
    if (busy || !config) return;
    setBusy('agent');
    setError(null);
    try {
      const id = createdId ?? (await createBattle(config)).id;
      if (id === null) {
        setError("Couldn't create the match. Try again.");
        return;
      }
      setCreatedId(id);
      const result = await challengeBattleAgent(config, id);
      if (!result.ok) {
        if (result.reason === 'not_open' || result.reason === 'send_failed') setCreatedId(null);
        setError(
          result.reason === 'not_open'
            ? "The AI Agent couldn't join this room. Create a new one."
            : 'AI Agent is busy. Try again in a moment.',
        );
      }
    } catch {
      setError('AI Agent is busy. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-surface text-ink">
      <div className="mx-auto flex min-h-[100dvh] max-w-[420px] flex-col gap-6 px-4 py-6">
        <header className="flex flex-col gap-1">
          <p className="label text-ink-muted">Monicard</p>
          <h1 className="display">Card Battle</h1>
          <p className="body text-ink-muted">Best of 3 · two KOs win. Cards are drawn onchain for this match only.</p>
        </header>

        <section className="rounded-card border border-line bg-surface-raised" aria-label="How a match works">
          {RULES.map((rule, index) => (
            <div key={rule.n} className={`flex gap-4 p-4 ${index > 0 ? 'border-t border-line' : ''}`}>
              <span className="data shrink-0 text-ink-muted">{rule.n}</span>
              <div>
                <h2 className="title text-ink">{rule.title}</h2>
                <p className="body mt-1 text-ink-muted">{rule.body}</p>
              </div>
            </div>
          ))}
        </section>

        {error && <Notice>{error}</Notice>}
        {unavailable && (
          <Notice tone="info">
            {failed ? 'Cannot reach the game server. Retrying…' : 'Card Battle is not deployed on this network yet.'}
          </Notice>
        )}

        {createdId ? (
          <SharePanel
            id={createdId}
            busy={busy}
            onFight={() => void fightAgent()}
            onNew={() => {
              setCreatedId(null);
              setError(null);
            }}
          />
        ) : (
          <section className="mt-auto flex flex-col gap-3" aria-label="Start a match">
            <Button
              busy={busy === 'create'}
              busyLabel="Creating match…"
              disabled={!ready || busy !== null}
              onClick={() => void create()}
            >
              Create match
            </Button>
            <Button
              variant="secondary"
              busy={busy === 'agent'}
              busyLabel="AI Agent joining…"
              disabled={!ready || busy !== null}
              onClick={() => void fightAgent()}
            >
              Fight AI Agent
            </Button>
            <p className="data text-center text-ink-muted">
              Your wallet {shortHex(address)} · match cards do not touch your collection
            </p>
          </section>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-line pt-4">
          <Link to="/play" className="label text-ink-muted">
            ← Tap Blitz
          </Link>
          <span className="data text-ink-muted">Monad testnet</span>
        </footer>
      </div>
    </main>
  );
}
