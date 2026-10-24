import type { Hex } from '@nad/shared';
import { describe, expect, test } from 'vitest';
import {
  BOARD_EMPTY,
  NO_PLACEMENT,
  battleAction,
  choosePlacement,
  decideBattleSpecial,
  decodeMatches,
  elementMult,
  damageOf,
  frontDrawNo,
  handOf,
  isFinishedMatch,
  matchWindow,
  openSlot,
  pickFeaturedMatch,
  timeoutDue,
  totalDamage,
  type BattleMatch,
} from '../src/battle';
import { createWsHubCore, type MatchesMsg } from '../src/ws';

const P1 = '0x0000000000000000000000000000000000000001' as Hex;
const P2 = '0x0000000000000000000000000000000000000002' as Hex;
const BOT = '0x00000000000000000000000000000000000000b0' as Hex;

const zeros = (n: number): number[] => new Array<number>(n).fill(0);

function rawMatch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    p1: P1,
    p2: P2,
    status: 1,
    turn: 2,
    score1: 0,
    score2: 0,
    lastMoveBlock: 100,
    special1: false,
    special2: false,
    drawn1: 2,
    drawn2: 2,
    placed1: 0,
    placed2: 0,
    el1: zeros(10),
    el2: zeros(10),
    rar1: zeros(10),
    rar2: zeros(10),
    atk1: zeros(10),
    atk2: zeros(10),
    maxHp1: zeros(10),
    maxHp2: zeros(10),
    hp1: zeros(10),
    hp2: zeros(10),
    board1: [BOARD_EMPTY, BOARD_EMPTY, BOARD_EMPTY],
    board2: [BOARD_EMPTY, BOARD_EMPTY, BOARD_EMPTY],
    ...over,
  };
}

function decoded(over: Partial<BattleMatch> = {}): BattleMatch {
  return decodeMatches([rawMatch()], 1n)[0] as BattleMatch;
}

function match(over: Partial<BattleMatch> = {}): BattleMatch {
  return { ...decoded(), ...over };
}

describe('decodeMatches (v3)', () => {
  test('maps every MatchView field and numbers ids from the 1-based fromId', () => {
    const raw = rawMatch({
      status: 2,
      turn: 1,
      score1: 1,
      score2: 0,
      drawn1: 3,
      placed1: 0b101,
      special1: true,
      el1: [0, 1, 2, 0, 0, 0, 0, 0, 0, 0],
      atk1: [10, 20, 30, 0, 0, 0, 0, 0, 0, 0],
      maxHp1: [1500, 1600, 1700, 0, 0, 0, 0, 0, 0, 0],
      hp1: [0, 1600, 1700, 0, 0, 0, 0, 0, 0, 0],
      board1: [1, 2, BOARD_EMPTY],
    });
    const [m] = decodeMatches([raw], 7n);
    expect(m?.id).toBe('7');
    expect(m?.status).toBe('P1Won');
    expect(m?.drawn1).toBe(3);
    expect(m?.placed1).toBe(5);
    expect(m?.board1).toEqual([1, 2, BOARD_EMPTY]);
    expect(m?.hp1[0]).toBe(0);
  });

  test('increments ids within one page', () => {
    const page = decodeMatches([rawMatch(), rawMatch()], 5n);
    expect(page.map((m) => m.id)).toEqual(['5', '6']);
  });

  test('rejects malformed structs instead of emitting NaN', () => {
    expect(() => decodeMatches([rawMatch({ el1: [0] })], 1n)).toThrow(/el1/);
    expect(() => decodeMatches([rawMatch({ status: 9 })], 1n)).toThrow(/status/);
    expect(() => decodeMatches([rawMatch({ special1: 1 })], 1n)).toThrow(/special1/);
  });
});

describe('matchWindow', () => {
  test('is 1-based and empty for no matches', () => {
    expect(matchWindow(0n)).toEqual({ from: 1n, count: 0n });
  });
  test('starts at 1 while there are fewer than 64 matches', () => {
    expect(matchWindow(3n)).toEqual({ from: 1n, count: 3n });
    expect(matchWindow(64n)).toEqual({ from: 1n, count: 64n });
  });
  test('covers the last 64 ids when there are more', () => {
    expect(matchWindow(70n)).toEqual({ from: 7n, count: 64n });
  });
});

describe('damage', () => {
  test('uses the v3 DAMAGE_SCALE of 35 and the 150/100/75 triangle', () => {
    expect(elementMult(0, 2)).toBe(150); // Fire beats Lightning
    expect(elementMult(1, 0)).toBe(150); // Water beats Fire
    expect(elementMult(2, 1)).toBe(150); // Lightning beats Water
    expect(elementMult(0, 1)).toBe(75);
    expect(elementMult(2, 2)).toBe(100);
    expect(damageOf(30, 0, 1, false)).toBe(787);
    expect(damageOf(30, 0, 1, true)).toBe(1574);
    expect(damageOf(40, 0, 2, false)).toBe(2100);
  });
});

describe('hand and board', () => {
  test('hand = drawn numbers without their placed bit', () => {
    const m = match({ drawn2: 4, placed2: 0b0101 });
    expect(handOf(m, 2)).toEqual([1, 3]);
  });

  test('openSlot is the smallest empty slot and front is the smallest occupied slot', () => {
    const m = match({ board2: [1, BOARD_EMPTY, 2] });
    expect(openSlot(m, 2)).toBe(1);
    expect(frontDrawNo(m, 2)).toBe(1);
    expect(frontDrawNo(match({ board2: [BOARD_EMPTY, BOARD_EMPTY, BOARD_EMPTY] }), 2)).toBeNull();
  });
});

describe('choosePlacement', () => {
  test('picks the hand card that hits the enemy front hardest, not just the highest ATK', () => {
    const m = match({
      drawn2: 2,
      placed2: 0,
      el2: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0], // draw 0 Fire, draw 1 Water
      atk2: [100, 120, 0, 0, 0, 0, 0, 0, 0, 0],
      maxHp2: [1500, 1500, 0, 0, 0, 0, 0, 0, 0, 0],
      hp2: [1500, 1500, 0, 0, 0, 0, 0, 0, 0, 0],
      el1: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0], // enemy Lightning
      hp1: [2000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      board1: [0, BOARD_EMPTY, BOARD_EMPTY],
    });
    expect(choosePlacement(m, 2)).toBe(0); // 150 > 90
  });

  test('returns 255 for a full board, and places the incoming draw when the hand is empty', () => {
    expect(choosePlacement(match({ board2: [0, 1, 2] }), 2)).toBe(NO_PLACEMENT);
    // act draws before placing, so the fresh draw number is a valid hand index.
    expect(choosePlacement(match({ drawn2: 2, placed2: 0b11 }), 2)).toBe(2);
    expect(choosePlacement(match({ drawn2: 10, placed2: 0b1111111111 }), 2)).toBe(NO_PLACEMENT);
  });
});

describe('battleAction', () => {
  const policy = { skillHpThreshold: 30, finisher: true };

  test('places the strongest card and spends Special when the doubled damage KOs the front', () => {
    const m = match({
      drawn2: 1,
      placed2: 0,
      el2: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      atk2: [40, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      maxHp2: [1500, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hp2: [1500, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      el1: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hp1: [2000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      maxHp1: [2000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      board1: [0, BOARD_EMPTY, BOARD_EMPTY],
    });
    // 40 × 35 × 150% = 2100 strike, 4200 special ≥ 2000, and the placed card is already counted.
    expect(totalDamage(m, 2, true)).toBe(0);
    expect(battleAction(m, policy, 2)).toEqual({ handIdx: 0, special: true });
  });

  test('uses Special when the own front card is at or below the policy HP threshold', () => {
    const m = match({
      drawn2: 1,
      placed2: 0b1,
      atk2: [30, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      maxHp2: [2000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hp2: [600, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 30%
      el1: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      maxHp1: [9999, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hp1: [9999, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      board1: [0, BOARD_EMPTY, BOARD_EMPTY],
      board2: [0, BOARD_EMPTY, BOARD_EMPTY],
    });
    expect(decideBattleSpecial(m, policy, 2)).toBe(true);
  });

  test('never spends Special twice, without attackers, or with no enemy front', () => {
    expect(decideBattleSpecial(match({ special2: true }), policy, 2)).toBe(false);
    expect(decideBattleSpecial(match(), policy, 2)).toBe(false);
    const noFront = match({
      drawn2: 1,
      placed2: 0b1,
      atk2: [9999, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      maxHp2: [9999, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hp2: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      board2: [0, BOARD_EMPTY, BOARD_EMPTY],
    });
    expect(decideBattleSpecial(noFront, policy, 2)).toBe(false);
  });

  test('respects the finisher flag', () => {
    const m = match({
      drawn2: 1,
      placed2: 0,
      atk2: [40, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      maxHp2: [1500, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hp2: [1500, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      el1: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hp1: [2000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      maxHp1: [2000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      board1: [0, BOARD_EMPTY, BOARD_EMPTY],
    });
    expect(battleAction(m, { ...policy, finisher: false }, 2).special).toBe(false);
  });
});

describe('match status helpers', () => {
  test('isFinishedMatch only for decided matches', () => {
    expect(isFinishedMatch(match({ status: 'P1Won' }))).toBe(true);
    expect(isFinishedMatch(match({ status: 'P2Won' }))).toBe(true);
    expect(isFinishedMatch(match({ status: 'Active' }))).toBe(false);
  });

  test('timeoutDue is 100 blocks after the last move, only while Active', () => {
    const m = match({ status: 'Active', lastMoveBlock: 500 });
    expect(timeoutDue(m, 599)).toBe(false);
    expect(timeoutDue(m, 600)).toBe(true);
    expect(timeoutDue(match({ status: 'P1Won', lastMoveBlock: 0 }), 10_000)).toBe(false);
  });

  test('pickFeaturedMatch prefers a human Active match, then any human match', () => {
    const bots = new Set<Hex>([BOT]);
    const matches = [
      match({ id: '1', status: 'Active', p2: BOT }),
      match({ id: '2', status: 'Active' }),
      match({ id: '3', status: 'P1Won' }),
    ];
    expect(pickFeaturedMatch(matches, bots)).toBe('2');
    expect(pickFeaturedMatch([matches[2] as BattleMatch], bots)).toBe('3');
    expect(pickFeaturedMatch([], bots)).toBeNull();
  });
});

describe('matches over WS', () => {
  test('scope all receives the snapshot; scope match:<id> keeps only its own match', () => {
    const hub = createWsHubCore();
    const all: string[] = [];
    const scoped: string[] = [];
    hub.add({ send: (data) => void all.push(data) }, 'all');
    hub.add({ send: (data) => void scoped.push(data) }, { matchId: '2' });

    const msg: MatchesMsg = {
      type: 'matches',
      block: '100',
      featuredId: '1',
      matches: [match({ id: '1' }), match({ id: '2' })],
    };
    hub.broadcast(msg);

    expect(JSON.parse(all[0] as string)).toEqual(msg);
    const projected = JSON.parse(scoped[0] as string) as MatchesMsg;
    expect(projected.matches.map((m) => m.id)).toEqual(['2']);
    expect(projected.block).toBe('100');
    expect(hub.subscribedMatchIds()).toEqual(new Set(['2']));
  });
});