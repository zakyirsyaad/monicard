import { skillDamage } from '@nad/shared';
import type { DuelSummary } from '../sim/types';
import type { AgentData, Lesson, Policy } from './policy';

export type CoachOutput = { lesson: string; thresholdDelta: number; finisher: boolean };

/** Extra data that lets the coach check whether the skill could have finished the duel. */
export type CoachContext = { atk: number; mult: number; myMaxHp: number };

export const MAX_LESSON_CHARS = 120;
export const MAX_LESSONS = 20;
export const MIN_THRESHOLD = 10;
export const MAX_THRESHOLD = 90;
export const MIN_DELTA = -10;
export const MAX_DELTA = 10;

const RAISE_DELTA = 10;
const LOWER_DELTA = -10;
const EARLY_SKILL_HP_PCT = 50;
const WIN_DELTA_SPAN = 7;
const WIN_DELTA_OFFSET = 3;
const ELLIPSIS = '…';
const SKILL_NAME = 'Last stand';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const formatDelta = (delta: number): string => (delta > 0 ? `+${delta}%` : `${delta}%`);

const formatPct = (pct: number): string => `${Math.round(pct)}%`;

export const clampLesson = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_LESSON_CHARS) return trimmed;
  return trimmed.slice(0, MAX_LESSON_CHARS - ELLIPSIS.length) + ELLIPSIS;
};

/** True when, at some moment the agent was alive, the skill would have taken the opponent out. */
const skillCouldHaveKoed = (s: DuelSummary, ctx: CoachContext): boolean =>
  s.hpTimeline.some(
    (point) => point.myHp > 0 && point.oppHp > 0 && skillDamage(ctx.atk, ctx.mult, point.myHp, ctx.myMaxHp) >= point.oppHp,
  );

const thresholdDeltaFor = (s: DuelSummary, rng: () => number): number => {
  if (s.result === 'win') return Math.floor(rng() * WIN_DELTA_SPAN) - WIN_DELTA_OFFSET;
  if (s.result === 'draw') return 0;
  if (s.skillUsedAtHpPct === null) return RAISE_DELTA;
  return s.skillUsedAtHpPct > EARLY_SKILL_HP_PCT ? LOWER_DELTA : 0;
};

const lessonFor = (s: DuelSummary, policy: Policy, delta: number, canFinish: boolean): string => {
  const used = s.skillUsedAtHpPct;
  const change = delta === 0 ? `threshold holds at ${policy.skillHpThreshold}%` : `threshold ${formatDelta(delta)}`;
  if (s.result === 'loss' && used === null) {
    return canFinish
      ? `Lost with ${SKILL_NAME} unused, and it would have finished the duel. Finisher on, ${change}.`
      : `Lost with ${SKILL_NAME} unused. Fire it earlier: ${change}.`;
  }
  if (s.result === 'loss' && used !== null) {
    return delta < 0
      ? `Lost after firing ${SKILL_NAME} at ${formatPct(used)} HP. Hold it longer: ${change}.`
      : `Lost even with ${SKILL_NAME} at ${formatPct(used)} HP. Timing was fine: ${change}.`;
  }
  if (s.result === 'draw') {
    return used === null
      ? `Drew with ${SKILL_NAME} unused. No clear signal: ${change}.`
      : `Drew with ${SKILL_NAME} at ${formatPct(used)} HP. Close one: ${change}.`;
  }
  return used === null
    ? `Won without needing ${SKILL_NAME}. Staying relaxed: ${change}.`
    : `Won with ${SKILL_NAME} at ${formatPct(used)} HP. Small tune: ${change}.`;
};

/** Rule-based coach: turns one duel summary into a lesson and a policy nudge. */
export const ruleCoach = (s: DuelSummary, policy: Policy, rng: () => number, ctx?: CoachContext): CoachOutput => {
  const thresholdDelta = thresholdDeltaFor(s, rng);
  const canFinish = s.result === 'loss' && s.skillUsedAtHpPct === null && ctx !== undefined && skillCouldHaveKoed(s, ctx);
  return {
    lesson: clampLesson(lessonFor(s, policy, thresholdDelta, canFinish)),
    thresholdDelta,
    finisher: canFinish ? true : policy.finisher,
  };
};

/** Returns a new policy with the coach's nudge applied inside the allowed ranges. */
export const applyCoach = (p: Policy, out: CoachOutput): Policy => {
  const delta = Number.isFinite(out.thresholdDelta) ? clamp(Math.round(out.thresholdDelta), MIN_DELTA, MAX_DELTA) : 0;
  return {
    skillHpThreshold: clamp(p.skillHpThreshold + delta, MIN_THRESHOLD, MAX_THRESHOLD),
    finisher: out.finisher,
  };
};

const updateCounters = (counters: { duels: number; wins: number }, s: DuelSummary): { duels: number; wins: number } => ({
  duels: counters.duels + 1,
  wins: counters.wins + (s.result === 'win' ? 1 : 0),
});

const withLesson = (lessons: readonly Lesson[], lesson: Lesson): Lesson[] => [lesson, ...lessons].slice(0, MAX_LESSONS);

/** Pure: folds one settled duel into the agent's data, optionally learning from the coach's output. */
export const onDuelSettled = (data: AgentData, s: DuelSummary, out: CoachOutput | null, at: number): AgentData => {
  const base: AgentData = {
    ...data,
    [s.mode]: updateCounters(data[s.mode], s),
    opponents: { ...data.opponents, [s.opponent]: { lastResult: s.result, skillHpPct: s.skillUsedAtHpPct } },
  };
  if (!s.followedPolicy || !out) return base;
  const policy = applyCoach(data.policy, out);
  const lesson: Lesson = {
    at,
    duelId: s.duelId,
    text: clampLesson(out.lesson),
    thresholdFrom: data.policy.skillHpThreshold,
    thresholdTo: policy.skillHpThreshold,
  };
  return { ...base, policy, lessons: withLesson(data.lessons, lesson) };
};

const lessonKey = (l: Lesson): string => `${l.duelId}|${l.at}|${l.text}`;

const mergeLessons = (a: readonly Lesson[], b: readonly Lesson[]): Lesson[] => {
  const unique = new Map<string, Lesson>();
  for (const l of [...a, ...b]) if (!unique.has(lessonKey(l))) unique.set(lessonKey(l), l);
  return [...unique.values()].sort((x, y) => y.at - x.at).slice(0, MAX_LESSONS);
};

/** Pure: installs a trained policy on top of live data without touching testnet stats or opponents. */
export const mergeTrained = (live: AgentData, trained: AgentData): AgentData => ({
  policy: { ...trained.policy },
  lessons: mergeLessons(live.lessons, trained.lessons),
  opponents: live.opponents,
  sim: { duels: live.sim.duels + trained.sim.duels, wins: live.sim.wins + trained.sim.wins },
  testnet: live.testnet,
});
