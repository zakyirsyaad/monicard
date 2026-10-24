import { HpBar } from '../../components/HpBar';
import { duelStatusText, sideLabel } from '../../lib/arenaView';
import type { Config, DuelView } from '../../lib/types';
import { CardSlot } from '../duel/CardSlot';

export interface FeaturedDuelProps {
  duel: DuelView | null;
  config: Config;
  block: number;
}

const PANEL = 'rounded-card border border-line bg-surface-raised p-6';

function statusColor(status: DuelView['status']): string {
  if (status === 'P1Won') return 'text-purple-ink';
  if (status === 'P2Won') return 'text-berry';
  return 'text-ink';
}

export function FeaturedDuel({ duel, config, block }: FeaturedDuelProps) {
  if (!duel) {
    return (
      <section className={`${PANEL} flex min-h-[320px] items-center justify-center`}>
        <p className="display text-ink-muted">Waiting for the next duel…</p>
      </section>
    );
  }

  const open = duel.status === 'Open';
  const labels = {
    p1: sideLabel(duel.p1, config.agent),
    p2: open ? 'Waiting…' : sideLabel(duel.p2, config.agent),
  };

  return (
    <section className={`${PANEL} flex flex-col gap-6`}>
      <div className="flex items-baseline justify-between gap-4">
        <span className="data text-ink-muted">Duel #{duel.id}</span>
        {duel.settled && <span className="data text-ink-muted">Settled onchain</span>}
      </div>
      <div className="grid grid-cols-2 gap-8">
        <div className="flex flex-col gap-4">
          <HpBar side="self" size="lg" name={labels.p1} hp={duel.hp1} maxHp={duel.maxHp1} pendingDamage={0} />
          <CardSlot key={duel.card1} id={duel.card1 > 0 ? String(duel.card1) : null} />
        </div>
        <div className="flex flex-col gap-4">
          <HpBar side="opponent" size="lg" name={labels.p2} hp={duel.hp2} maxHp={duel.maxHp2} pendingDamage={0} />
          <CardSlot key={duel.card2} id={duel.card2 > 0 ? String(duel.card2) : null} />
        </div>
      </div>
      <p className={`display text-center ${statusColor(duel.status)}`}>{duelStatusText(duel, block, labels)}</p>
    </section>
  );
}
