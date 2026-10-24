import { winratePct } from '../../lib/arenaView';
import { formatInt } from '../../lib/format';
import type { AgentLesson, AgentMsg } from '../../lib/types';

const PANEL = 'rounded-card border border-line bg-surface-raised p-6';
const MAX_LESSONS = 5;

const newestFirst = (lessons: readonly AgentLesson[]): AgentLesson[] =>
  [...lessons].sort((a, b) => b.at - a.at).slice(0, MAX_LESSONS);

export function AgentPanel({ agent }: { agent: AgentMsg | null }) {
  if (!agent) {
    return (
      <section className={PANEL}>
        <h2 className="title text-ink">AI Agent</h2>
        <p className="body mt-2 text-ink-muted">AI Agent is warming up…</p>
      </section>
    );
  }

  const winrate = winratePct(agent.testnet.wins, agent.testnet.duels);
  const lessons = newestFirst(agent.lessons);

  return (
    <section className={`${PANEL} flex flex-col gap-4`}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="title text-ink">AI Agent</h2>
        <span className="data-lg text-purple-ink">Lv.{agent.level}</span>
      </div>
      <div className="flex flex-col gap-1">
        {winrate !== null && <p className="data-lg text-ink">{winrate}% win rate</p>}
        <p className="data text-ink-muted">
          Simulated: {formatInt(agent.sim.duels)} duels · Testnet: {formatInt(agent.testnet.duels)} onchain duels
        </p>
        <p className="data text-ink-muted">Skill threshold {agent.threshold}%</p>
      </div>
      {lessons.length > 0 && (
        <ul className="flex flex-col gap-3 border-t border-line pt-4">
          {lessons.map((lesson) => (
            <li key={`${lesson.duelId}-${lesson.at}`}>
              <p className="body text-ink">{lesson.text}</p>
              <p className="data text-ink-muted">
                {lesson.thresholdFrom}% → {lesson.thresholdTo}%
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
