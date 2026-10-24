import { useCallback, useEffect, useState } from 'react';
import { TX_GAP_MS, msSinceLastTx } from './actions';

const TIMER_SLACK_MS = 20;

/** True once the burner's last tx is at least 3 blocks old. Call `recheck` after sending a tx. */
export function useTxGap(): { ready: boolean; recheck: () => void } {
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState(() => msSinceLastTx() >= TX_GAP_MS);

  useEffect(() => {
    const remaining = TX_GAP_MS - msSinceLastTx();
    if (remaining <= 0) {
      setReady(true);
      return undefined;
    }
    setReady(false);
    const timer = setTimeout(() => setReady(true), remaining + TIMER_SLACK_MS);
    return () => clearTimeout(timer);
  }, [tick]);

  const recheck = useCallback(() => setTick((n) => n + 1), []);
  return { ready, recheck };
}
