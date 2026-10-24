import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { emptyAgentData, type AgentData, type Lesson } from '../src/agent/policy';
import { agentMessage, createAgentStore } from '../src/agent/store';

const T0 = 1_700_000_000_000;

const lesson = (at: number, duelId: string): Lesson => ({
  at,
  duelId,
  text: `lesson ${duelId}`,
  thresholdFrom: 30,
  thresholdTo: 33,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-store-test-'));
});

describe('createAgentStore', () => {
  test('starts empty when the file is missing and creates the directory', () => {
    const nested = join(dir, 'nested', 'data');
    const store = createAgentStore(nested);
    expect(store.get()).toEqual(emptyAgentData());
    expect(existsSync(nested)).toBe(true);
  });

  test('persists an update before returning it and reloads it', () => {
    const store = createAgentStore(dir);
    const next = store.update((d) => ({
      ...d,
      policy: { skillHpThreshold: 40, finisher: false },
      testnet: { duels: 1, wins: 1 },
      lessons: [lesson(T0, '5')],
    }));

    expect(store.get()).toEqual(next);
    expect(createAgentStore(dir).get()).toEqual(next);
  });

  test('applies updates to the current in-memory value', () => {
    const store = createAgentStore(dir);
    store.update((d) => ({ ...d, sim: { duels: 1, wins: 0 } }));
    const next = store.update((d) => ({ ...d, sim: { ...d.sim, wins: d.sim.wins + 1 } }));
    expect(next.sim).toEqual({ duels: 1, wins: 1 });
  });

  test('renames an unparseable file and starts empty', () => {
    writeFileSync(join(dir, 'agent.json'), '{not json');
    const store = createAgentStore(dir);

    expect(store.get()).toEqual(emptyAgentData());
    expect(existsSync(join(dir, 'agent.json'))).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('agent.json.corrupt-'))).toBe(true);
  });

  test('renames a file with the wrong shape and starts empty', () => {
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        policy: { skillHpThreshold: 'high', finisher: true },
        lessons: [],
        opponents: {},
        sim: { duels: 0, wins: 0 },
        testnet: { duels: 0, wins: 0 },
      }),
    );
    const store = createAgentStore(dir);

    expect(store.get()).toEqual(emptyAgentData());
    expect(readdirSync(dir).some((f) => f.startsWith('agent.json.corrupt-'))).toBe(true);
  });

  test('keeps the old value and throws with context when persisting fails', () => {
    const store = createAgentStore(dir);
    const before = store.get();
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');

    expect(() => store.update((d) => ({ ...d, testnet: { duels: 1, wins: 0 } }))).toThrow(/agent store/);
    expect(store.get()).toEqual(before);
  });
});

describe('agentMessage', () => {
  test('uses total wins for the level, the policy threshold and lessons newest first', () => {
    const data: AgentData = {
      ...emptyAgentData(),
      policy: { skillHpThreshold: 42, finisher: false },
      lessons: [lesson(T0, '9'), lesson(T0 - 1, '8')],
      sim: { duels: 12, wins: 10 },
      testnet: { duels: 3, wins: 0 },
    };

    expect(agentMessage(data)).toEqual({
      type: 'agent',
      level: 2,
      threshold: 42,
      finisher: false,
      sim: { duels: 12, wins: 10 },
      testnet: { duels: 3, wins: 0 },
      lessons: [lesson(T0, '9'), lesson(T0 - 1, '8')],
    });
  });

  test('caps the level at 6', () => {
    const data: AgentData = { ...emptyAgentData(), sim: { duels: 200, wins: 200 } };
    expect(agentMessage(data).level).toBe(6);
  });
});
