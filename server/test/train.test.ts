import { describe, expect, test } from 'vitest';
import type { ZodType } from 'zod';
import type { Hex } from '@nad/shared';
import type { Llm } from '../src/llm';
import type { DuelSummary } from '../src/sim/types';
import { emptyAgentData, type AgentData } from '../src/agent/policy';
import { botProfile, isAgentData, makeCoach, newLlmStats, parseTrainArgs, prepareTrainingData } from '../scripts/train';

describe('parseTrainArgs', () => {
  test('uses defaults when no flags are given', () => {
    expect(parseTrainArgs([])).toEqual({ duels: 300, llmEvery: 10, bots: 4 });
  });

  test('reads overrides for every flag', () => {
    expect(parseTrainArgs(['--duels', '30', '--llm-every', '0', '--bots', '2'])).toEqual({
      duels: 30,
      llmEvery: 0,
      bots: 2,
    });
  });

  test('rejects non-positive or non-integer duels and bots', () => {
    expect(() => parseTrainArgs(['--duels', '0'])).toThrow(/--duels/);
    expect(() => parseTrainArgs(['--duels', '-5'])).toThrow(/--duels/);
    expect(() => parseTrainArgs(['--duels', '2.5'])).toThrow(/--duels/);
    expect(() => parseTrainArgs(['--duels', 'abc'])).toThrow(/--duels/);
    expect(() => parseTrainArgs(['--bots', '0'])).toThrow(/--bots/);
  });

  test('rejects negative or fractional llm-every but accepts zero', () => {
    expect(() => parseTrainArgs(['--llm-every', '-1'])).toThrow(/--llm-every/);
    expect(() => parseTrainArgs(['--llm-every', '1.5'])).toThrow(/--llm-every/);
    expect(parseTrainArgs(['--llm-every', '0']).llmEvery).toBe(0);
  });

  test('rejects unknown flags and missing values', () => {
    expect(() => parseTrainArgs(['--nope', '1'])).toThrow(/--nope/);
    expect(() => parseTrainArgs(['--duels'])).toThrow(/--duels/);
  });
});

describe('prepareTrainingData', () => {
  const live = (): AgentData => ({
    policy: { skillHpThreshold: 45, finisher: false },
    lessons: [{ at: 1, duelId: '7', text: 'old lesson', thresholdFrom: 30, thresholdTo: 45 }],
    opponents: { '0xabc': { lastResult: 'win', skillHpPct: 20 } },
    sim: { duels: 120, wins: 50 },
    testnet: { duels: 8, wins: 3 },
  });

  test('null input gives empty data and zero base wins', () => {
    expect(prepareTrainingData(null)).toEqual({ data: emptyAgentData(), baseWins: 0 });
  });

  test('keeps policy and lessons, resets counters and opponents', () => {
    const { data } = prepareTrainingData(live());
    expect(data.policy).toEqual({ skillHpThreshold: 45, finisher: false });
    expect(data.lessons).toHaveLength(1);
    expect(data.sim).toEqual({ duels: 0, wins: 0 });
    expect(data.testnet).toEqual({ duels: 0, wins: 0 });
    expect(data.opponents).toEqual({});
  });

  test('base wins add live sim and testnet wins', () => {
    expect(prepareTrainingData(live()).baseWins).toBe(53);
  });

  test('does not mutate the live data', () => {
    const input = live();
    prepareTrainingData(input);
    expect(input).toEqual(live());
  });
});

describe('botProfile', () => {
  test('stays inside tap and threshold ranges at the extremes', () => {
    const low = botProfile(() => 0);
    expect(low.tapsPerSec).toBe(5);
    expect(low.skillThreshold).toBe(10);
    const high = botProfile(() => 0.999999);
    expect(high.tapsPerSec).toBeGreaterThanOrEqual(5);
    expect(high.tapsPerSec).toBeLessThanOrEqual(9);
    expect(high.skillThreshold).toBeLessThanOrEqual(90);
    expect(high.skillThreshold).toBeGreaterThanOrEqual(10);
  });

  test('is always within range over many random draws', () => {
    for (let i = 0; i < 200; i++) {
      const p = botProfile(Math.random);
      expect(p.tapsPerSec).toBeGreaterThanOrEqual(5);
      expect(p.tapsPerSec).toBeLessThanOrEqual(9);
      expect(p.skillThreshold).toBeGreaterThanOrEqual(10);
      expect(p.skillThreshold).toBeLessThanOrEqual(90);
    }
  });
});

describe('isAgentData', () => {
  test('accepts a full agent file and the empty default', () => {
    expect(isAgentData(emptyAgentData())).toBe(true);
  });

  test('rejects wrong shapes', () => {
    expect(isAgentData(null)).toBe(false);
    expect(isAgentData([])).toBe(false);
    expect(isAgentData({ ...emptyAgentData(), policy: { skillHpThreshold: '30', finisher: true } })).toBe(false);
    expect(isAgentData({ ...emptyAgentData(), lessons: {} })).toBe(false);
    expect(isAgentData({ ...emptyAgentData(), sim: { duels: 1 } })).toBe(false);
    const { testnet: _testnet, ...withoutTestnet } = emptyAgentData();
    expect(isAgentData(withoutTestnet)).toBe(false);
  });
});

describe('makeCoach routing and LLM counts', () => {
  const summary: DuelSummary = {
    duelId: '1',
    mode: 'sim',
    opponent: '0x0000000000000000000000000000000000000001' as Hex,
    myElement: 0,
    oppElement: 1,
    result: 'loss',
    skillUsedAtHpPct: null,
    followedPolicy: true,
    hpTimeline: [],
  };
  const ctx = { atk: 10, mult: 1, myMaxHp: 100 };
  const policy = emptyAgentData().policy;
  const validReply = { lesson: 'Fire it earlier.', thresholdDelta: 5, finisher: true };

  const fakeLlm = (behaviour: 'ok' | 'throw') => {
    const calls = { n: 0 };
    const llm: Llm = {
      async json<T>(_system: string, _user: string, schema: ZodType<T>): Promise<T> {
        calls.n += 1;
        if (behaviour === 'throw') throw new Error('boom');
        return schema.parse(validReply);
      },
    };
    return { llm, calls };
  };

  const runDuels = async (coach: ReturnType<typeof makeCoach>, count: number) => {
    const outs = [];
    for (let i = 0; i < count; i++) outs.push(await coach(summary, policy, () => 0.5, ctx, i, []));
    return outs;
  };

  test('every K-th duel goes to the LLM, the rest to the rule coach', async () => {
    const { llm, calls } = fakeLlm('ok');
    const stats = newLlmStats();
    const outs = await runDuels(makeCoach(llm, 3, stats), 7);
    expect(calls.n).toBe(2); // duels 3 and 6 (1-based)
    expect(stats).toEqual({ attempted: 2, succeeded: 2 });
    expect(outs[2]!.lesson).toBe('Fire it earlier.');
    expect(outs[0]!.lesson).not.toBe('Fire it earlier.');
  });

  test('K = 0 never uses the LLM', async () => {
    const { llm, calls } = fakeLlm('ok');
    const stats = newLlmStats();
    await runDuels(makeCoach(llm, 0, stats), 10);
    expect(calls.n).toBe(0);
    expect(stats).toEqual({ attempted: 0, succeeded: 0 });
  });

  test('a null LLM never attempts anything', async () => {
    const stats = newLlmStats();
    const outs = await runDuels(makeCoach(null, 1, stats), 4);
    expect(outs).toHaveLength(4);
    expect(stats).toEqual({ attempted: 0, succeeded: 0 });
  });

  test('a throwing LLM counts as attempted but not succeeded and still yields a rule lesson', async () => {
    const { llm } = fakeLlm('throw');
    const stats = newLlmStats();
    const outs = await runDuels(makeCoach(llm, 1, stats), 3);
    expect(stats).toEqual({ attempted: 3, succeeded: 0 });
    for (const out of outs) expect(out.lesson.length).toBeGreaterThan(0);
  });
});
