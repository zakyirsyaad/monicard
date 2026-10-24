import type {
  AgentMsg,
  DuelView,
  LeaderboardEntry,
  StatsMsg,
  WsMessage,
} from './types';

/** The subset of WebSocket the hook uses; lets mock mode and tests inject a fake. */
export type WebSocketLike = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
};

export type ArenaState = {
  duels: Map<string, DuelView>;
  featuredId: string | null;
  stats: StatsMsg | null;
  agent: AgentMsg | null;
  /** null until a `leaderboard` message arrives (the feature may be cut). */
  leaderboard: LeaderboardEntry[] | null;
  taunts: Map<string, string>;
  /** Highest block seen; never decreases. */
  block: number;
  /** `Date.now()` when `block` last advanced. */
  blockAt: number;
};

export const initialArenaState: ArenaState = {
  duels: new Map(),
  featuredId: null,
  stats: null,
  agent: null,
  leaderboard: null,
  taunts: new Map(),
  block: 0,
  blockAt: 0,
};

export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 8000;

/** 500 -> 1000 -> 2000 -> 4000 -> 8000 (cap). Pass null for the first attempt. */
export function nextBackoff(prevMs: number | null): number {
  if (prevMs === null) return BACKOFF_START_MS;
  return Math.min(prevMs * 2, BACKOFF_MAX_MS);
}

function withBlock(state: ArenaState, blockStr: string, now: number): ArenaState {
  const block = Number(blockStr);
  if (!Number.isFinite(block) || block <= state.block) return state;
  return { ...state, block, blockAt: now };
}

export function reduceArena(state: ArenaState, msg: WsMessage, now: number): ArenaState {
  switch (msg.type) {
    case 'duels': {
      const next: ArenaState = {
        ...state,
        duels: new Map(msg.duels.map((d) => [d.id, d])),
        featuredId: msg.featuredId,
      };
      return withBlock(next, msg.block, now);
    }
    case 'stats':
      return withBlock({ ...state, stats: msg }, msg.block, now);
    case 'leaderboard':
      return { ...state, leaderboard: msg.entries };
    case 'agent':
      return { ...state, agent: msg };
    case 'taunt':
      return { ...state, taunts: new Map(state.taunts).set(msg.duelId, msg.text) };
    default:
      return state;
  }
}

type Loose = Record<string, unknown>;

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Cheap per-type shape guards; deeper fields are trusted (server is ours). */
const SHAPE_GUARDS: Record<WsMessage['type'], (m: Loose) => boolean> = {
  duels: (m) => Array.isArray(m.duels) && isStr(m.block),
  stats: (m) => isStr(m.block),
  leaderboard: (m) => Array.isArray(m.entries),
  agent: (m) => Array.isArray(m.lessons),
  taunt: (m) => isStr(m.duelId) && isStr(m.text),
};

/** Parse a raw socket payload; null for malformed JSON, unknown types or bad shapes. */
export function parseWsMessage(data: unknown): WsMessage | null {
  if (!isStr(data)) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Loose;
    const guard = isStr(m.type) && Object.hasOwn(SHAPE_GUARDS, m.type)
      ? SHAPE_GUARDS[m.type as WsMessage['type']]
      : undefined;
    return guard?.(m) ? (parsed as WsMessage) : null;
  } catch {
    return null;
  }
}
