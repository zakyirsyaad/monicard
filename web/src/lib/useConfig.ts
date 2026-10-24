import { useEffect, useState } from 'react';
import { api } from './api';
import type { Config } from './types';

const RETRY_MS = 2000;

let cached: Promise<Config> | null = null;

/** One /config request per page load; a failed request is forgotten so the next call retries. */
export function loadConfig(): Promise<Config> {
  cached ??= api.getConfig().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}

export type ConfigState = { config: Config | null; failed: boolean };

export function useConfig(): ConfigState {
  const [state, setState] = useState<ConfigState>({ config: null, failed: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      loadConfig().then(
        (config) => {
          if (!cancelled) setState({ config, failed: false });
        },
        () => {
          if (cancelled) return;
          setState({ config: null, failed: true });
          timer = setTimeout(attempt, RETRY_MS);
        },
      );
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return state;
}
