import { elementTextClass, ELEMENT_NAMES, rarityBorderClass } from '../lib/labels';

export interface GameCardProps {
  nadmon: { id: string; name: string };
  element: number;
  rarity: number;
  atk: number;
}

/** Compact duel-screen card. The full card is a server-rendered SVG (see CardImage). */
export function GameCard({ nadmon, element, rarity, atk }: GameCardProps) {
  const border = rarityBorderClass[rarity] ?? rarityBorderClass[0];
  const elementColor = elementTextClass[element] ?? elementTextClass[0];
  const elementName = ELEMENT_NAMES[element] ?? ELEMENT_NAMES[0];

  return (
    <div className={`flex h-[72px] min-w-0 items-center gap-3 rounded-card border-2 bg-surface-raised px-3 ${border}`}>
      <img src={`/nadmon/${nadmon.id}.svg`} alt={nadmon.name} width={64} height={40} className="h-10 w-16 shrink-0 rounded-chip" />
      <div className="min-w-0">
        <div className="title truncate text-ink">{nadmon.name}</div>
        <span className={`label inline-block rounded-chip bg-purple-tint px-2 ${elementColor}`}>{elementName}</span>
      </div>
      <span className="data ml-auto shrink-0 text-ink">ATK {atk}</span>
    </div>
  );
}
