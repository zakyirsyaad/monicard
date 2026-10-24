import { ELEMENT_NAMES, RARITY_NAMES, elementTextClass, rarityBorderClass, rarityTextClass } from '../../lib/labels';
import { formatInt } from '../../lib/format';
import type { DrawCard } from '../../lib/battle/rules';

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

export type BoardCardProps = {
  card: DrawCard | null;
  side: 'self' | 'opponent';
  /** The front card is the only legal target for the other side. */
  target?: boolean;
  slot: number;
};

/** One of the six board slots. Empty slots keep the full height so the board never jumps. */
export function BoardCard({ card, side, target = false, slot }: BoardCardProps) {
  if (card === null) {
    return (
      <div
        className="flex h-[120px] items-center justify-center rounded-card border border-dashed border-line bg-surface"
        aria-label={`Empty board slot ${slot + 1}`}
      >
        <span className="label text-ink-muted">Empty</span>
      </div>
    );
  }

  const pct = card.maxHp > 0 ? clampPct((card.hp / card.maxHp) * 100) : 0;
  const fill = side === 'self' ? 'bg-purple' : 'bg-berry';
  const hpTone = side === 'self' ? 'text-ink' : 'text-berry';
  const border = rarityBorderClass[card.rarity] ?? rarityBorderClass[0];
  const element = elementTextClass[card.element] ?? elementTextClass[0];

  return (
    <div className={`relative flex h-[120px] min-w-0 flex-col rounded-card border-2 bg-surface-raised p-1.5 ${border}`}>
      {target && (
        <span className="absolute -top-2 left-1/2 z-10 -translate-x-1/2 rounded-chip bg-berry px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-on-deep">
          Target
        </span>
      )}
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate text-[11px] font-semibold leading-tight text-ink">{card.nadmon.name}</span>
        <span className={`shrink-0 text-[9px] font-semibold uppercase ${element}`}>
          {ELEMENT_NAMES[card.element] ?? ELEMENT_NAMES[0]}
        </span>
      </div>
      <img
        src={`/nadmon/${card.nadmon.id}.svg`}
        alt={card.nadmon.name}
        width={240}
        height={150}
        className="mt-0.5 h-9 w-full object-contain"
      />
      <div className="mt-auto">
        <div className="h-1.5 overflow-hidden rounded-chip bg-surface-sunken">
          <div className={`h-full ${fill}`} style={{ width: `${pct}%`, transition: 'width 250ms ease-out' }} />
        </div>
        <div className="mt-0.5 flex items-baseline justify-between font-mono text-[10px] tabular-nums">
          <span className={hpTone}>{formatInt(card.hp)}</span>
          <span className="text-ink-muted">ATK {card.atk}</span>
        </div>
      </div>
    </div>
  );
}

export type HandCardProps = {
  card: DrawCard;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
};

/** A card in hand: tap to mark it for the next placement. */
export function HandCard({ card, selected, disabled, onSelect }: HandCardProps) {
  const border = selected ? 'border-purple bg-purple-tint' : `${rarityBorderClass[card.rarity] ?? rarityBorderClass[0]} bg-surface-raised`;
  const element = elementTextClass[card.element] ?? elementTextClass[0];

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${card.nadmon.name}, ${ELEMENT_NAMES[card.element] ?? 'Fire'}, ATK ${card.atk}, HP ${formatInt(card.hp)}${
        selected ? ', selected to place' : ''
      }`}
      disabled={disabled}
      onClick={onSelect}
      className={`relative flex h-[132px] w-[92px] shrink-0 flex-col rounded-card border-2 p-1.5 text-left [touch-action:manipulation] disabled:opacity-40 ${border}`}
    >
      {selected && (
        <span className="absolute -top-2 left-1/2 z-10 -translate-x-1/2 rounded-chip bg-purple px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-on-purple">
          Place
        </span>
      )}
      <div className="flex items-center justify-between gap-1">
        <span className={`truncate text-[9px] font-semibold uppercase ${element}`}>
          {ELEMENT_NAMES[card.element] ?? ELEMENT_NAMES[0]}
        </span>
        <span className={`shrink-0 text-[9px] font-semibold uppercase ${rarityTextClass[card.rarity] ?? ''}`}>
          {RARITY_NAMES[card.rarity] ?? RARITY_NAMES[0]}
        </span>
      </div>
      <img
        src={`/nadmon/${card.nadmon.id}.svg`}
        alt=""
        width={240}
        height={150}
        className="mt-1 h-12 w-full object-contain"
        aria-hidden="true"
      />
      <p className="mt-1 truncate text-[12px] font-semibold leading-tight text-ink">{card.nadmon.name}</p>
      <div className="mt-auto flex items-baseline justify-between font-mono text-[10px] tabular-nums">
        <span className="text-ink">ATK {card.atk}</span>
        <span className="text-ink-muted">HP {formatInt(card.hp)}</span>
      </div>
    </button>
  );
}

export type PileProps = {
  count: number;
  side: 'self' | 'opponent';
};

/** Closed pile: the card back, the remaining count, and a small leaving-card effect when a draw lands. */
export function Pile({ count, side }: PileProps) {
  return (
    <div
      className="relative w-[52px] shrink-0"
      aria-label={`${side === 'self' ? 'Your' : 'Opponent'} deck, ${count} cards left`}
    >
      <div className="absolute inset-x-1 top-1 h-full rounded-card border border-line bg-surface-sunken" aria-hidden="true" />
      <div className="absolute inset-x-0 top-0 flex h-[108px] flex-col items-center justify-center rounded-card border-2 border-line bg-surface-raised px-1">
        <span className="label text-center text-[9px] leading-tight text-ink-muted">Deck</span>
        <span className="font-mono text-lg font-semibold leading-tight tabular-nums text-ink">{count}</span>
        <span className="text-[9px] leading-tight text-ink-muted">left</span>
      </div>
    </div>
  );
}

export type ScoreDotsProps = {
  filled: number;
  side: 'self' | 'opponent';
};

/** Two pips per player: first to two KOs wins. */
export function ScoreDots({ filled, side }: ScoreDotsProps) {
  const tone = side === 'self' ? 'bg-purple' : 'bg-berry';
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${filled} of 2 rounds won`}>
      {[0, 1].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${i < filled ? tone : 'border border-line bg-surface-sunken'}`}
        />
      ))}
    </span>
  );
}
