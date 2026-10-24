import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { toFriendly } from './errors';
import type { CardMeta, NadgachaCard } from './types';

const POLL_MS = 1000;
const LOOKUP_RETRIES = 4;
const LOOKUP_RETRY_MS = 700;

/** `card` is null while the server only answers `{status:'forging'}`. */
export type Reveal = { status: 'ready' | 'forging'; card: NadgachaCard | null };

export function revealOf(meta: CardMeta): Reveal {
  if ('nadgacha' in meta) return { status: meta.nadgacha.status, card: meta.nadgacha };
  return { status: 'forging', card: null };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The server may need a moment to know a freshly minted token. */
async function lookupCard(id: string, isCancelled: () => boolean): Promise<CardMeta | null> {
  for (let attempt = 0; attempt < LOOKUP_RETRIES; attempt++) {
    const meta = await api.getCard(id);
    if (meta || isCancelled()) return meta;
    await wait(LOOKUP_RETRY_MS);
  }
  return null;
}

/** Loads a card and keeps polling every second until its art is ready (so `status` flips and the image reloads). */
export function useCardMeta(id: string | null): { reveal: Reveal | null; error: string | null } {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const forging = useRef(false);
  forging.current = reveal !== null && (reveal.status !== 'ready' || reveal.card === null);

  useEffect(() => {
    setReveal(null);
    setError(null);
    if (!id) return undefined;
    let cancelled = false;
    lookupCard(id, () => cancelled).then(
      (meta) => {
        if (cancelled) return;
        if (meta) setReveal(revealOf(meta));
        else setError("We couldn't find that card. Go back and try again.");
      },
      (err: unknown) => {
        if (!cancelled) setError(toFriendly(err, { fn: 'getCard' }));
      },
    );
    const timer = setInterval(() => {
      if (!forging.current) return;
      api.getCard(id).then(
        (meta) => {
          if (meta && !cancelled) setReveal(revealOf(meta));
        },
        () => undefined, // Polling: the next tick tries again.
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  return { reveal, error };
}
