import { tileStatusText } from '../../lib/arenaView';
import { formatInt } from '../../lib/format';
import type { DuelView } from '../../lib/types';

const FILL_TRANSITION = 'width 250ms ease-out';

function MiniHp({ side, hp, maxHp, label }: { side: 'p1' | 'p2'; hp: number; maxHp: number; label: string }) {
  const pct = maxHp > 0 ? Math.min(100, Math.max(0, (hp / maxHp) * 100)) : 0;
  return (
    <div
      role="img"
      aria-label={`${label} ${formatInt(hp)} of ${formatInt(maxHp)} HP`}
      className="relative h-2 overflow-hidden rounded-chip bg-surface-sunken"
    >
      <div
        className={`absolute inset-y-0 left-0 ${side === 'p1' ? 'bg-purple' : 'bg-berry'}`}
        style={{ width: `${pct}%`, transition: FILL_TRANSITION }}
      />
    </div>
  );
}

export function SwarmGrid({ duels, block }: { duels: readonly DuelView[]; block: number }) {
  if (duels.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="label text-ink-muted">Live duels</h2>
      <ul className="grid grid-cols-4 gap-4 xl:grid-cols-6">
        {duels.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 rounded-card border border-line bg-surface-raised p-3">
            <span className="data text-ink">#{d.id}</span>
            <MiniHp side="p1" hp={d.hp1} maxHp={d.maxHp1} label="P1" />
            <MiniHp side="p2" hp={d.hp2} maxHp={d.maxHp2} label="P2" />
            <span className="data text-ink-muted">{tileStatusText(d, block)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
