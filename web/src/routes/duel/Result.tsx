import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { Screen } from '../../components/Screen';
import { api } from '../../lib/api';
import { otherSide, outcome, sideStats } from '../../lib/duelView';
import type { Outcome, Side } from '../../lib/duelView';
import { friendlyError, toFriendly } from '../../lib/errors';
import { startDuel } from '../../lib/flows';
import { explorerTx, formatInt, formatMs, formatRecord } from '../../lib/format';
import { actionDeps } from '../../lib/player';
import type { TxStats } from '../../lib/txEngine';
import type { AgentMsg, Config, DuelView } from '../../lib/types';
import { useCard } from './useCard';

const HEADLINE_COLOR: Record<Outcome, string> = {
  Victory: 'text-purple-ink',
  Defeat: 'text-berry',
  Draw: 'text-ink',
};

export interface ResultProps {
  duel: DuelView;
  side: Side;
  config: Config | null;
  vsAgent: boolean;
  agent: AgentMsg | null;
  stats: TxStats | null;
}

function Summary({ duel, side, stats }: { duel: DuelView; side: Side; stats: TxStats | null }) {
  const opp = sideStats(duel, otherSide(side));
  const sent = stats !== null && stats.txCount > 0 ? stats : null;
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-raised px-4 py-3">
      <p className="data text-ink">Damage dealt {formatInt(opp.maxHp - opp.hp)}</p>
      {sent && <p className="data text-ink">Onchain tx {formatInt(sent.txCount)}</p>}
      {sent && <p className="data text-ink">Avg latency {formatMs(sent.avgLatencyMs)}</p>}
      {sent?.lastTxHash && (
        <a
          href={explorerTx(sent.lastTxHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="data text-purple-ink underline"
        >
          View last tx on MonadScan
        </a>
      )}
    </div>
  );
}

function Record({ duel, side }: { duel: DuelView; side: Side }) {
  // Fetched only once settled, so the record already includes this duel.
  const card = useCard(duel.settled ? String(sideStats(duel, side).card) : null);
  if (!duel.settled) return <p className="body text-ink-muted">Recording result onchain…</p>;
  if (!card) return null;
  return <p className="data text-ink">Record {formatRecord(card.wins, card.losses)}</p>;
}

function Lesson({ agent, duelId }: { agent: AgentMsg | null; duelId: string }) {
  // The agent message keeps the latest lessons first; nothing is rendered until (or unless) ours arrives.
  const lesson = agent?.lessons.find((l) => l.duelId === duelId);
  if (!lesson) return null;
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-surface-raised px-4 py-3">
      <h2 className="title text-ink">AI Agent learned</h2>
      <p className="body text-ink">{lesson.text}</p>
      <p className="data text-ink-muted">
        Skill threshold {lesson.thresholdFrom}% → {lesson.thresholdTo}%
      </p>
    </section>
  );
}

export function Result({ duel, side, config, vsAgent, agent, stats }: ResultProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A rematch duel whose agent challenge was refused: retries reuse it.
  const rematchId = useRef<string | null>(null);
  const result = outcome(duel, side);

  const rematch = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    try {
      rematchId.current ??= await startDuel(actionDeps(config), String(sideStats(duel, side).card));
      const id = rematchId.current;
      if (!vsAgent) return navigate(`/duel/${id}`);
      const res = await api.challengeAgent(id);
      if (res.ok) return navigate(`/duel/${id}`);
      if (res.reason === 'not_open' || res.reason === 'stale') rematchId.current = null;
      setError(friendlyError({ kind: 'agent', reason: res.reason }));
    } catch (err) {
      setError(toFriendly(err, { fn: 'createDuel' }));
    }
    setBusy(false);
  };

  return (
    <Screen>
      <h1 className={`display-tap text-center ${result ? HEADLINE_COLOR[result] : 'text-ink'}`}>
        {result ?? "Time's up"}
      </h1>
      <Summary duel={duel} side={side} stats={stats} />
      <Record duel={duel} side={side} />
      {vsAgent && duel.settled && <Lesson agent={agent} duelId={duel.id} />}
      <div className="mt-auto flex flex-col gap-3">
        {error && <Notice>{error}</Notice>}
        <Button busy={busy} busyLabel="Creating duel…" disabled={!config} onClick={() => void rematch()}>
          Rematch
        </Button>
        <Button variant="secondary" onClick={() => navigate('/play')}>
          Back to Play
        </Button>
      </div>
    </Screen>
  );
}
