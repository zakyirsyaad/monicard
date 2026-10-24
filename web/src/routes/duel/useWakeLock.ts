import { useEffect } from 'react';

/** Keeps the screen awake while `active`. Re-requests when the tab becomes visible again; released on leave. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !navigator.wakeLock) return undefined;
    let disposed = false;
    let sentinel: WakeLockSentinel | null = null;

    const release = (s: WakeLockSentinel | null) => {
      s?.release().catch(() => {
        // Already released by the browser (tab hidden): nothing left to do.
      });
    };

    const request = async () => {
      if (sentinel && !sentinel.released) return;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (disposed) release(next);
        else sentinel = next;
      } catch {
        // Refused (battery saver, hidden tab, no permission): the duel still works, the screen may dim.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void request();
    };

    void request();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      release(sentinel);
      sentinel = null;
    };
  }, [active]);
}
