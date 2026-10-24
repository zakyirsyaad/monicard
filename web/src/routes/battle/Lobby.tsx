import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { burnerAccount } from '../../lib/player';
import { shortHex } from '../../lib/format';
import { battleErrorText } from '../../lib/battle/errors';
import type { WalletStep } from '../../lib/battle/fund';
import { useConfig } from '../../lib/useConfig';
import { battleStakeAvailable, monLabel, prepareBattleStake, stakeBattle } from '../../lib/battle/stake';
import { StakeChips } from './StakeChips';
import { battleAvailable, challengeBattleAgent, createBattle } from '../../lib/battle/actions';
import { NETWORK } from '../../lib/network';

type Busy = 'create' | 'agent' | null;

const RULES = [
  { n: '01', title: 'Draw', body: 'Every turn draws one random card. Ten per player, made onchain.' },
  { n: '02', title: 'Place', body: 'Hold cards in hand or place up to three on your board.' },
  { n: '03', title: 'Win', body: 'All board cards strike the front card. Two KOs win the match.' },
] as const;

function SharePanel({
  id,
  stakeWei,
  onFight,
  onNew,
  busy,
}: {
  id: string;
  /** The creator's stake in wei; 0 for a free match. */
  stakeWei: bigint;
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
      {stakeWei > 0n && <p className="data text-ink">Stake {monLabel(stakeWei)} MON</p>}
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
        {stakeWei === 0n && (
          <Button variant="secondary" busy={busy === 'agent'} busyLabel="AI Agent joining…" disabled={busy !== null} onClick={onFight}>
            Fight AI Agent
          </Button>
        )}
        <Button variant="secondary" disabled={busy !== null} onClick={onNew}>
          New match
        </Button>
      </div>
    </section>
  );
}

export function BattleLobby() {
  const navigate = useNavigate();
  const { config, failed } = useConfig();
  const [busy, setBusy] = useState<Busy>(null);
  const [phase, setPhase] = useState<WalletStep>('send');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [stakeWei, setStakeWei] = useState<bigint>(0n);
  const [createdStake, setCreatedStake] = useState<bigint>(0n);
  const [staking, setStaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = burnerAccount().address;

  const available = battleAvailable(config);
  const ready = config !== null && available;
  const unavailable = failed || (config !== null && !available);
  const walletLabel = (normal: string): string =>
    phase === 'wallet' ? 'Preparing your wallet…' : staking ? `Staking ${monLabel(stakeWei)} MON…` : normal;

  /** Free matches take exactly the old path. A stake adds funding up front and one stake tx after the create. */
  const create = async () => {
    if (busy || !config) return;
    const chosen = battleStakeAvailable(config) ? stakeWei : 0n;
    setBusy('create');
    setPhase('wallet');
    setError(null);
    let id: string | null = null;
    try {
      if (chosen > 0n) await prepareBattleStake(config, chosen, (step) => setPhase(step));
      id = (await createBattle(config, (step) => setPhase(step))).id;
      if (id === null) {
        setError("Couldn't create the match. Try again.");
        return;
      }
      setCreatedId(id);
      setCreatedStake(0n);
      if (chosen > 0n) {
        setStaking(true);
        await stakeBattle(config, id, chosen);
        setCreatedStake(chosen);
      }
    } catch (err) {
      const text = battleErrorText(err, { fn: id === null ? 'createMatch' : 'battleStake' });
      setError(id === null ? text : `${text} The match is open without a stake.`);
    } finally {
      setStaking(false);
      setBusy(null);
      setPhase('send');
    }
  };

  const fightAgent = async () => {
    if (busy || !config) return;
    setBusy('agent');
    setPhase('wallet');
    setError(null);
    try {
      const id = createdId ?? (await createBattle(config, (step) => setPhase(step))).id;
      if (id === null) {
        setError("Couldn't create the match. Try again.");
        return;
      }
      setCreatedId(id);
      setPhase('send');
      const result = await challengeBattleAgent(config, id);
      if (result.ok) {
        navigate(`/battle/${id}`);
        return;
      }
      if (result.reason === 'not_open' || result.reason === 'send_failed') setCreatedId(null);
      setError(
        result.reason === 'not_open'
          ? "The AI Agent couldn't join this room. Create a new one."
          : 'AI Agent is busy. Try again in a moment.',
      );
    } catch (err) {
      setError(battleErrorText(err, { fn: 'createMatch' }));
    } finally {
      setBusy(null);
      setPhase('send');
    }
  };

  return (
    <main className="min-h-[100dvh] bg-surface text-ink">
      <div className="mx-auto flex min-h-[100dvh] max-w-[420px] flex-col gap-6 px-4 py-6">
        <header className="flex flex-col gap-1">
          <Link to="/" className="label text-ink-muted underline underline-offset-4">
            Monicard
          </Link>
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
            stakeWei={createdStake}
            busy={busy}
            onFight={() => void fightAgent()}
            onNew={() => {
              setCreatedId(null);
              setCreatedStake(0n);
              setError(null);
            }}
          />
        ) : (
          <section className="mt-auto flex flex-col gap-3" aria-label="Start a match">
            <StakeChips config={config} value={stakeWei} onChange={setStakeWei} disabled={busy !== null} />
            <Button
              busy={busy === 'create'}
              busyLabel={walletLabel('Creating match…')}
              disabled={!ready || busy !== null}
              onClick={() => void create()}
            >
              {stakeWei > 0n && battleStakeAvailable(config) ? `Create and stake ${monLabel(stakeWei)} MON` : 'Create match'}
            </Button>
            <Button
              variant="secondary"
              busy={busy === 'agent'}
              busyLabel={walletLabel('AI Agent joining…')}
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
          <span className="data text-ink-muted">{NETWORK.label}</span>
        </footer>
      </div>
    </main>
  );
}
