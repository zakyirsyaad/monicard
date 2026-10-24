import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { CardImage } from '../components/CardImage';
import { Notice } from '../components/Notice';
import { Screen } from '../components/Screen';
import { CARD_IMAGE_SRC } from '../lib/cardImage';
import { formatBlock } from '../lib/format';
import { ELEMENT_NAMES, RARITY_NAMES, elementTextClass, rarityBorderClass } from '../lib/labels';
import { prefersReducedMotion } from '../lib/motion';
import { takeReturnTo } from '../lib/returnTo';
import { useCardMeta } from '../lib/useCardMeta';

const CLOSED_MS = 600;
const FRAME_MS = 400;

type Phase = 'closed' | 'frame' | 'open';

export function Pull() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = params.get('card');
  const { reveal, error } = useCardMeta(id);
  const [phase, setPhase] = useState<Phase>(() => (prefersReducedMotion() ? 'open' : 'closed'));

  useEffect(() => {
    if (phase === 'open') return undefined;
    const timer = setTimeout(
      () => setPhase(phase === 'closed' ? 'frame' : 'open'),
      phase === 'closed' ? CLOSED_MS : FRAME_MS,
    );
    return () => clearTimeout(timer);
  }, [phase]);

  const card = reveal?.card ?? null;
  const rarity = card?.rarity ?? 0;
  const revealed = phase === 'open' && reveal !== null;
  const frame = phase === 'closed' || reveal === null ? 'border-transparent' : rarityBorderClass[rarity];

  const next = () => navigate(takeReturnTo() ?? '/play');

  return (
    <Screen>
      <h1 className="sr-only">Your card</h1>
      <div className="mx-auto w-full max-w-[300px]">
        {revealed && card ? (
          <CardImage
            id={String(card.id)}
            name={card.nadmon.name}
            rarity={card.rarity}
            version={reveal.status}
            src={CARD_IMAGE_SRC}
          />
        ) : (
          <div
            className={`aspect-[300/560] w-full rounded-card border-2 bg-surface-sunken transition-colors duration-200 ${frame}`}
          />
        )}
      </div>
      {revealed && reveal.status === 'forging' && <p className="body text-center text-ink-muted">Forging lore…</p>}
      {revealed && card && (
        <section className="flex flex-col gap-1 text-center">
          <h2 className="title">{card.nadmon.name}</h2>
          <p className="label text-ink-muted">
            <span className={elementTextClass[card.element]}>{ELEMENT_NAMES[card.element]}</span>
            {' · '}
            {RARITY_NAMES[card.rarity]}
          </p>
          <p className="data text-ink-muted">Rolled in block {formatBlock(card.mintedAt)}</p>
        </section>
      )}
      <div className="mt-auto flex flex-col gap-3">
        {error && <Notice>{error}</Notice>}
        {!id && <Notice>No card to show. Go back and pull one.</Notice>}
        <Button disabled={Boolean(id) && !error && !(revealed && card)} onClick={next}>
          Continue
        </Button>
      </div>
    </Screen>
  );
}
