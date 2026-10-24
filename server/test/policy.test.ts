import { describe, expect, test } from 'vitest';
import { skillDamage } from '@nad/shared';
import type { SideState } from '../src/sim/types';
import {
  DEFAULT_POLICY,
  agentTapRate,
  decideSkill,
  emptyAgentData,
  ignoreProbability,
  levelFromWins,
  rollDiscipline,
  type Policy,
} from '../src/agent/policy';

const side = (overrides: Partial<SideState> = {}): SideState => ({
  myHp: 1500,
  myMaxHp: 1500,
  oppHp: 1500,
  atk: 12,
  mult: 100,
  skillUsed: false,
  block: 100,
  endBlock: 167,
  lastBlock: 99,
  ...overrides,
});

const policy = (overrides: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...overrides });

// Tiny deterministic LCG (Numerical Recipes constants) returning values in [0, 1).
const seededRng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

describe('levelFromWins', () => {
  test('maps wins to level, capped at 6', () => {
    expect(levelFromWins(0)).toBe(1);
    expect(levelFromWins(25)).toBe(3);
    expect(levelFromWins(200)).toBe(6);
  });
  test('negative or NaN input yields level 1', () => {
    expect(levelFromWins(-5)).toBe(1);
    expect(levelFromWins(Number.NaN)).toBe(1);
  });
});

describe('ignoreProbability', () => {
  test('shrinks per level', () => {
    expect(ignoreProbability(1)).toBe(0.5);
    expect(ignoreProbability(6)).toBe(0);
  });
  test('level 3 is exactly 0.3', () => {
    expect(ignoreProbability(3)).toBe(0.3);
  });
  test('is clamped to [0, 0.5]', () => {
    expect(ignoreProbability(0)).toBe(0.5);
    expect(ignoreProbability(99)).toBe(0);
  });
});

describe('rollDiscipline', () => {
  test('level 1 boundary: rng 0.49 ignores policy, 0.5 follows', () => {
    expect(rollDiscipline(1, () => 0.49)).toBe(false);
    expect(rollDiscipline(1, () => 0.5)).toBe(true);
  });
  test('follows policy about half the time at level 1, always at level 6', () => {
    const rng = seededRng(42);
    let followedL1 = 0;
    for (let i = 0; i < 1000; i++) if (rollDiscipline(1, rng)) followedL1++;
    expect(followedL1).toBeGreaterThanOrEqual(400);
    expect(followedL1).toBeLessThanOrEqual(600);

    const rng6 = seededRng(7);
    let followedL6 = 0;
    for (let i = 0; i < 1000; i++) if (rollDiscipline(6, rng6)) followedL6++;
    expect(followedL6).toBe(1000);
  });
});

describe('decideSkill', () => {
  test('uses skill when own hp at or below threshold', () => {
    expect(decideSkill(side({ myHp: 450, myMaxHp: 1500 }), policy({ finisher: false }), true, () => 0.9)).toBe(true);
  });
  test('holds skill when own hp above threshold and no KO available', () => {
    expect(decideSkill(side({ myHp: 451, myMaxHp: 1500 }), policy({ finisher: false }), true, () => 0.9)).toBe(false);
  });
  test('finisher uses skill early when it would KO', () => {
    const s = side({ oppHp: 100, atk: 12, mult: 150 });
    expect(skillDamage(s.atk, s.mult, s.myHp, s.myMaxHp)).toBeGreaterThanOrEqual(s.oppHp);
    expect(decideSkill(s, policy({ finisher: true }), true, () => 0.9)).toBe(true);
  });
  test('finisher false does not trigger early KO', () => {
    const s = side({ oppHp: 100, atk: 12, mult: 150 });
    expect(decideSkill(s, policy({ finisher: false }), true, () => 0.9)).toBe(false);
  });
  test('finisher stays off when skill would not KO', () => {
    const s = side({ oppHp: 1500 });
    expect(decideSkill(s, policy({ finisher: true }), true, () => 0.9)).toBe(false);
  });
  test('never uses skill twice', () => {
    expect(decideSkill(side({ myHp: 10, skillUsed: true }), policy(), true, () => 0.9)).toBe(false);
    expect(decideSkill(side({ myHp: 10, skillUsed: true }), policy(), false, () => 0.99)).toBe(false);
  });
  test('no skill once either side is dead', () => {
    expect(decideSkill(side({ myHp: 0 }), policy(), true, () => 0.9)).toBe(false);
    expect(decideSkill(side({ oppHp: 0, myHp: 10 }), policy(), true, () => 0.9)).toBe(false);
  });
  test('ignoring policy: rng 0 gives no skill at full hp', () => {
    expect(decideSkill(side(), policy(), false, () => 0)).toBe(false);
  });
  test('ignoring policy: rng 0.99 gives skill at 50% hp', () => {
    expect(decideSkill(side({ myHp: 750 }), policy(), false, () => 0.99)).toBe(true);
  });
});

describe('agentTapRate', () => {
  test('stays within [7, 8)', () => {
    expect(agentTapRate(() => 0)).toBe(7);
    expect(agentTapRate(() => 0.999999)).toBeLessThan(8);
    const rng = seededRng(1);
    for (let i = 0; i < 200; i++) {
      const rate = agentTapRate(rng);
      expect(rate).toBeGreaterThanOrEqual(7);
      expect(rate).toBeLessThan(8);
    }
  });
});

describe('emptyAgentData', () => {
  test('returns defaults as a fresh object each call', () => {
    const a = emptyAgentData();
    const b = emptyAgentData();
    expect(a).toEqual({
      policy: { skillHpThreshold: 30, finisher: true },
      lessons: [],
      opponents: {},
      sim: { duels: 0, wins: 0 },
      testnet: { duels: 0, wins: 0 },
    });
    expect(a).not.toBe(b);
    expect(a.policy).not.toBe(b.policy);
    expect(a.lessons).not.toBe(b.lessons);
  });
});
