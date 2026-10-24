import { elementMult, nadmonFor } from '../game';
import type { BattleSide, BattleStatus, BattleTurn, MatchOutcome, MatchView } from './types';

export { elementMult };

/** `CardBattle` constants (BATTLE-SPEC v3). */
export const DAMAGE_SCALE = 35;
export const MAX_DRAWS = 10;
export const BOARD_SLOTS = 3;
export const WIN_SCORE = 2;
export const TURN_TIMEOUT_BLOCKS = 100;
/** Monad block time, 0.3 s: used only for the on-screen turn clock. */
export const BLOCK_SECONDS = 0.3;
export const EMPTY_SLOT = 255;
/** `act(id, handIdx, special)` with 255 = do not place a card this turn. */
export const NO_PLACE = 255;

const STATUS_BY_INDEX: readonly BattleStatus[] = ['Open', 'Active', 'P1Won', 'P2Won'];
const ARRAY_10 = 10;
const ARRAY_3 = 3;

export const otherSide = (side: BattleSide): BattleSide => (side === 1 ? 2 : 1);

export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** One board card as drawn: draw number, onchain stats and the matching Nadmon species. */
export type DrawCard = {
  drawNo: number;
  element: number;
  rarity: number;
  atk: number;
  maxHp: number;
  hp: number;
  nadmon: { id: string; name: string; stage: 1 | 2 | 3 };
};

/** The slice of a match that belongs to one player. */
export type SideData = {
  address: string;
  drawn: number;
  placed: number;
  specialUsed: boolean;
  score: number;
  el: number[];
  rar: number[];
  atk: number[];
  maxHp: number[];
  hp: number[];
  board: number[];
};

/** Strike damage: atk × 35 × elementMultiplier / 100, floored like Solidity. */
export function strikeDamage(atk: number, attackerEl: number, defenderEl: number): number {
  return Math.floor((atk * DAMAGE_SCALE * elementMult(attackerEl, defenderEl)) / 100);
}

/** Special = 2 × the summed strike damage (once per match per player). */
export function specialDamage(atk: number, attackerEl: number, defenderEl: number): number {
  return 2 * strikeDamage(atk, attackerEl, defenderEl);
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function toStatus(value: unknown): BattleStatus {
  if (typeof value === 'string' && (STATUS_BY_INDEX as readonly string[]).includes(value)) {
    return value as BattleStatus;
  }
  const index = toNumber(value, -1);
  return STATUS_BY_INDEX[index] ?? 'Open';
}

function toFixedArray(value: unknown, length: number, fallback: (index: number) => number): number[] {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, i) => toNumber(source[i], fallback(i)));
}

function clampDrawn(value: number): number {
  return Math.min(MAX_DRAWS, Math.max(0, Math.floor(value)));
}

/**
 * Accepts either a WS JSON match or a viem-decoded `getMatch` struct and returns the client shape.
 * Returns null when the object cannot be a match (bad id).
 */
export function normalizeMatch(input: unknown): MatchView | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const id = raw.id;
  if (id === undefined || id === null) return null;
  const idText = typeof id === 'string' ? id : String(toNumber(id, -1));
  if (idText === '-1') return null;

  const turnValue = toNumber(raw.turn, 0);
  const turn: BattleTurn = turnValue === 1 || turnValue === 2 ? (turnValue as BattleSide) : 0;

  return {
    id: idText,
    p1: String(raw.p1 ?? ''),
    p2: String(raw.p2 ?? ''),
    status: toStatus(raw.status),
    turn,
    score1: Math.min(WIN_SCORE, toNumber(raw.score1)),
    score2: Math.min(WIN_SCORE, toNumber(raw.score2)),
    lastMoveBlock: toNumber(raw.lastMoveBlock),
    special1: raw.special1 === true,
    special2: raw.special2 === true,
    drawn1: clampDrawn(toNumber(raw.drawn1)),
    drawn2: clampDrawn(toNumber(raw.drawn2)),
    placed1: toNumber(raw.placed1),
    placed2: toNumber(raw.placed2),
    el1: toFixedArray(raw.el1, ARRAY_10, () => 0),
    el2: toFixedArray(raw.el2, ARRAY_10, () => 0),
    rar1: toFixedArray(raw.rar1, ARRAY_10, () => 0),
    rar2: toFixedArray(raw.rar2, ARRAY_10, () => 0),
    atk1: toFixedArray(raw.atk1, ARRAY_10, () => 0),
    atk2: toFixedArray(raw.atk2, ARRAY_10, () => 0),
    maxHp1: toFixedArray(raw.maxHp1, ARRAY_10, () => 0),
    maxHp2: toFixedArray(raw.maxHp2, ARRAY_10, () => 0),
    hp1: toFixedArray(raw.hp1, ARRAY_10, () => 0),
    hp2: toFixedArray(raw.hp2, ARRAY_10, () => 0),
    board1: toFixedArray(raw.board1, ARRAY_3, () => EMPTY_SLOT),
    board2: toFixedArray(raw.board2, ARRAY_3, () => EMPTY_SLOT),
  };
}

export function mySide(match: MatchView, address: string): BattleSide | null {
  if (sameAddress(match.p1, address)) return 1;
  if (sameAddress(match.p2, address)) return 2;
  return null;
}

export function sideAddress(match: MatchView, side: BattleSide): string {
  return side === 1 ? match.p1 : match.p2;
}

export function sideData(match: MatchView, side: BattleSide): SideData {
  return side === 1
    ? {
        address: match.p1,
        drawn: match.drawn1,
        placed: match.placed1,
        specialUsed: match.special1,
        score: match.score1,
        el: match.el1,
        rar: match.rar1,
        atk: match.atk1,
        maxHp: match.maxHp1,
        hp: match.hp1,
        board: match.board1,
      }
    : {
        address: match.p2,
        drawn: match.drawn2,
        placed: match.placed2,
        specialUsed: match.special2,
        score: match.score2,
        el: match.el2,
        rar: match.rar2,
        atk: match.atk2,
        maxHp: match.maxHp2,
        hp: match.hp2,
        board: match.board2,
      };
}

function safeNadmon(element: number, rarity: number): DrawCard['nadmon'] {
  try {
    return nadmonFor(element, rarity);
  } catch {
    return nadmonFor(0, 0);
  }
}

/** Card at a draw number; draw 0 is the first card drawn. */
export function cardAt(side: SideData, drawNo: number): DrawCard {
  const element = side.el[drawNo] ?? 0;
  const rarity = side.rar[drawNo] ?? 0;
  return {
    drawNo,
    element,
    rarity,
    atk: side.atk[drawNo] ?? 0,
    maxHp: side.maxHp[drawNo] ?? 0,
    hp: side.hp[drawNo] ?? 0,
    nadmon: safeNadmon(element, rarity),
  };
}

/** Draw numbers still in hand (drawn, not placed). */
export function handOf(side: SideData): number[] {
  const hand: number[] = [];
  for (let drawNo = 0; drawNo < side.drawn; drawNo += 1) {
    if ((side.placed & (1 << drawNo)) === 0) hand.push(drawNo);
  }
  return hand;
}

export function handCards(side: SideData): DrawCard[] {
  return handOf(side).map((drawNo) => cardAt(side, drawNo));
}

export function handCount(side: SideData): number {
  return handOf(side).length;
}

export function pileLeft(side: SideData): number {
  return Math.max(0, MAX_DRAWS - side.drawn);
}

/** Board slots in order; null = empty. */
export function boardCards(side: SideData): (DrawCard | null)[] {
  return side.board.map((drawNo) => (drawNo === EMPTY_SLOT || drawNo >= side.drawn ? null : cardAt(side, drawNo)));
}

/** Slot index of the front card (smallest filled slot) or null. */
export function frontSlot(side: SideData): number | null {
  const index = side.board.findIndex((drawNo) => drawNo !== EMPTY_SLOT);
  return index === -1 ? null : index;
}

/** The single card every attacker hits. */
export function frontCard(side: SideData): DrawCard | null {
  const slot = frontSlot(side);
  return slot === null ? null : cardAt(side, side.board[slot] as number);
}

/** First empty board slot, or -1 when the board is full. */
export function emptyBoardSlot(side: SideData): number {
  return side.board.findIndex((drawNo) => drawNo === EMPTY_SLOT);
}

export function boardSize(side: SideData): number {
  return side.board.filter((drawNo) => drawNo !== EMPTY_SLOT).length;
}

/** Summed strike damage of every card on the attacker's board against one target element. */
export function boardDamage(side: SideData, targetElement: number): number {
  return side.board.reduce((total, drawNo) => {
    if (drawNo === EMPTY_SLOT) return total;
    return total + strikeDamage(side.atk[drawNo] ?? 0, side.el[drawNo] ?? 0, targetElement);
  }, 0);
}

/** Damage this side would deal right now; 0 without an attacker or a target. */
export function estimateDamage(attacker: SideData, defender: SideData, special: boolean): number {
  const target = frontCard(defender);
  if (target === null) return 0;
  const total = boardDamage(attacker, target.element);
  return special ? total * 2 : total;
}

/** No cards on the board, in hand, or in the pile: the player loses automatically. */
export function isExhausted(side: SideData): boolean {
  return boardSize(side) === 0 && handCount(side) === 0 && pileLeft(side) === 0;
}

export function isFinal(match: MatchView): boolean {
  return match.status === 'P1Won' || match.status === 'P2Won';
}

export function outcomeFor(match: MatchView, side: BattleSide): MatchOutcome {
  if (!isFinal(match)) return null;
  return match.status === (side === 1 ? 'P1Won' : 'P2Won') ? 'Victory' : 'Defeat';
}

/** Blocks left before the player whose turn it is can be timed out (0 when the window is over). */
export function turnBlocksLeft(match: MatchView, block: number): number {
  if (match.status !== 'Active') return 0;
  return Math.max(0, match.lastMoveBlock + TURN_TIMEOUT_BLOCKS - block);
}

/** True when the opponent of the player to move may call `claimTimeout`. */
export function canClaimTimeout(match: MatchView, side: BattleSide, block: number): boolean {
  return match.status === 'Active' && match.turn !== 0 && match.turn !== side && turnBlocksLeft(match, block) === 0;
}

/** Advantage line for the side to act: only when the matchup is not neutral. */
export function advantageText(attacker: number, defender: number): string | null {
  const mult = elementMult(attacker, defender);
  if (mult === 150) return 'Super effective ×1.5';
  if (mult === 75) return 'Not very effective ×0.75';
  return null;
}

/** Damage the opponent lost between two snapshots (used for the floating number). */
export function damageBetween(prev: MatchView, next: MatchView, side: BattleSide): number {
  const before = side === 1 ? prev.hp1 : prev.hp2;
  const after = side === 1 ? next.hp1 : next.hp2;
  return before.reduce((total, hp, i) => total + Math.max(0, hp - (after[i] ?? 0)), 0);
}

export function drawIndexOf(match: MatchView, side: BattleSide, slot: number): number | null {
  const board = side === 1 ? match.board1 : match.board2;
  const drawNo = board[slot];
  return drawNo === undefined || drawNo === EMPTY_SLOT ? null : drawNo;
}
