import { api, isTransient } from './api';
import type { CardMeta } from './types';

/** Tries while the server answers 404 (it may not know a freshly minted token yet). */
export const CARD_NOT_FOUND_TRIES = 4;
/** Total tries including transient failures (429/5xx/network): about 6 s at `CARD_RETRY_MS`. */
export const CARD_MAX_TRIES = 8;
export const CARD_RETRY_MS = 850;

export const CARD_LOAD_FAILED = "We couldn't load that card. Check your connection and try again.";
export const CARD_NOT_FOUND = "We couldn't find that card. Go back and try again.";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FetchCardOptions {
  isCancelled?: () => boolean;
  getCard?: (id: string) => Promise<CardMeta | null>;
}

/**
 * `GET /card/:id` that rides out a 404 (token not known yet) and transient failures.
 * Resolves null when the card stays unknown or the caller cancelled; rethrows a permanent
 * error at once, and the last transient error once the tries are used up.
 */
export async function fetchCardWithRetry(
  id: string,
  { isCancelled = () => false, getCard = (cardId) => api.getCard(cardId) }: FetchCardOptions = {},
): Promise<CardMeta | null> {
  let misses = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const meta = await getCard(id);
      if (meta) return meta;
      if (++misses >= CARD_NOT_FOUND_TRIES) return null;
    } catch (err) {
      if (!isTransient(err) || attempt >= CARD_MAX_TRIES) throw err;
    }
    if (isCancelled()) return null;
    if (attempt >= CARD_MAX_TRIES) return null;
    await wait(CARD_RETRY_MS);
  }
}
