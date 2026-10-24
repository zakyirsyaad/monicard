import { describe, expect, test } from 'vitest';
import {
  COUNTDOWN_BLOCKS,
  DUEL_BLOCKS,
  ELEMENTS,
  MAX_TAPS_PER_BLOCK,
  MAX_TAPS_PER_TX,
  RARITIES,
  RARITY_ODDS,
  allowedTaps,
  decodeDuels,
  elementMult,
  skillDamage,
  strongAgainst,
  tapDamage,
  weakTo,
} from '../src/index';

describe('constants', () => {
  test('mirror BlitzArena.sol', () => {
    expect(COUNTDOWN_BLOCKS).toBe(10);
    expect(DUEL_BLOCKS).toBe(67);
    expect(MAX_TAPS_PER_BLOCK).toBe(3);
    expect(MAX_TAPS_PER_TX).toBe(30);
    expect([...ELEMENTS]).toEqual(['Fire', 'Water', 'Lightning']);
    expect([...RARITIES]).toEqual(['Common', 'Rare', 'Epic', 'Legendary']);
    expect([...RARITY_ODDS]).toEqual([60, 28, 10, 2]);
    expect(RARITY_ODDS.reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('formulas', () => {
  test('element multiplier follows (d+1)%3==a', () => {
    expect(elementMult(1, 0)).toBe(150);
    expect(elementMult(0, 1)).toBe(75);
    expect(elementMult(0, 2)).toBe(150);
    expect(elementMult(2, 2)).toBe(100);
  });

  test('allowed taps clamps by blocks and per-tx cap', () => {
    expect(allowedTaps(20, 3)).toBe(9);
    expect(allowedTaps(40, 20)).toBe(30);
    expect(allowedTaps(5, 0)).toBe(0);
  });

  test('allowed taps never goes negative', () => {
    expect(allowedTaps(5, -2)).toBe(0);
    expect(allowedTaps(0, 10)).toBe(0);
  });

  test('tap damage', () => {
    expect(tapDamage(9, 12, 150)).toBe(162);
  });

  test('tap damage floors like solidity integer division', () => {
    expect(tapDamage(1, 11, 75)).toBe(8); // 825 / 100
  });

  test('skill damage at full and 10% hp', () => {
    expect(skillDamage(12, 100, 1500, 1500)).toBe(120);
    expect(skillDamage(12, 100, 150, 1500)).toBe(552);
  });

  test('skill damage clamps missing hp at zero when hp exceeds maxHp', () => {
    expect(skillDamage(12, 100, 2000, 1500)).toBe(120);
  });

  test('advantage helpers', () => {
    expect(strongAgainst(2)).toBe(1);
    expect(weakTo(2)).toBe(0);
    expect(strongAgainst(0)).toBe(2);
  });

  test('advantage helpers agree with elementMult', () => {
    for (const e of [0, 1, 2]) {
      expect(elementMult(e, strongAgainst(e))).toBe(150);
      expect(elementMult(e, weakTo(e))).toBe(75);
    }
  });
});

describe('decodeDuels', () => {
  const P1 = '0x1111111111111111111111111111111111111111';
  const P2 = '0x2222222222222222222222222222222222222222';
  const raw = {
    p1: P1,
    hp1: 1500,
    atk1: 12,
    mult1: 150,
    lastBlock1: 1010,
    skill1: false,
    status: 1,
    p2: P2,
    hp2: 1400,
    atk2: 11,
    mult2: 75,
    lastBlock2: 1012,
    skill2: true,
    startBlock: 1010,
    card1: 7,
    card2: 9,
    maxHp1: 1500,
    maxHp2: 1450,
    settled: false,
  };

  test('computes endBlock, id and status names', () => {
    const [d] = decodeDuels([raw], 5n);
    expect(d).toEqual({
      id: '5',
      p1: P1,
      p2: P2,
      hp1: 1500,
      hp2: 1400,
      atk1: 12,
      atk2: 11,
      mult1: 150,
      mult2: 75,
      lastBlock1: 1010,
      lastBlock2: 1012,
      skill1: false,
      skill2: true,
      status: 'Active',
      startBlock: 1010,
      endBlock: 1010 + 67,
      card1: 7,
      card2: 9,
      maxHp1: 1500,
      maxHp2: 1450,
      settled: false,
    });
  });

  test('assigns sequential ids from fromId', () => {
    const out = decodeDuels([raw, raw, raw], 100n);
    expect(out.map((d) => d.id)).toEqual(['100', '101', '102']);
  });

  test('maps every status index', () => {
    const names = [0, 1, 2, 3, 4].map((s) => decodeDuels([{ ...raw, status: s }], 0n)[0]?.status);
    expect(names).toEqual(['Open', 'Active', 'P1Won', 'P2Won', 'Draw']);
  });

  test('coerces bigint-valued fields to numbers', () => {
    const [d] = decodeDuels(
      [{ ...raw, hp1: 1500n, atk2: 11n, startBlock: 2000n, status: 2n, card1: 7n, settled: true }],
      0n,
    );
    expect(d?.hp1).toBe(1500);
    expect(d?.atk2).toBe(11);
    expect(d?.startBlock).toBe(2000);
    expect(d?.endBlock).toBe(2067);
    expect(d?.status).toBe('P1Won');
    expect(d?.card1).toBe(7);
    expect(d?.settled).toBe(true);
  });

  test('returns empty array for empty input', () => {
    expect(decodeDuels([], 0n)).toEqual([]);
  });

  test('rejects an out-of-range status', () => {
    expect(() => decodeDuels([{ ...raw, status: 9 }], 0n)).toThrow();
  });
});
