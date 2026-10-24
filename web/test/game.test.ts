import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_BLOCKS,
  DUEL_BLOCKS,
  ELEMENTS,
  MAX_TAPS_PER_BLOCK,
  MAX_TAPS_PER_TX,
  NADMON,
  RARITIES,
  RARITY_ODDS,
  allowedTaps,
  elementMult,
  nadmonFor,
  skillDamage,
  strongAgainst,
  tapDamage,
  weakTo,
} from '../src/lib/game';
import { ELEMENT_NAMES, RARITY_NAMES } from '../src/lib/labels';

describe('game constants', () => {
  it('matches the frozen Task 4 values', () => {
    expect(COUNTDOWN_BLOCKS).toBe(10);
    expect(DUEL_BLOCKS).toBe(67);
    expect(MAX_TAPS_PER_BLOCK).toBe(3);
    expect(MAX_TAPS_PER_TX).toBe(30);
    expect(ELEMENTS).toEqual(['Fire', 'Water', 'Lightning']);
    expect(RARITIES).toEqual(['Common', 'Rare', 'Epic', 'Legendary']);
    expect(RARITY_ODDS).toEqual([60, 28, 10, 2]);
  });

  it('labels derive their name arrays from game', () => {
    expect(ELEMENT_NAMES).toBe(ELEMENTS);
    expect(RARITY_NAMES).toBe(RARITIES);
  });
});

describe('game formulas (Task 4 vectors)', () => {
  it('elementMult', () => {
    expect(elementMult(1, 0)).toBe(150);
    expect(elementMult(0, 1)).toBe(75);
    expect(elementMult(0, 2)).toBe(150);
    expect(elementMult(2, 2)).toBe(100);
  });

  it('allowedTaps', () => {
    expect(allowedTaps(20, 3)).toBe(9);
    expect(allowedTaps(40, 20)).toBe(30);
    expect(allowedTaps(5, 0)).toBe(0);
    expect(allowedTaps(5, -2)).toBe(0);
  });

  it('tapDamage', () => {
    expect(tapDamage(9, 12, 150)).toBe(162);
  });

  it('skillDamage', () => {
    expect(skillDamage(12, 100, 1500, 1500)).toBe(120);
    expect(skillDamage(12, 100, 150, 1500)).toBe(552);
  });

  it('nadmonFor', () => {
    expect(nadmonFor(2, 0).id).toBe('sparkit');
    expect(nadmonFor(2, 1).id).toBe('sparkit');
    expect(nadmonFor(2, 2).id).toBe('voltnad');
    expect(nadmonFor(1, 3).id).toBe('abyssnad');
  });

  it('strongAgainst / weakTo', () => {
    expect(strongAgainst(2)).toBe(1);
    expect(weakTo(2)).toBe(0);
    expect(strongAgainst(0)).toBe(2);
  });

  it('NADMON has 9 entries with evolution chains', () => {
    expect(NADMON).toHaveLength(9);
    expect(NADMON.find((n) => n.id === 'blazenad')).toEqual({
      id: 'blazenad',
      name: 'Blazenad',
      element: 0,
      stage: 2,
      evolvesFrom: 'embrit',
    });
    expect(NADMON.find((n) => n.id === 'dripnad')?.evolvesFrom).toBeNull();
  });
});
