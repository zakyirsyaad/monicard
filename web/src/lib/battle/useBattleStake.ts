import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config, StakeView } from '../types';
import { readBattleStake } from './stake';

const RETRY_MS = 2000;
const MAX_RETRIES = 3;
/** A node can be a block behind right after our own tx: read again once it has surely caught up. */
const REREAD_MS = 1500;

export type BattleStakeState = {
  stake: StakeView | null;
  /** `loading` until the first read lands; `error` once the retries ran out (the UI then falls back to free). */
  status: 'idle' | 'loading' | 'ready' | 'error';
  refresh: () => void;
};

/**
 * Stake state of a match, read at low frequency and never per block: on open, when `phaseKey` changes
 * (match status), and on `refresh()` after a stake or claim tx of ours.
 */
export function useBattleStake(
  config: Config | null,
  matchId: string | null,
  enabled: boolean,
  phaseKey: string,
): BattleStakeState {
  const [stake, setStake] = useState<StakeView | null>(null);
  const [status, setStatus] = useState<BattleStakeState['status']>('idle');
  const [tick, setTick] = useState(0);
  const reread = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!enabled || config === null || matchId === null) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number) => {
      readBattleStake(config, matchId).then(
        (view) => {
          if (cancelled) return;
          setStake(view);
          setStatus('ready');
        },
        () => {
          if (cancelled) return;
          if (attempt < MAX_RETRIES) timer = setTimeout(() => read(attempt + 1), RETRY_MS);
          else setStatus((prev) => (prev === 'ready' ? prev : 'error'));
        },
      );
    };
    setStatus((prev) => (prev === 'ready' ? prev : 'loading'));
    read(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [config, matchId, enabled, phaseKey, tick]);

  useEffect(() => () => clearTimeout(reread.current), []);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
    clearTimeout(reread.current);
    reread.current = setTimeout(() => setTick((n) => n + 1), REREAD_MS);
  }, []);

  return { stake, status: enabled ? status : 'idle', refresh };
}
