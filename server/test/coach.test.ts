import { describe, expect, test } from 'vitest';
import type { Hex } from '@nad/shared';
import type { DuelSummary } from '../src/sim/types';
import {
  DEFAULT_POLICY,
  emptyAgentData,
  type AgentData,
  type Lesson,
  type Policy,
} from '../src/agent/policy';
import {
  MAX_LESSONS,
  MAX_LESSON_CHARS,
  applyCoach,
  clampLesson,
  mergeTrained,
  onDuelSettled,
  ruleCoach,
  type CoachOutput,
} from '../src/agent/coach';

const OPPONENT = '0x00000000000000000000000000000000000000aa' as Hex;
const OTHER_OPPONENT = '0x00000000000000000000000000000000000000bb' as Hex;

const policy = (overrides: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...overrides });

const summary = (overrides: Partial<DuelSummary> = {}): DuelSummary => ({
  duelId: 'duel-1',
  mode: 'sim',
  opponent: OPPONENT,
  myElement: 0,
  oppElement: 1,
  result: 'loss',
  skillUsedAtHpPct: null,
  followedPolicy: true,
  hpTimeline: [],
  ...overrides,
});

const out = (overrides: Partial<CoachOutput> = {}): CoachOutput => ({
  lesson: 'Fire it earlier.',
  thresholdDelta: 10,
  finisher: true,
  ...overrides,
});

const lesson = (overrides: Partial<Lesson> = {}): Lesson => ({
  at: 1000,
  duelId: 'd',
  text: 'text',
  thresholdFrom: 30,
  thresholdTo: 40,
  ...overrides,
});

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value as object).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const rng = () => 0.5;

describe('ruleCoach threshold delta', () => {
  test('raises threshold after loss with unused skill', () => {
    expect(ruleCoach(summary({ result: 'loss', skillUsedAtHpPct: null }), policy(), rng).thresholdDelta).toBe(10);
  });

  test('lowers threshold after loss with early skill', () => {
    expect(ruleCoach(summary({ result: 'loss', skillUsedAtHpPct: 70 }), policy(), rng).thresholdDelta).toBe(-10);
  });

  test('keeps threshold on loss with late skill, including exactly 50%', () => {
    expect(ruleCoach(summary({ result: 'loss', skillUsedAtHpPct: 20 }), policy(), rng).thresholdDelta).toBe(0);
    expect(ruleCoach(summary({ result: 'loss', skillUsedAtHpPct: 50 }), policy(), rng).thresholdDelta).toBe(0);
  });

  test('keeps threshold on draw', () => {
    expect(ruleCoach(summary({ result: 'draw', skillUsedAtHpPct: null }), policy(), rng).thresholdDelta).toBe(0);
    expect(ruleCoach(summary({ result: 'draw', skillUsedAtHpPct: 40 }), policy(), rng).thresholdDelta).toBe(0);
  });

  test('win delta spans -3..+3 from the rng', () => {
    const win = summary({ result: 'win', skillUsedAtHpPct: 30 });
    expect(ruleCoach(win, policy(), () => 0).thresholdDelta).toBe(-3);
    expect(ruleCoach(win, policy(), () => 0.5).thresholdDelta).toBe(0);
    expect(ruleCoach(win, policy(), () => 0.999).thresholdDelta).toBe(3);
  });
});

describe('ruleCoach finisher', () => {
  const ctx = { atk: 12, mult: 100, myMaxHp: 1500 };
  // At 150/1500 HP the skill deals 552; at full HP it deals 120.
  const koPossible = [
    { block: 100, myHp: 1500, oppHp: 1500 },
    { block: 110, myHp: 150, oppHp: 400 },
  ];
  const koImpossible = [
    { block: 100, myHp: 1500, oppHp: 1500 },
    { block: 110, myHp: 900, oppHp: 1200 },
  ];

  test('flips to true after loss with unused skill that could have KO-d', () => {
    const result = ruleCoach(
      summary({ result: 'loss', skillUsedAtHpPct: null, hpTimeline: koPossible }),
      policy({ finisher: false }),
      rng,
      ctx,
    );
    expect(result.finisher).toBe(true);
  });

  test('stays unchanged without ctx', () => {
    const result = ruleCoach(
      summary({ result: 'loss', skillUsedAtHpPct: null, hpTimeline: koPossible }),
      policy({ finisher: false }),
      rng,
    );
    expect(result.finisher).toBe(false);
  });

  test('stays unchanged when the skill could not have KO-d', () => {
    const result = ruleCoach(
      summary({ result: 'loss', skillUsedAtHpPct: null, hpTimeline: koImpossible }),
      policy({ finisher: false }),
      rng,
      ctx,
    );
    expect(result.finisher).toBe(false);
  });

  test('ignores timeline points where the agent was already dead', () => {
    const result = ruleCoach(
      summary({
        result: 'loss',
        skillUsedAtHpPct: null,
        hpTimeline: [{ block: 120, myHp: 0, oppHp: 1 }],
      }),
      policy({ finisher: false }),
      rng,
      ctx,
    );
    expect(result.finisher).toBe(false);
  });

  test('stays unchanged when the skill was used or the result is not a loss', () => {
    const used = ruleCoach(
      summary({ result: 'loss', skillUsedAtHpPct: 40, hpTimeline: koPossible }),
      policy({ finisher: false }),
      rng,
      ctx,
    );
    const win = ruleCoach(
      summary({ result: 'win', skillUsedAtHpPct: null, hpTimeline: koPossible }),
      policy({ finisher: false }),
      rng,
      ctx,
    );
    expect(used.finisher).toBe(false);
    expect(win.finisher).toBe(false);
  });

  test('keeps finisher true when the policy already has it', () => {
    expect(ruleCoach(summary({ result: 'draw' }), policy({ finisher: true }), rng, ctx).finisher).toBe(true);
  });
});

describe('ruleCoach lesson text', () => {
  const cases: DuelSummary[] = [
    summary({ result: 'loss', skillUsedAtHpPct: null }),
    summary({ result: 'loss', skillUsedAtHpPct: 72 }),
    summary({ result: 'loss', skillUsedAtHpPct: 18 }),
    summary({ result: 'draw', skillUsedAtHpPct: null }),
    summary({ result: 'draw', skillUsedAtHpPct: 44 }),
    summary({ result: 'win', skillUsedAtHpPct: null }),
    summary({ result: 'win', skillUsedAtHpPct: 35 }),
  ];

  test.each(cases.map((c) => [`${c.result}/${String(c.skillUsedAtHpPct)}`, c] as const))(
    'is short, plain English with no banned words (%s)',
    (_name, s) => {
      for (const r of [() => 0, () => 0.5, () => 0.999]) {
        const text = ruleCoach(s, policy(), r).lesson;
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(MAX_LESSON_CHARS);
        expect(text).not.toMatch(/\b(bet|wager|gamble)/i);
        expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      }
    },
  );

  test('mentions the unused skill and the threshold change on loss with unused skill', () => {
    const text = ruleCoach(summary({ result: 'loss', skillUsedAtHpPct: null }), policy(), rng).lesson;
    expect(text).toContain('unused');
    expect(text).toContain('+10%');
  });

  test('mentions the HP percent where the skill fired', () => {
    expect(ruleCoach(summary({ result: 'loss', skillUsedAtHpPct: 72 }), policy(), rng).lesson).toContain('72%');
  });
});

describe('applyCoach', () => {
  test('clamps delta and threshold range', () => {
    expect(applyCoach({ skillHpThreshold: 88, finisher: true }, out({ thresholdDelta: 50 })).skillHpThreshold).toBe(90);
    expect(applyCoach({ skillHpThreshold: 12, finisher: true }, out({ thresholdDelta: -50 })).skillHpThreshold).toBe(10);
    expect(applyCoach({ skillHpThreshold: 50, finisher: true }, out({ thresholdDelta: 50 })).skillHpThreshold).toBe(60);
  });

  test('rounds a fractional delta', () => {
    expect(applyCoach({ skillHpThreshold: 40, finisher: true }, out({ thresholdDelta: 2.6 })).skillHpThreshold).toBe(43);
  });

  test('treats a non-finite delta as zero', () => {
    expect(applyCoach({ skillHpThreshold: 40, finisher: true }, out({ thresholdDelta: Number.NaN })).skillHpThreshold).toBe(40);
  });

  test('takes finisher from the output and returns a new object', () => {
    const before: Policy = { skillHpThreshold: 40, finisher: true };
    const after = applyCoach(before, out({ thresholdDelta: 0, finisher: false }));
    expect(after).not.toBe(before);
    expect(after.finisher).toBe(false);
    expect(before).toEqual({ skillHpThreshold: 40, finisher: true });
  });

  test('clamps a stored threshold that is already out of range', () => {
    expect(applyCoach({ skillHpThreshold: 5, finisher: true }, out({ thresholdDelta: 0 })).skillHpThreshold).toBe(10);
  });
});

describe('clampLesson', () => {
  test('trims whitespace', () => {
    expect(clampLesson('  hello  ')).toBe('hello');
  });

  test('truncates to 120 chars including the ellipsis', () => {
    const clamped = clampLesson('x'.repeat(300));
    expect(clamped).toHaveLength(MAX_LESSON_CHARS);
    expect(clamped.endsWith('…')).toBe(true);
  });

  test('leaves a text of exactly 120 chars alone', () => {
    const exact = 'y'.repeat(MAX_LESSON_CHARS);
    expect(clampLesson(exact)).toBe(exact);
  });
});

describe('onDuelSettled', () => {
  test('counts sim duels and wins, leaving testnet alone', () => {
    const next = onDuelSettled(emptyAgentData(), summary({ mode: 'sim', result: 'win' }), null, 5);
    expect(next.sim).toEqual({ duels: 1, wins: 1 });
    expect(next.testnet).toEqual({ duels: 0, wins: 0 });
  });

  test('counts testnet duels and losses without a win, leaving sim alone', () => {
    const next = onDuelSettled(emptyAgentData(), summary({ mode: 'testnet', result: 'loss' }), null, 5);
    expect(next.testnet).toEqual({ duels: 1, wins: 0 });
    expect(next.sim).toEqual({ duels: 0, wins: 0 });
  });

  test('records the opponent', () => {
    const next = onDuelSettled(
      emptyAgentData(),
      summary({ result: 'loss', skillUsedAtHpPct: 64, opponent: OTHER_OPPONENT }),
      null,
      5,
    );
    expect(next.opponents[OTHER_OPPONENT]).toEqual({ lastResult: 'loss', skillHpPct: 64 });
  });

  test('applies the coach output and prepends a lesson when the policy was followed', () => {
    const data = emptyAgentData();
    const next = onDuelSettled(data, summary({ duelId: 'abc' }), out({ thresholdDelta: 10, finisher: false, lesson: ' Go. ' }), 1234);
    expect(next.policy).toEqual({ skillHpThreshold: 40, finisher: false });
    expect(next.lessons).toEqual([
      { at: 1234, duelId: 'abc', text: 'Go.', thresholdFrom: 30, thresholdTo: 40 },
    ]);
  });

  test('puts the newest lesson first', () => {
    const data: AgentData = { ...emptyAgentData(), lessons: [lesson({ duelId: 'old', at: 1 })] };
    const next = onDuelSettled(data, summary({ duelId: 'new' }), out(), 2);
    expect(next.lessons.map((l) => l.duelId)).toEqual(['new', 'old']);
  });

  test('does not change policy or lessons when the duel ignored the policy', () => {
    const data = emptyAgentData();
    const next = onDuelSettled(data, summary({ followedPolicy: false }), out(), 5);
    expect(next.policy).toEqual(data.policy);
    expect(next.lessons).toEqual([]);
    expect(next.sim.duels).toBe(1);
  });

  test('does not change policy or lessons when no coach output is given', () => {
    const next = onDuelSettled(emptyAgentData(), summary(), null, 5);
    expect(next.policy).toEqual(DEFAULT_POLICY);
    expect(next.lessons).toEqual([]);
  });

  test('caps lessons at 20', () => {
    const lessons = Array.from({ length: MAX_LESSONS }, (_, i) => lesson({ duelId: `d${i}`, at: i }));
    const next = onDuelSettled({ ...emptyAgentData(), lessons }, summary({ duelId: 'fresh' }), out(), 999);
    expect(next.lessons).toHaveLength(MAX_LESSONS);
    expect(next.lessons[0]?.duelId).toBe('fresh');
    expect(next.lessons[MAX_LESSONS - 1]?.duelId).toBe(`d${MAX_LESSONS - 2}`);
  });

  test('does not mutate a deep-frozen input', () => {
    const data = deepFreeze({
      ...emptyAgentData(),
      lessons: [lesson()],
      opponents: { [OPPONENT]: { lastResult: 'win' as const, skillHpPct: 10 } },
    });
    const s = deepFreeze(summary({ result: 'win' }));
    const o = deepFreeze(out());
    expect(() => onDuelSettled(data, s, o, 77)).not.toThrow();
    expect(data.sim).toEqual({ duels: 0, wins: 0 });
    expect(data.lessons).toHaveLength(1);
    expect(data.policy).toEqual(DEFAULT_POLICY);
  });

  test('keeps other opponents untouched', () => {
    const data: AgentData = {
      ...emptyAgentData(),
      opponents: { [OTHER_OPPONENT]: { lastResult: 'win', skillHpPct: 33 } },
    };
    const next = onDuelSettled(data, summary(), null, 5);
    expect(next.opponents[OTHER_OPPONENT]).toEqual({ lastResult: 'win', skillHpPct: 33 });
    expect(next.opponents[OPPONENT]).toBeDefined();
  });
});

describe('mergeTrained', () => {
  const live: AgentData = {
    policy: { skillHpThreshold: 30, finisher: true },
    lessons: [lesson({ duelId: 'live-1', at: 500, text: 'live' })],
    opponents: { [OPPONENT]: { lastResult: 'win', skillHpPct: 25 } },
    sim: { duels: 10, wins: 4 },
    testnet: { duels: 7, wins: 3 },
  };
  const trained: AgentData = {
    policy: { skillHpThreshold: 55, finisher: false },
    lessons: [lesson({ duelId: 'train-1', at: 900, text: 'trained' })],
    opponents: { [OTHER_OPPONENT]: { lastResult: 'loss', skillHpPct: null } },
    sim: { duels: 300, wins: 180 },
    testnet: { duels: 0, wins: 0 },
  };

  test('takes policy from trained', () => {
    expect(mergeTrained(live, trained).policy).toEqual({ skillHpThreshold: 55, finisher: false });
  });

  test('adds sim stats and keeps live testnet stats and opponents', () => {
    const merged = mergeTrained(live, trained);
    expect(merged.sim).toEqual({ duels: 310, wins: 184 });
    expect(merged.testnet).toEqual({ duels: 7, wins: 3 });
    expect(merged.opponents).toEqual(live.opponents);
  });

  test('unions lessons newest first and dedupes by duelId, at and text', () => {
    const shared = lesson({ duelId: 'same', at: 700, text: 'dup' });
    const merged = mergeTrained(
      { ...live, lessons: [...live.lessons, shared] },
      { ...trained, lessons: [...trained.lessons, { ...shared }] },
    );
    expect(merged.lessons.map((l) => l.duelId)).toEqual(['train-1', 'same', 'live-1']);
  });

  test('keeps the newest 20 lessons', () => {
    const many = (prefix: string, base: number): Lesson[] =>
      Array.from({ length: 15 }, (_, i) => lesson({ duelId: `${prefix}${i}`, at: base + i, text: `${prefix}${i}` }));
    const merged = mergeTrained({ ...live, lessons: many('a', 0) }, { ...trained, lessons: many('b', 100) });
    expect(merged.lessons).toHaveLength(MAX_LESSONS);
    expect(merged.lessons[0]?.at).toBe(114);
    expect(merged.lessons.every((l) => l.at >= 0)).toBe(true);
    const ats = merged.lessons.map((l) => l.at);
    expect([...ats].sort((x, y) => y - x)).toEqual(ats);
    expect(merged.lessons.filter((l) => l.duelId.startsWith('b'))).toHaveLength(15);
  });

  test('does not mutate its inputs', () => {
    const frozenLive = deepFreeze((JSON.parse(JSON.stringify(live)) as AgentData));
    const frozenTrained = deepFreeze((JSON.parse(JSON.stringify(trained)) as AgentData));
    expect(() => mergeTrained(frozenLive, frozenTrained)).not.toThrow();
  });
});
