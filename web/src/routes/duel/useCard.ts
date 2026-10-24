import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { NadgachaCard } from '../../lib/types';

const RETRY_MS = 1000;
const MAX_ATTEMPTS = 6;

/** Card data from `GET /card/:id` (`nadgacha`); `null` id fetches nothing. Retries while unknown or bare-forging. */
export function useCard(id: string | null): NadgachaCard | null {
  const [card, setCard] = useState<NadgachaCard | null>(null);

  useEffect(() => {
    if (id === null || id === '0') return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attempt = (n: number) => {
      api.getCard(id).then(
        (meta) => {
          if (cancelled) return;
          if (meta && 'nadgacha' in meta) setCard(meta.nadgacha);
          else if (n + 1 < MAX_ATTEMPTS) timer = setTimeout(() => attempt(n + 1), RETRY_MS);
        },
        () => {
          if (!cancelled && n + 1 < MAX_ATTEMPTS) timer = setTimeout(() => attempt(n + 1), RETRY_MS);
        },
      );
    };

    attempt(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  return card;
}
