import { useEffect, useState } from 'react';
import { withRetryParam } from '../lib/cardImage';
import { LEGENDARY_RARITY } from '../lib/labels';

export interface CardImageProps {
  id: string;
  name: string;
  rarity: number;
  /** Cache-buster: change it when the card goes from forging to ready. */
  version?: string;
  /** Override the image URL (mock mode / dev). */
  src?: string;
  className?: string;
}

const MAX_IMAGE_RETRIES = 3;
const IMAGE_RETRY_MS = 1000;

/** Full card: server-rendered SVG in an <img>. Legendary gets the foil overlay over the picture window. */
export function CardImage({ id, name, rarity, version, src, className = '' }: CardImageProps) {
  const base = src ?? `/card/${id}/image.svg${version === undefined ? '' : `?v=${encodeURIComponent(version)}`}`;
  // Keyed by url so a new card or version starts with a fresh retry count.
  return <CardArt key={base} base={base} name={name} rarity={rarity} className={className} />;
}

function CardArt({ base, name, rarity, className }: { base: string; name: string; rarity: number; className: string }) {
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    if (!retrying) return undefined;
    const timer = setTimeout(() => {
      setAttempt((n) => n + 1);
      setRetrying(false);
    }, IMAGE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [retrying]);

  return (
    <div className={`relative inline-block w-full max-w-[300px] ${className}`}>
      {exhausted ? (
        <div
          role="img"
          aria-label={name}
          className="flex aspect-[300/560] w-full items-center justify-center rounded-card bg-surface-sunken p-4 text-center"
        >
          <span className="body text-ink-muted">Card art unavailable</span>
        </div>
      ) : (
        <img
          src={withRetryParam(base, attempt)}
          alt={name}
          width={300}
          height={560}
          className={`block h-auto w-full ${retrying ? 'invisible' : ''}`}
          onError={() => {
            if (attempt < MAX_IMAGE_RETRIES) setRetrying(true);
            else setExhausted(true);
          }}
        />
      )}
      {rarity === LEGENDARY_RARITY && !exhausted && (
        <span
          aria-hidden="true"
          className="foil absolute"
          style={{ left: '4%', top: '15.7%', width: '92%', height: '30.7%' }}
        />
      )}
    </div>
  );
}
