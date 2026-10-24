import { describe, expect, test } from 'vitest';
import { emptyAgentData, type AgentData } from '../src/agent/policy';
import { botProfile, parseTrainArgs, prepareTrainingData } from '../scripts/train';

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
