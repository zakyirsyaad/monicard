import { GameCard } from '../../components/GameCard';
import type { NadgachaCard } from '../../lib/types';
import { useCard } from './useCard';

/** Compact card by token id, with a same-size placeholder while it loads. */
export function CardSlot({ id }: { id: string | null }) {
  const card: NadgachaCard | null = useCard(id);
  if (!card) return <div className="h-[72px] rounded-card bg-surface-sunken" aria-hidden="true" />;
  return <GameCard nadmon={card.nadmon} element={card.element} rarity={card.rarity} atk={card.atk} />;
}
