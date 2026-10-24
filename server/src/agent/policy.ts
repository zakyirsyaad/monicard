import { skillDamage, type Hex } from '@nad/shared';
import type { SideState } from '../sim/types';

export type Policy = { skillHpThreshold: number; finisher: boolean };

export const DEFAULT_POLICY: Policy = { skillHpThreshold: 30, finisher: true };

export type Lesson = { at: number; duelId: string; text: string; thresholdFrom: number; thresholdTo: number };

export type DuelResult = 'win' | 'loss' | 'draw';

export type AgentData = {
  policy: Policy;
  lessons: Lesson[];
  opponents: Record<Hex, { lastResult: DuelResult; skillHpPct: number | null }>;
  sim: { duels: number; wins: number };
  testnet: { duels: number; wins: number };
};

export const emptyAgentData = (): AgentData => ({
  policy: { ...DEFAULT_POLICY },
  lessons: [],
  opponents: {},
  sim: { duels: 0, wins: 0 },
  testnet: { duels: 0, wins: 0 },
});

const WINS_PER_LEVEL = 10;
const MIN_LEVEL = 1;
const MAX_LEVEL = 6;
const BASE_IGNORE_PROBABILITY = 0.5;
const IGNORE_REDUCTION_PER_LEVEL = 0.1;
const MAX_IGNORE_PROBABILITY = 0.5;
const PROBABILITY_ROUNDING = 10;
const PERCENT = 100;
const BASE_TAP_RATE = 7;

/** Agent level grows by one for every 10 total wins, capped at 6. */
export const levelFromWins = (totalWins: number): number => {
  if (!Number.isFinite(totalWins) || totalWins < 0) return MIN_LEVEL;
  return Math.min(MAX_LEVEL, MIN_LEVEL + Math.floor(totalWins / WINS_PER_LEVEL));
};

/** Chance (0..0.5) that the agent ignores its policy in a given duel. */
export const ignoreProbability = (level: number): number => {
  const raw = BASE_IGNORE_PROBABILITY - IGNORE_REDUCTION_PER_LEVEL * (level - MIN_LEVEL);
  const clamped = Math.min(MAX_IGNORE_PROBABILITY, Math.max(0, raw));
  return Math.round(clamped * PROBABILITY_ROUNDING) / PROBABILITY_ROUNDING;
};

/** Rolled once per duel: true means this duel follows the policy. */
export const rollDiscipline = (level: number, rng: () => number): boolean => rng() >= ignoreProbability(level);

/** Whether the agent should fire its one-time skill at this moment. */
export const decideSkill = (s: SideState, p: Policy, followPolicy: boolean, rng: () => number): boolean => {
  if (s.skillUsed || s.oppHp <= 0 || s.myHp <= 0) return false;
  const myHpPct = (s.myHp * PERCENT) / s.myMaxHp;
  if (!followPolicy) return myHpPct <= rng() * PERCENT;
  if (myHpPct <= p.skillHpThreshold) return true;
  return p.finisher && skillDamage(s.atk, s.mult, s.myHp, s.myMaxHp) >= s.oppHp;
};

/** Taps per second, in [7, 8). */
export const agentTapRate = (rng: () => number): number => BASE_TAP_RATE + rng();
