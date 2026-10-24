import { formatInt } from '../lib/format';

export interface HpBarProps {
  side: 'self' | 'opponent';
  name: string;
  /** Chain value from the latest WebSocket message. */
  hp: number;
  maxHp: number;
  /** Estimated damage from txs not yet in a block. Subtracted ONLY here. */
  pendingDamage: number;
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

const FILL_TRANSITION = 'width 250ms ease-out, left 250ms ease-out';

export function HpBar({ side, name, hp, maxHp, pendingDamage }: HpBarProps) {
  const shownHp = Math.max(0, hp - pendingDamage);
  const toPct = (value: number): number => (maxHp > 0 ? clampPct((value / maxHp) * 100) : 0);
  const shownPct = toPct(shownHp);
  const chainPct = toPct(hp);
  const fillColor = side === 'self' ? 'bg-purple' : 'bg-berry';
  const numberColor = side === 'self' ? 'text-ink' : 'text-berry';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="title min-w-0 truncate text-ink">{name}</span>
        <span className={`data-lg shrink-0 ${numberColor}`}>
          {formatInt(shownHp)} / {formatInt(maxHp)}
        </span>
      </div>
      <div className="relative mt-2 h-3 overflow-hidden rounded-chip bg-surface-sunken">
        <div
          className={`absolute inset-y-0 left-0 ${fillColor}`}
          style={{ width: `${shownPct}%`, transition: FILL_TRANSITION }}
        />
        <div
          className={`absolute inset-y-0 opacity-40 ${fillColor}`}
          style={{ left: `${shownPct}%`, width: `${Math.max(0, chainPct - shownPct)}%`, transition: FILL_TRANSITION }}
        />
      </div>
    </div>
  );
}
