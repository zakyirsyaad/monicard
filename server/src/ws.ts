import type { Server } from 'node:http';
import type { DuelView, Hex } from '@nad/shared';
import { WebSocketServer } from 'ws';

// ---- Message types: mirror the frozen "Pesan WebSocket (/ws)" contract exactly. ----

export type DuelsMsg = { type: 'duels'; block: string; duels: DuelView[]; featuredId: string | null };

export type StatsMsg = {
  type: 'stats';
  block: string;
  txTotal: number;
  txPerSec: number;
  avgLatencyMs: number;
  uniquePlayers: number;
  totalDuels: number;
  /** wei, decimal string */
  treasury: string;
  /** Hash of the last relayed/bot tx that landed in a block. */
  lastTxHash?: Hex;
};

export type LeaderboardMsg = {
  type: 'leaderboard';
  entries: { address: Hex; label: string | null; wins: number; losses: number; cardId: string }[];
};

export type AgentMsg = {
  type: 'agent';
  level: number;
  threshold: number;
  finisher: boolean;
  sim: { duels: number; wins: number };
  testnet: { duels: number; wins: number };
  lessons: { at: number; duelId: string; text: string; thresholdFrom: number; thresholdTo: number }[];
};

export type TauntMsg = { type: 'taunt'; duelId: string; text: string };

/** `leaderboard` is part of the contract but was cut (addendum section 2): nothing in the server sends it. */
export type WsMessage = DuelsMsg | StatsMsg | LeaderboardMsg | AgentMsg | TauntMsg;

export type WsScope = 'all' | { duelId: string };

/**
 * Called for every new connection. `send` applies the same scope filter as `broadcast`,
 * so a snapshot of all duels reaches a phone as only its own duel.
 */
export type ConnectCallback = (send: (msg: WsMessage) => void, scope: WsScope) => void;

/** Minimal socket surface; `ws` WebSocket instances satisfy it structurally. */
export type WsSocketLike = { send(data: string): void; readyState?: number; bufferedAmount?: number };

export type WsHubCore = {
  add(sock: WsSocketLike, scope: WsScope): void;
  remove(sock: WsSocketLike): void;
  broadcast(msg: WsMessage): void;
  onConnect(cb: ConnectCallback): void;
  size(): number;
  /** Duel ids that scoped connections are subscribed to. */
  subscribedIds(): Set<string>;
};

export const WS_PATH = '/ws';
export const PING_INTERVAL_MS = 30_000;
/** A socket with more than this queued is skipped: every `duels` message is a full snapshot, so the next one catches up. */
export const MAX_BUFFERED_BYTES = 65_536;
/** readyState value of an OPEN WebSocket. */
const READY_STATE_OPEN = 1;
const MAX_DUEL_ID_DIGITS = 20;
const DUEL_SCOPE = /^duel:(\d+)$/;

/** `?scope=all` | `?scope=duel:<digits>`; anything missing or invalid means `all`. */
export function parseScope(url: string | undefined): WsScope {
  if (!url) return 'all';
  let raw: string | null;
  try {
    raw = new URL(url, 'http://localhost').searchParams.get('scope');
  } catch {
    return 'all';
  }
  const match = raw === null ? null : DUEL_SCOPE.exec(raw);
  const digits = match?.[1];
  if (!digits || digits.length > MAX_DUEL_ID_DIGITS) return 'all';
  return { duelId: BigInt(digits).toString() };
}

const scopeKey = (scope: WsScope): string => (scope === 'all' ? 'all' : `duel:${scope.duelId}`);

/** Message as seen by a connection with this scope, or null when it must not receive it. */
function project(scope: WsScope, msg: WsMessage): WsMessage | null {
  if (scope === 'all') return msg;
  switch (msg.type) {
    case 'duels':
      // Always delivered (possibly empty) so the phone still learns the block number.
      return { ...msg, duels: msg.duels.filter((d) => d.id === scope.duelId) };
    case 'taunt':
      return msg.duelId === scope.duelId ? msg : null;
    case 'leaderboard':
      return null;
    default:
      return msg;
  }
}

const isOpen = (sock: WsSocketLike): boolean => sock.readyState === undefined || sock.readyState === READY_STATE_OPEN;

export function createWsHubCore(): WsHubCore {
  const sockets = new Map<WsSocketLike, WsScope>();
  const connectCallbacks: ConnectCallback[] = [];

  /** Sends to an open socket; a socket whose send throws is dropped. */
  function trySend(sock: WsSocketLike, payload: string): void {
    if (!isOpen(sock) || (sock.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) return;
    try {
      sock.send(payload);
    } catch {
      sockets.delete(sock);
    }
  }

  function broadcast(msg: WsMessage): void {
    const serialized = new Map<string, string | null>();
    for (const [sock, scope] of sockets) {
      const key = scopeKey(scope);
      if (!serialized.has(key)) {
        const projected = project(scope, msg);
        serialized.set(key, projected ? JSON.stringify(projected) : null);
      }
      const payload = serialized.get(key);
      if (payload) trySend(sock, payload);
    }
  }

  function add(sock: WsSocketLike, scope: WsScope): void {
    sockets.set(sock, scope);
    const send = (msg: WsMessage): void => {
      const projected = project(scope, msg);
      if (projected) trySend(sock, JSON.stringify(projected));
    };
    for (const cb of connectCallbacks) {
      try {
        cb(send, scope);
      } catch (err) {
        console.error('ws: onConnect callback threw', err);
      }
    }
  }

  return {
    add,
    remove: (sock) => void sockets.delete(sock),
    broadcast,
    onConnect: (cb) => void connectCallbacks.push(cb),
    size: () => sockets.size,
    subscribedIds: () => new Set([...sockets.values()].flatMap((scope) => (scope === 'all' ? [] : [scope.duelId]))),
  };
}

export type WsHub = {
  broadcast(msg: WsMessage): void;
  onConnect(cb: ConnectCallback): void;
  subscribedIds(): Set<string>;
  close(): void;
};

type LiveSocket = WsSocketLike & {
  on(event: 'close' | 'error' | 'pong', cb: () => void): void;
  ping(): void;
  terminate(): void;
};

/** Attaches a `/ws` endpoint to the HTTP server; dead clients are dropped by a 30 s ping. */
export function createWsHub(server: Server): WsHub {
  const core = createWsHubCore();
  const wss = new WebSocketServer({ server, path: WS_PATH });
  const alive = new WeakMap<WsSocketLike, boolean>();

  wss.on('connection', (raw: unknown, req: { url?: string }) => {
    const sock = raw as LiveSocket;
    alive.set(sock, true);
    sock.on('pong', () => alive.set(sock, true));
    sock.on('close', () => core.remove(sock));
    sock.on('error', () => core.remove(sock));
    core.add(sock, parseScope(req.url));
  });

  const pinger = setInterval(() => {
    for (const client of wss.clients as unknown as Set<LiveSocket>) {
      if (alive.get(client) === false) {
        client.terminate();
        core.remove(client);
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, PING_INTERVAL_MS);
  pinger.unref();

  return {
    broadcast: core.broadcast,
    onConnect: core.onConnect,
    subscribedIds: core.subscribedIds,
    close() {
      clearInterval(pinger);
      wss.close();
    },
  };
}
