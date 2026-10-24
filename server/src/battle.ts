import type { Hex } from '@nad/shared';

/** Card Battle constants from BATTLE-SPEC.md v3. */
export const TURN_TIMEOUT_BLOCKS = 100;
/** Matches read per poll: the most recent ones; older matches are long finished. */
export const MATCH_WINDOW_SIZE = 64;
export const DAMAGE_SCALE = 35;
export const MAX_DRAWS = 10;
export const BOARD_SLOTS = 3;
/** `boardN[slot]` value meaning "empty slot". */
export const BOARD_EMPTY = 255;
/** `handIdx` meaning "do not place a card this turn". */
export const NO_PLACEMENT = 255;

export type BattleStatus = 'Open' | 'Active' | 'P1Won' | 'P2Won';
export type Side = 1 | 2;

/** JSON shape of the on-chain `MatchView`, broadcast over WS as-is (id as a decimal string). */
export type BattleMatch = {
  id: string;
  p1: Hex;
  p2: Hex;
  status: BattleStatus;
  /** 1 = p1 moves, 2 = p2; 0 while the match is Open. */
  turn: number;
  score1: number;
  score2: number;
  lastMoveBlock: number;
  /** True when that side already spent its once-per-match Special. */
  special1: boolean;
  special2: boolean;
  /** Number of cards drawn so far (0..10). */
  drawn1: number;
  drawn2: number;
  /** Bitmask of draw numbers already placed on the board. */
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
  /** Draw number in each of the 3 board slots; 255 = empty. */
  board1: number[];
  board2: number[];
};

/** Index-aligned with the `Status` enum in CardBattle.sol. */
const STATUS_NAMES: readonly BattleStatus[] = ['Open', 'Active', 'P1Won', 'P2Won'];

type RawMatch = Record<string, unknown>;

function num(raw: RawMatch, field: string): number {
  const value = raw[field];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`decodeMatches: field "${field}" is not numeric`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`decodeMatches: field "${field}" is not a non-negative integer`);
  }
  return parsed;
}

function flag(raw: RawMatch, field: string): boolean {
  const value = raw[field];
  if (typeof value !== 'boolean') throw new Error(`decodeMatches: field "${field}" is not a boolean`);
  return value;
}

function addr(raw: RawMatch, field: string): Hex {
  const value = raw[field];
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`decodeMatches: field "${field}" is not an address`);
  }
  return value as Hex;
}

function fixedNums(raw: RawMatch, field: string, length: number): number[] {
  const value = raw[field];
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`decodeMatches: field "${field}" is not a ${length}-element array`);
  }
  return value.map((entry, index) => {
    const parsed = Number(entry);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`decodeMatches: field "${field}[${index}]" is not a non-negative integer`);
    }
    return parsed;
  });
}

function statusName(raw: RawMatch): BattleStatus {
  const index = num(raw, 'status');
  const name = STATUS_NAMES[index];
  if (name === undefined) throw new Error(`decodeMatches: unknown status ${index}`);
  return name;
}

/** Convert viem-decoded `getMatches(from, count)` structs into BattleMatch views. `fromId` is 1-based. */
export function decodeMatches(raw: readonly unknown[], fromId: bigint): BattleMatch[] {
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`decodeMatches: element ${index} is not an object`);
    }
    const m = entry as RawMatch;
    return {
      id: (fromId + BigInt(index)).toString(),
      p1: addr(m, 'p1'),
      p2: addr(m, 'p2'),
      status: statusName(m),
      turn: num(m, 'turn'),
      score1: num(m, 'score1'),
      score2: num(m, 'score2'),
      lastMoveBlock: num(m, 'lastMoveBlock'),
      special1: flag(m, 'special1'),
      special2: flag(m, 'special2'),
      drawn1: num(m, 'drawn1'),
      drawn2: num(m, 'drawn2'),
      placed1: num(m, 'placed1'),
      placed2: num(m, 'placed2'),
      el1: fixedNums(m, 'el1', MAX_DRAWS),
      el2: fixedNums(m, 'el2', MAX_DRAWS),
      rar1: fixedNums(m, 'rar1', MAX_DRAWS),
      rar2: fixedNums(m, 'rar2', MAX_DRAWS),
      atk1: fixedNums(m, 'atk1', MAX_DRAWS),
      atk2: fixedNums(m, 'atk2', MAX_DRAWS),
      maxHp1: fixedNums(m, 'maxHp1', MAX_DRAWS),
      maxHp2: fixedNums(m, 'maxHp2', MAX_DRAWS),
      hp1: fixedNums(m, 'hp1', MAX_DRAWS),
      hp2: fixedNums(m, 'hp2', MAX_DRAWS),
      board1: fixedNums(m, 'board1', BOARD_SLOTS),
      board2: fixedNums(m, 'board2', BOARD_SLOTS),
    };
  });
}

/** Same triangle as BlitzArena: beating element 150, same 100, losing 75. */
export function elementMult(a: number, d: number): number {
  if ((d + 1) % 3 === a) return 150;
  if (a === d) return 100;
  return 75;
}

/** Strike (or Special) damage, mirroring `CardBattle.damageOf`: atk × 35 × mult / 100. */
export function damageOf(atk: number, a: number, d: number, special: boolean): number {
  const base = Math.floor((atk * DAMAGE_SCALE * elementMult(a, d)) / 100);
  return special ? base * 2 : base;
}

const enemyOf = (side: Side): Side => (side === 1 ? 2 : 1);

/** Card stat arrays of one side, resolved once. */
type SideCards = {
  el: readonly number[];
  atk: readonly number[];
  maxHp: readonly number[];
  hp: readonly number[];
  board: readonly number[];
};

function cardsOf(match: BattleMatch, side: Side): SideCards {
  return side === 1
    ? { el: match.el1, atk: match.atk1, maxHp: match.maxHp1, hp: match.hp1, board: match.board1 }
    : { el: match.el2, atk: match.atk2, maxHp: match.maxHp2, hp: match.hp2, board: match.board2 };
}

/** Draw numbers still in hand: drawn, not yet placed. */
export function handOf(match: BattleMatch, side: Side): number[] {
  const drawn = side === 1 ? match.drawn1 : match.drawn2;
  const placed = side === 1 ? match.placed1 : match.placed2;
  const hand: number[] = [];
  for (let i = 0; i < drawn; i += 1) if (((placed >> i) & 1) === 0) hand.push(i);
  return hand;
}

/** Index of the smallest empty board slot, or null when all three are occupied. */
export function openSlot(match: BattleMatch, side: Side): number | null {
  const board = cardsOf(match, side).board;
  for (let i = 0; i < BOARD_SLOTS; i += 1) if (board[i] === BOARD_EMPTY) return i;
  return null;
}

/** Draw number in the enemy's front slot (smallest occupied index), or null when the board is empty. */
export function frontDrawNo(match: BattleMatch, side: Side): number | null {
  const board = cardsOf(match, side).board;
  for (let i = 0; i < BOARD_SLOTS; i += 1) {
    const drawNo = board[i];
    if (drawNo !== undefined && drawNo !== BOARD_EMPTY) return drawNo;
  }
  return null;
}

/** Draw numbers of every card on that side's board, in slot order. */
export function boardDrawNos(match: BattleMatch, side: Side): number[] {
  return cardsOf(match, side).board.filter((drawNo) => drawNo !== BOARD_EMPTY);
}

export function frontHp(match: BattleMatch, side: Side): number | null {
  const drawNo = frontDrawNo(match, side);
  if (drawNo === null) return null;
  return cardsOf(match, side).hp[drawNo] ?? null;
}

/** Damage one card of `side` would deal to the enemy front, 0 without an enemy front. */
export function damageFor(match: BattleMatch, side: Side, drawNo: number, special: boolean): number {
  const foe = enemyOf(side);
  const target = frontDrawNo(match, foe);
  if (target === null) return 0;
  const mine = cardsOf(match, side);
  const theirs = cardsOf(match, foe);
  const atk = mine.atk[drawNo];
  const el = mine.el[drawNo];
  const targetEl = theirs.el[target];
  if (atk === undefined || el === undefined || targetEl === undefined) return 0;
  return damageOf(atk, el, targetEl, special);
}

/** Total damage of every attacking card on `side`'s board. */
export function totalDamage(match: BattleMatch, side: Side, special: boolean): number {
  return boardDrawNos(match, side).reduce((sum, drawNo) => sum + damageFor(match, side, drawNo, special), 0);
}

/**
 * Hand index to place this turn: the card that hits the enemy front hardest, then
 * the highest raw ATK, then the highest max HP, then the lowest draw number.
 * 255 when the board is full. When the known hand is empty but the pile still has
 * a card, place the card that `act` is about to draw (draw number = drawn).
 */
export function choosePlacement(match: BattleMatch, side: Side = 2): number {
  if (openSlot(match, side) === null) return NO_PLACEMENT;
  const drawn = side === 1 ? match.drawn1 : match.drawn2;
  const hand = handOf(match, side);
  if (hand.length === 0) return drawn < MAX_DRAWS ? drawn : NO_PLACEMENT;
  const cards = cardsOf(match, side);
  const target = frontDrawNo(match, enemyOf(side));
  const score = (drawNo: number): [number, number, number, number] => {
    const damage = target === null ? (cards.atk[drawNo] ?? 0) : damageFor(match, side, drawNo, false);
    return [damage, cards.atk[drawNo] ?? 0, cards.maxHp[drawNo] ?? 0, -drawNo];
  };
  const best = hand.reduce((winner, drawNo) => {
    const a = score(drawNo);
    const b = score(winner);
    for (let i = 0; i < a.length; i += 1) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff > 0 ? drawNo : winner;
    }
    return winner;
  });
  return best;
}

/** True when this side has at least one attacker and the enemy has a front card to hit. */
export function canAttack(match: BattleMatch, side: Side): boolean {
  return boardDrawNos(match, side).length > 0 && frontDrawNo(match, enemyOf(side)) !== null;
}

/**
 * Special policy in the `decideSkill` style: spend the once-per-match Special when
 * the own front card is at/below the policy HP threshold, or when the doubled
 * damage would knock out the enemy front. Never spend it when no attack lands.
 * `placed` is the hand index about to be placed this turn (255 = none), so a card
 * that enters the board now counts towards both the front HP and the damage.
 */
export function decideBattleSpecial(
  match: BattleMatch,
  policy: { skillHpThreshold: number; finisher: boolean },
  side: Side = 2,
  placed: number = NO_PLACEMENT,
): boolean {
  const used = side === 1 ? match.special1 : match.special2;
  const cards = cardsOf(match, side);
  const slot = openSlot(match, side);
  const board = [...cards.board];
  if (placed !== NO_PLACEMENT && slot !== null && board[slot] === BOARD_EMPTY) board[slot] = placed;
  const attackers = board.filter((drawNo) => drawNo !== BOARD_EMPTY);
  const target = frontDrawNo(match, enemyOf(side));
  if (used || attackers.length === 0 || target === null) return false;

  // Board order is slot order, so the first occupied slot is the front card.
  const ownFront = attackers[0];
  if (ownFront !== undefined) {
    const hp = cards.hp[ownFront] ?? 0;
    const maxHp = cards.maxHp[ownFront] ?? 0;
    if (maxHp > 0 && (hp * 100) / maxHp <= policy.skillHpThreshold) return true;
  }

  if (!policy.finisher) return false;
  const targetHp = cardsOf(match, enemyOf(side)).hp[target] ?? 0;
  const damage = attackers.reduce((sum, drawNo) => sum + damageFor(match, side, drawNo, true), 0);
  return damage >= targetHp;
}

/** The next `act` arguments for this side. */
export function battleAction(
  match: BattleMatch,
  policy: { skillHpThreshold: number; finisher: boolean },
  side: Side = 2,
): { handIdx: number; special: boolean } {
  const handIdx = choosePlacement(match, side);
  return { handIdx, special: decideBattleSpecial(match, policy, side, handIdx) };
}

export const isFinishedMatch = (m: BattleMatch): boolean => m.status === 'P1Won' || m.status === 'P2Won';

/** `from` is a 1-based match id, matching the contract; id 0 is never returned. */
export function matchWindow(count: bigint, size = MATCH_WINDOW_SIZE): { from: bigint; count: bigint } {
  if (count === 0n) return { from: 1n, count: 0n };
  const windowSize = count < BigInt(size) ? count : BigInt(size);
  return { from: count - windowSize + 1n, count: windowSize };
}

const newestId = (matches: readonly BattleMatch[]): string | null =>
  matches.reduce<bigint | null>((best, m) => (best === null || BigInt(m.id) > best ? BigInt(m.id) : best), null)?.toString() ??
  null;

/** Newest Active match without a bot, else the newest match without a bot, else the newest match. */
export function pickFeaturedMatch(matches: readonly BattleMatch[], bots: ReadonlySet<Hex>): string | null {
  const human = matches.filter((m) => !bots.has(m.p1.toLowerCase() as Hex) && !bots.has(m.p2.toLowerCase() as Hex));
  return newestId(human.filter((m) => m.status === 'Active')) ?? newestId(human) ?? newestId(matches);
}

/** True when the player who owns the turn has run out of blocks. */
export function timeoutDue(m: BattleMatch, block: number): boolean {
  return m.status === 'Active' && block >= m.lastMoveBlock + TURN_TIMEOUT_BLOCKS;
}