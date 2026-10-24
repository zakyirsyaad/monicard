import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentMsg } from '../ws';
import { emptyAgentData, levelFromWins, type AgentData } from './policy';

export const AGENT_FILE = 'agent.json';

const lessonSchema = z.object({
  at: z.number(),
  duelId: z.string(),
  text: z.string(),
  thresholdFrom: z.number(),
  thresholdTo: z.number(),
});

const opponentSchema = z.object({
  lastResult: z.enum(['win', 'loss', 'draw']),
  skillHpPct: z.number().nullable(),
});

const countersSchema = z.object({ duels: z.number(), wins: z.number() });

const agentDataSchema = z.object({
  policy: z.object({ skillHpThreshold: z.number(), finisher: z.boolean() }),
  lessons: z.array(lessonSchema),
  opponents: z.record(opponentSchema),
  sim: countersSchema,
  testnet: countersSchema,
});

export type AgentStore = {
  get(): AgentData;
  update(fn: (d: AgentData) => AgentData): AgentData;
};

const shortError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Moves an unusable store aside so the next boot starts clean; never throws. */
function quarantine(path: string): void {
  const target = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, target);
    console.error(`[agent] corrupt store at ${path}; moved to ${target}`);
  } catch (error) {
    console.error(`[agent] cannot move corrupt store ${path}: ${shortError(error)}`);
  }
}

/** Loads DATA_DIR/agent.json once: missing means empty, anything unusable is quarantined. */
function load(path: string): AgentData {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAgentData();
    console.error(`[agent] cannot read store ${path}: ${shortError(error)}`);
    quarantine(path);
    return emptyAgentData();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantine(path);
    return emptyAgentData();
  }

  const result = agentDataSchema.safeParse(parsed);
  if (!result.success) {
    console.error(`[agent] invalid store shape at ${path}; starting empty: ${result.error.message}`);
    quarantine(path);
    return emptyAgentData();
  }
  return result.data as AgentData;
}

/**
 * Tiny synchronous JSON store: writes are rare (one per duel) and serializing them
 * avoids interleaving. `update` persists before swapping, so a failed write leaves
 * the in-memory value untouched.
 */
export function createAgentStore(dataDir: string): AgentStore {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, AGENT_FILE);
  let current = load(path);

  return {
    get: () => current,
    update(fn) {
      const next = fn(current);
      const tmp = `${path}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(next));
        renameSync(tmp, path);
      } catch (error) {
        throw new Error(`agent store: failed to persist ${path}: ${shortError(error)}`, { cause: error });
      }
      current = next;
      return next;
    },
  };
}

/** The frozen `agent` WebSocket payload; lessons are already newest first. */
export function agentMessage(d: AgentData): AgentMsg {
  return {
    type: 'agent',
    level: levelFromWins(d.sim.wins + d.testnet.wins),
    threshold: d.policy.skillHpThreshold,
    finisher: d.policy.finisher,
    sim: { ...d.sim },
    testnet: { ...d.testnet },
    lessons: d.lessons.map((lesson) => ({ ...lesson })),
  };
}