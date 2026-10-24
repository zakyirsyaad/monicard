import { ELEMENT_NAMES, RARITY_NAMES, elementTextClass, rarityBorderClass, rarityTextClass } from '../../lib/labels';
import { formatInt } from '../../lib/format';
import type { DrawCard } from '../../lib/battle/rules';

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

export type BoardCardProps = {
  card: DrawCard | null;
  side: 'self' | 'opponent';
  /** The front card is the only legal target for the other side. */
  target?: boolean;
  /** The front card on your own board: it is the card the opponent will hit. */
  front?: boolean;
  slot: number;
};

/** One of the six board slots. Empty slots keep the full height so the board never jumps. */
export function BoardCard({ card, side, target = false, front = false, slot }: BoardCardProps) {
  if (card === null) {
    return (
      <div
        className="flex h-[124px] items-center justify-center rounded-card border border-dashed border-line bg-surface"
        aria-label={`Empty board slot ${slot + 1}`}
      >
        <span className="label text-ink-muted">Empty</span>
      </div>
    );
  }

  const pct = card.maxHp > 0 ? clampPct((card.hp / card.maxHp) * 100) : 0;
  const fill = side === 'self' ? 'bg-purple' : 'bg-berry';
  const hpTone = side === 'self' ? 'text-purple-ink' : 'text-berry';
  const border = rarityBorderClass[card.rarity] ?? rarityBorderClass[0];
  const element = elementTextClass[card.element] ?? elementTextClass[0];

  return (
    <div
      className={`board-deal relative flex h-[124px] min-w-0 flex-col rounded-card border-2 bg-surface-raised p-1.5 ${border} ${
        target ? 'outline outline-2 -outline-offset-2 outline-berry' : ''
      }`}
    >
      {target && (
        <span className="absolute -top-2 left-1/2 z-10 -translate-x-1/2 rounded-chip bg-berry px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-on-deep">
          Target
        </span>
      )}
      {front && (
        <span className="absolute -top-2 left-1/2 z-10 -translate-x-1/2 rounded-chip bg-purple-tint px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-purple-ink">
          Front
        </span>
      )}
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold leading-tight text-ink">{card.nadmon.name}</p>
          <p className={`text-[8px] font-semibold uppercase tracking-wide ${element}`}>
            {ELEMENT_NAMES[card.element] ?? ELEMENT_NAMES[0]}
          </p>
        </div>
        <p className={`shrink-0 font-mono text-[16px] font-semibold leading-none tabular-nums ${hpTone}`} aria-label={`${card.hp} HP`}>
          {formatInt(card.hp)}
        </p>
      </div>
      <img
        src={`/nadmon/${card.nadmon.id}.svg`}
        alt=""
        width={240}
        height={150}
        className="mt-0.5 h-8 w-full object-contain"
        aria-hidden="true"
      />
      <div className="mt-auto">
        <div className="h-1.5 overflow-hidden rounded-chip bg-surface-sunken" aria-hidden="true">
          <div className={`h-full ${fill}`} style={{ width: `${pct}%`, transition: 'width 250ms ease-out' }} />
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-1 font-mono text-[9px] tabular-nums">
          <span className="text-ink-muted">ATK {card.atk}</span>
          <span className="text-ink-muted">{card.hp <= 0 ? 'KO' : 'HP'}</span>
        </div>
      </div>
    </div>
  );
}

export type HandCardProps = {
  card: DrawCard;
  selected: boolean;
  disabled: boolean;
  /** Drawn since your last action: keeps the NEW badge until you act. */
  isNew?: boolean;
  onSelect: () => void;
};

/** A card in hand: tap to mark it for the next placement. */
export function HandCard({ card, selected, disabled, isNew = false, onSelect }: HandCardProps) {
  const border = selected
    ? 'border-purple bg-purple-tint'
    : `${rarityBorderClass[card.rarity] ?? rarityBorderClass[0]} bg-surface-raised`;
  const element = elementTextClass[card.element] ?? elementTextClass[0];

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${card.nadmon.name}, ${ELEMENT_NAMES[card.element] ?? 'Fire'}, ATK ${card.atk}, HP ${formatInt(card.hp)}${
        isNew ? ', new card' : ''
      }${selected ? ', selected to place' : ''}`}
      disabled={disabled}
      onClick={onSelect}
      className={`relative flex h-[136px] w-[96px] shrink-0 flex-col rounded-card border-2 p-1.5 text-left [touch-action:manipulation] disabled:opacity-40 ${border}`}
    >
      {isNew && !selected && (
        <span className="absolute -top-2 left-1/2 z-10 -translate-x-1/2 rounded-chip bg-purple px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-on-purple">
          New
        </span>
      )}
      {selected && (
        <span className="absolute -top-2 left-1/2 z-10 -translate-x-1/2 rounded-chip bg-purple px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-on-purple">
          Place
        </span>
      )}
      <div className="flex items-center justify-between gap-1">
        <span className={`truncate text-[9px] font-semibold uppercase ${element}`}>
          {ELEMENT_NAMES[card.element] ?? ELEMENT_NAMES[0]}
        </span>
        <span className={`shrink-0 text-[8px] font-semibold uppercase ${rarityTextClass[card.rarity] ?? ''}`}>
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

/** Closed pile: the Monicard back and the remaining count, on both sides of the board. */
export function Pile({ count, side }: PileProps) {
  const owner = side === 'self' ? 'Your' : 'Opponent';
  const tone = side === 'self' ? 'text-purple-ink' : 'text-berry';

  return (
    <div className="relative w-[54px] shrink-0" role="img" aria-label={`${owner} deck, ${count} cards left`}>
      <div className="absolute inset-x-1.5 top-1.5 h-[116px] rounded-card border border-line bg-surface-sunken" aria-hidden="true" />
      <div className="absolute inset-x-0 top-0 flex h-[116px] flex-col items-center justify-center rounded-card border-2 border-line bg-surface-raised px-1">
        <span className="label text-center text-[8px] leading-tight text-ink-muted">Monicard</span>
        <span className={`font-mono text-2xl font-semibold leading-none tabular-nums ${tone}`}>{count}</span>
        <span className="text-[8px] uppercase tracking-wider text-ink-muted">left</span>
      </div>
    </div>
  );
}

/** The card just drawn: starts over the pile and lands above the hand, once. */
export function DrawReveal({ card }: { card: DrawCard }) {
  return (
    <div
      className="draw-card pointer-events-none absolute bottom-6 left-1/2 z-30 w-[132px] -translate-x-1/2"
      aria-hidden="true"
    >
      <div className="rounded-card border-2 border-purple bg-surface-raised p-2">
        <p className="label text-center text-purple-ink">You drew</p>
        <img src={`/nadmon/${card.nadmon.id}.svg`} alt="" width={240} height={150} className="mx-auto h-11 object-contain" />
        <p className="truncate text-center text-[11px] font-semibold leading-tight text-ink">{card.nadmon.name}</p>
        <p className="text-center font-mono text-[9px] tabular-nums text-ink-muted">
          ATK {card.atk} · HP {formatInt(card.hp)}
        </p>
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