import { useEffect, useState } from 'react';
import { fetchCardWithRetry } from '../../lib/cardFetch';
import type { NadgachaCard } from '../../lib/types';

const FORGING_RETRY_MS = 1000;
const FORGING_ATTEMPTS = 6;

/**
 * Card data from `GET /card/:id` (`nadgacha`); `null` id fetches nothing.
 * Unknown ids and transient failures are retried by `fetchCardWithRetry`; a bare-forging answer is re-polled here.
 * If everything fails the result stays null and callers render their placeholder.
 */
export function useCard(id: string | null): NadgachaCard | null {
  const [card, setCard] = useState<NadgachaCard | null>(null);

  useEffect(() => {
    if (id === null || id === '0') return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attempt = (n: number) => {
      fetchCardWithRetry(id, { isCancelled: () => cancelled }).then(
        (meta) => {
          if (cancelled || meta === null) return;
          if ('nadgacha' in meta) setCard(meta.nadgacha);
          else if (n + 1 < FORGING_ATTEMPTS) timer = setTimeout(() => attempt(n + 1), FORGING_RETRY_MS);
        },
        () => undefined, // Retries exhausted: keep the placeholder.
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
