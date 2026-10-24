import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import type { Config } from '../types';
import { readBlockNumber, readMatch } from './chain';
import { battleMock, MOCK_BLOCK_MS } from './mock';
import { normalizeMatch } from './rules';
import type { MatchView } from './types';

export function isBattleMock(): boolean {
  return import.meta.env.VITE_USE_MOCK === '1';
}

const POLL_MS = 1200;
const STALE_MS = 3000;
const BACKOFF_MS = [500, 1000, 2000, 4000] as const;
const MISSING_MS = 5000;

export type MatchState = {
  match: MatchView | null;
  /** Latest block the client knows about (drives the turn clock). */
  block: number;
  connected: boolean;
  loading: boolean;
  /** No such match after MISSING_MS of successful polls / snapshots. */
  missing: boolean;
  /** Set when the battle contract is not configured on this deployment. */
  unavailable: boolean;
};

const INITIAL: MatchState = {
  match: null,
  block: 0,
  connected: false,
  loading: true,
  missing: false,
  unavailable: false,
};

type WebSocketLike = Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'close'>;

export function battleScopeUrl(id: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?scope=match:${encodeURIComponent(id)}`;
}

/** Parses a `matches` message; returns null for anything else on the shared socket. */
export function parseMatchesMessage(data: unknown): { block: number; matches: MatchView[] } | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const msg = parsed as { type?: unknown; block?: unknown; matches?: unknown };
  if (msg.type !== 'matches' || !Array.isArray(msg.matches)) return null;
  const block = Number(msg.block);
  const matches = msg.matches
    .map(normalizeMatch)
    .filter((m): m is MatchView => m !== null);
  return { block: Number.isFinite(block) ? block : 0, matches };
}

function battleAddressOf(config: Config | null): Hex | null {
  if (!config) return null;
  return (config.contracts as Config['contracts'] & { battle?: Hex }).battle ?? null;
}

/** Live match: WS `matches` on `match:<id>` with a polling fallback when the socket is silent. */
export function useMatch(id: string, config: Config | null): MatchState {
  const [state, setState] = useState<MatchState>(INITIAL);
  const mock = isBattleMock();
  const battle = battleAddressOf(config);

  useEffect(() => {
    if (!mock) return undefined;
    const read = () => {
      const match = battleMock.getMatch(id);
      setState({
        match,
        block: battleMock.block(),
        connected: true,
        loading: false,
        missing: match === null,
        unavailable: false,
      });
    };
    read();
    const unsubscribe = battleMock.subscribe(read);
    const timer = setInterval(read, Math.max(MOCK_BLOCK_MS, 300));
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [id, mock]);

  useEffect(() => {
    if (mock) return undefined;
    if (!battle) {
      setState({ ...INITIAL, loading: false, unavailable: config !== null });
      return undefined;
    }

    let disposed = false;
    let socket: WebSocketLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let backoff = 0;
    let lastMessageAt = 0;
    let missingSince: number | null = null;
    let pollInFlight = false;

    const apply = (match: MatchView | null, block: number, connected: boolean) => {
      if (disposed) return;
      if (match === null) missingSince ??= Date.now();
      else missingSince = null;
      setState((prev) => ({
        match: match ?? prev.match,
        block: Math.max(block, prev.block),
        connected,
        loading: false,
        missing: match === null && missingSince !== null && Date.now() - missingSince >= MISSING_MS,
        unavailable: false,
      }));
    };

    const poll = async () => {
      if (disposed || pollInFlight) return;
      if (Date.now() - lastMessageAt < STALE_MS) return;
      pollInFlight = true;
      try {
        const [match, block] = await Promise.all([readMatch(battle, id), readBlockNumber()]);
        apply(match, block, socket !== null);
      } finally {
        pollInFlight = false;
      }
    };

    const scheduleReconnect = () => {
      const delay = BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)] ?? 4000;
      backoff += 1;
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed) return;
      let ws: WebSocketLike;
      try {
        ws = new WebSocket(battleScopeUrl(id)) as WebSocketLike;
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.onopen = () => {
        if (disposed || socket !== ws) return;
        backoff = 0;
        setState((prev) => (prev.connected ? prev : { ...prev, connected: true }));
      };
      ws.onmessage = (event: MessageEvent) => {
        if (disposed || socket !== ws) return;
        const parsed = parseMatchesMessage(event.data);
        if (!parsed) return;
        lastMessageAt = Date.now();
        const match = parsed.matches.find((m) => m.id === id) ?? null;
        apply(match, parsed.block, true);
      };
      ws.onclose = () => {
        if (disposed || socket !== ws) return;
        socket = null;
        setState((prev) => (prev.connected ? { ...prev, connected: false } : prev));
        scheduleReconnect();
      };
      ws.onerror = () => {
        // A close event follows; reconnect is handled there.
      };
    };

    void poll();
    connect();
    pollTimer = setInterval(() => void poll(), POLL_MS);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearInterval(pollTimer);
      const ws = socket;
      socket = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
    };
  }, [id, mock, battle, config]);

  return state;
}

/** Turn clock in whole seconds (Monad 0.3 s blocks); null when the match is over. */
export function blocksToSeconds(blocks: number): number {
  return Math.max(0, Math.ceil(blocks * 0.3));
}
