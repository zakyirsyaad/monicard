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

/** Full card: server-rendered SVG in an <img>. Legendary gets the foil overlay over the picture window. */
export function CardImage({ id, name, rarity, version, src, className = '' }: CardImageProps) {
  const url = src ?? `/card/${id}/image.svg${version === undefined ? '' : `?v=${encodeURIComponent(version)}`}`;

  return (
    <div className={`relative inline-block w-full max-w-[300px] ${className}`}>
      <img src={url} alt={name} width={300} height={560} className="block h-auto w-full" />
      {rarity === LEGENDARY_RARITY && (
        <span
          aria-hidden="true"
          className="foil absolute"
          style={{ left: '4%', top: '15.7%', width: '92%', height: '30.7%' }}
        />
      )}
    </div>
  );
}
