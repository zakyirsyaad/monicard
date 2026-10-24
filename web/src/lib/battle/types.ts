/** Card Battle (`CardBattle.sol`) interface, mirrored for the web client. */

export type BattleStatus = 'Open' | 'Active' | 'P1Won' | 'P2Won';

export type BattleSide = 1 | 2;

/** 0 before `joinMatch` picks the first player. */
export type BattleTurn = 0 | BattleSide;

/**
 * One onchain match (BATTLE-SPEC v3). Card stats are parallel arrays indexed by draw number:
 * draw 0 is the first card drawn, draw 9 the last. Ids are decimal strings.
 */
export type MatchView = {
  id: string;
  p1: string;
  p2: string;
  status: BattleStatus;
  turn: BattleTurn;
  score1: number;
  score2: number;
  lastMoveBlock: number;
  /** Special already used (once per match per player). */
  special1: boolean;
  special2: boolean;
  /** Draws made so far, 0..10; the pile has `10 - drawn` cards left. */
  drawn1: number;
  drawn2: number;
  /** Bitmask of draw numbers that were placed on the board. */
  placed1: number;
  placed2: number;
  el1: number[];
  el2: number[];
  rar1: number[];
  rar2: number[];
  atk1: number[];
  atk2: number[];
  maxHp1: number[];
  maxHp2: number[];
  hp1: number[];
  hp2: number[];
  /** Three board slots; `255` is an empty slot. */
  board1: number[];
  board2: number[];
};

/** `{ type: 'matches' }` WebSocket message (BATTLE-SPEC, server section). */
export type MatchesMsg = {
  type: 'matches';
  block: string;
  featuredId: string | null;
  matches: MatchView[];
};

export type MatchOutcome = 'Victory' | 'Defeat' | null;

export type AgentBattleResult = { ok: true } | { ok: false; reason: string };
