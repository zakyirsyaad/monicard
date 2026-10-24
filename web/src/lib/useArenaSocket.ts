import { useEffect, useReducer } from 'react';
import {
  type ArenaState,
  type WebSocketLike,
  initialArenaState,
  nextBackoff,
  parseWsMessage,
  reduceArena,
} from './arenaState';
import type { WsMessage } from './types';
import { createMockSocket } from '../mock/socket';

export type ArenaScope = 'all' | { duelId: string };
export type ArenaSocket = ArenaState & { connected: boolean };

type SocketFactory = (url: string) => WebSocketLike;

const defaultFactory: SocketFactory = (url) =>
  import.meta.env.VITE_USE_MOCK === '1' ? createMockSocket(url) : (new WebSocket(url) as WebSocketLike);

let socketFactory: SocketFactory = defaultFactory;

/** Override how sockets are created (tests, mock mode). Returns a restore function. */
export function setSocketFactory(factory: SocketFactory): () => void {
  socketFactory = factory;
  return () => {
    socketFactory = defaultFactory;
  };
}

export function arenaUrl(scope: ArenaScope): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const s = scope === 'all' ? 'all' : `duel:${scope.duelId}`;
  return `${proto}://${location.host}/ws?scope=${s}`;
}

type Action =
  | { kind: 'msg'; msg: WsMessage; now: number }
  | { kind: 'connected'; value: boolean }
  | { kind: 'reset' };
type HookState = { arena: ArenaState; connected: boolean };

const initialHookState: HookState = { arena: initialArenaState, connected: false };

function reduce(state: HookState, action: Action): HookState {
  if (action.kind === 'reset') return initialHookState;
  if (action.kind === 'connected') {
    return state.connected === action.value ? state : { ...state, connected: action.value };
  }
  return { ...state, arena: reduceArena(state.arena, action.msg, action.now) };
}

export function useArenaSocket(scope: ArenaScope): ArenaSocket {
  const [state, dispatch] = useReducer(reduce, initialHookState);
  const scopeKey = scope === 'all' ? 'all' : scope.duelId;

  useEffect(() => {
    const url = arenaUrl(scopeKey === 'all' ? 'all' : { duelId: scopeKey });
    let disposed = false;
    let socket: WebSocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff: number | null = null;

    const scheduleReconnect = () => {
      backoff = nextBackoff(backoff);
      timer = setTimeout(connect, backoff);
    };

    const connect = () => {
      if (disposed) return;
      let ws: WebSocketLike;
      try {
        ws = socketFactory(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.onopen = () => {
        if (disposed || socket !== ws) return;
        backoff = null;
        dispatch({ kind: 'connected', value: true });
      };
      ws.onmessage = (ev) => {
        if (disposed || socket !== ws) return;
        const msg = parseWsMessage(ev.data);
        if (msg) dispatch({ kind: 'msg', msg, now: Date.now() });
      };
      ws.onclose = () => {
        if (disposed || socket !== ws) return;
        socket = null;
        dispatch({ kind: 'connected', value: false });
        scheduleReconnect();
      };
      ws.onerror = () => {
        // A close event follows an error; reconnect is handled there.
      };
    };

    dispatch({ kind: 'reset' });
    connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      const ws = socket;
      socket = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
    };
  }, [scopeKey]);

  return { ...state.arena, connected: state.connected };
}
