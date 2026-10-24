import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Config, StakeView } from './types';

const RETRY_MS = 2000;
const MAX_RETRIES = 3;
/** A node can be a block behind right after our own tx: read again once it has surely caught up. */
const REREAD_MS = 1500;

export type StakeCtx = { config: Config; stake: StakeView | null; refresh: () => void };

/**
 * Stake state of a duel, read at low frequency (never polled): when the duel or `phaseKey` changes
 * (phase transitions, settled), and on `refresh()` after a stake or claim tx of ours is confirmed.
 */
export function useStake(
  duelId: string | null,
  enabled: boolean,
  phaseKey: string,
): { stake: StakeView | null; refresh: () => void } {
  const [stake, setStake] = useState<StakeView | null>(null);
  const [tick, setTick] = useState(0);
  const reread = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setStake(null);
  }, [duelId]);

  useEffect(() => {
    if (!enabled || duelId === null) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number) => {
      api.getStake(duelId).then(
        (view) => {
          if (!cancelled && view) setStake(view);
        },
        () => {
          // Transient RPC error: retry a few times, then wait for the next trigger.
          if (!cancelled && attempt < MAX_RETRIES) timer = setTimeout(() => read(attempt + 1), RETRY_MS);
        },
      );
    };
    read(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [duelId, enabled, phaseKey, tick]);

  useEffect(() => () => clearTimeout(reread.current), []);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
    clearTimeout(reread.current);
    reread.current = setTimeout(() => setTick((n) => n + 1), REREAD_MS);
  }, []);

  return { stake, refresh };
}
