import { timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { formatEther, type Hex } from 'viem';
import { z } from 'zod';
import { mergeTrained } from './agent/coach';
import type { AgentData } from './agent/policy';

export const MIN_SWARM_PAIRS = 1;
export const MAX_SWARM_PAIRS = 50;
export const MIN_SWARM_ROUNDS = 1;
export const MAX_SWARM_ROUNDS = 100;

export type WalletAddresses = {
  master: Hex;
  operator: Hex;
  agent: Hex;
  bots: readonly Hex[];
};

export type AdminDeps = {
  /** env ADMIN_TOKEN; an empty token disables every route. */
  token: string;
  swarm: {
    start(pairs: number, rounds: number): Promise<void>;
    stop(): void;
    running(): number;
  };
  setFundEnabled: (enabled: boolean) => void;
  setFeatured: (duelId: string | null) => void;
  /** Agent runner's `reserveFor`. */
  reserveAgent: (p1: Hex | null) => void;
  /** Task 13's store; `update` may be synchronous or return a promise. */
  agentStore: { get(): AgentData; update(fn: (d: AgentData) => AgentData): unknown };
  /** DATA_DIR/agent.train.json. */
  trainPath: string;
  onAgentChanged?: () => void;
  wallets: WalletAddresses;
  balanceOf: (address: Hex) => Promise<bigint>;
  log?: (msg: string, err?: unknown) => void;
};

export type AdminStatus = 200 | 400 | 401 | 404 | 409 | 500 | 502;
export type AdminResult = { status: AdminStatus; body: Record<string, unknown> };
export type AdminActions = {
  startSwarm(body: unknown): Promise<AdminResult>;
  stopSwarm(): Promise<AdminResult>;
  setFund(body: unknown): Promise<AdminResult>;
  setFeaturedDuel(body: unknown): Promise<AdminResult>;
  reserveAgentFor(body: unknown): Promise<AdminResult>;
  mergeTrain(): Promise<AdminResult>;
  wallets(): Promise<AdminResult>;
};

const swarmSchema = z.object({
  pairs: z.number().int().min(MIN_SWARM_PAIRS).max(MAX_SWARM_PAIRS),
  rounds: z.number().int().min(MIN_SWARM_ROUNDS).max(MAX_SWARM_ROUNDS),
});

const fundSchema = z.object({ enabled: z.boolean() });

const DUELL_ID = /^\d{1,20}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const featuredSchema = z.object({ duelId: z.union([z.string().regex(DUELL_ID), z.null()]) });
const reserveSchema = z.object({ p1: z.union([z.string().regex(ADDRESS), z.null()]) });

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

/** Mirrors the shape `createAgentStore` persists; a training file must match it. */
const agentDataSchema = z.object({
  policy: z.object({ skillHpThreshold: z.number(), finisher: z.boolean() }),
  lessons: z.array(lessonSchema),
  opponents: z.record(opponentSchema),
  sim: countersSchema,
  testnet: countersSchema,
});

export const UNAUTHORIZED: AdminResult = { status: 401, body: { reason: 'unauthorized' } };
export const BAD_REQUEST: AdminResult = { status: 400, body: { reason: 'bad_request' } };
const OK: AdminResult = { status: 200, body: { ok: true } };
const NO_TRAINING: AdminResult = { status: 404, body: { reason: 'no_training' } };
const INVALID_TRAINING: AdminResult = { status: 400, body: { reason: 'invalid_training' } };

/** Constant-time token check; an empty configured token never authorizes. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (token.length === 0 || header === undefined) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Framework-free admin handlers: the Hono wrapper in `adminRoutes.ts` only maps HTTP to
 * these results. Every route is token-protected; responses never echo the token.
 */
export function createAdminActions(deps: AdminDeps): AdminActions {
  const log = deps.log ?? ((msg: string, err?: unknown) => console.error(msg, err));

  async function startSwarm(body: unknown): Promise<AdminResult> {
    const parsed = swarmSchema.safeParse(body);
    if (!parsed.success) return BAD_REQUEST;
    if (deps.swarm.running() > 0) return { status: 409, body: { reason: 'running' } };
    void deps.swarm.start(parsed.data.pairs, parsed.data.rounds).catch((error: unknown) => {
      log('[admin] swarm failed', error);
    });
    return OK;
  }

  async function stopSwarm(): Promise<AdminResult> {
    deps.swarm.stop();
    return OK;
  }

  async function setFund(body: unknown): Promise<AdminResult> {
    const parsed = fundSchema.safeParse(body);
    if (!parsed.success) return BAD_REQUEST;
    deps.setFundEnabled(parsed.data.enabled);
    return { status: 200, body: { ok: true, enabled: parsed.data.enabled } };
  }

  async function setFeaturedDuel(body: unknown): Promise<AdminResult> {
    const parsed = featuredSchema.safeParse(body);
    if (!parsed.success) return BAD_REQUEST;
    deps.setFeatured(parsed.data.duelId);
    return OK;
  }

  async function reserveAgentFor(body: unknown): Promise<AdminResult> {
    const parsed = reserveSchema.safeParse(body);
    if (!parsed.success) return BAD_REQUEST;
    deps.reserveAgent(parsed.data.p1 === null ? null : (parsed.data.p1.toLowerCase() as Hex));
    return OK;
  }

  /**
   * Merges one training file into the live agent, then renames it so the same run can never
   * be merged twice. Calls are serialized, so two concurrent merges cannot both read the file.
   */
  async function mergeTrainNow(): Promise<AdminResult> {
    let raw: string;
    try {
      raw = readFileSync(deps.trainPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NO_TRAINING;
      log('[admin] merge-train: cannot read the training file', error);
      return { status: 500, body: { reason: 'read_failed' } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return INVALID_TRAINING;
    }
    const trained = agentDataSchema.safeParse(parsed);
    if (!trained.success) return INVALID_TRAINING;

    try {
      await deps.agentStore.update((live) => mergeTrained(live, trained.data as AgentData));
    } catch (error) {
      log('[admin] merge-train: the agent store rejected the update', error);
      return { status: 500, body: { reason: 'store' } };
    }
    const merged = deps.agentStore.get();
    try {
      deps.onAgentChanged?.();
    } catch (error) {
      log('[admin] merge-train: agent broadcast failed', error);
    }

    try {
      renameSync(deps.trainPath, `${deps.trainPath}.merged-${Date.now()}`);
    } catch (error) {
      log('[admin] merge-train: merged but could not rename the training file', error);
      return { status: 500, body: { reason: 'rename' } };
    }

    return { status: 200, body: { ok: true, policy: merged.policy, sim: merged.sim } };
  }

  let mergeQueue: Promise<unknown> = Promise.resolve();
  function mergeTrain(): Promise<AdminResult> {
    const next = mergeQueue.then(() => mergeTrainNow());
    mergeQueue = next.catch(() => undefined);
    return next;
  }

  async function wallets(): Promise<AdminResult> {
    const { master, operator, agent, bots } = deps.wallets;
    try {
      const [masterWei, operatorWei, agentWei, botWei] = await Promise.all([
        deps.balanceOf(master),
        deps.balanceOf(operator),
        deps.balanceOf(agent),
        Promise.all(bots.map((address) => deps.balanceOf(address))),
      ]);
      return {
        status: 200,
        body: {
          master: { address: master, balance: formatEther(masterWei) },
          operator: { address: operator, balance: formatEther(operatorWei) },
          agent: { address: agent, balance: formatEther(agentWei) },
          bots: bots.map((address, index) => ({ address, balance: formatEther(botWei[index] ?? 0n) })),
        },
      };
    } catch (error) {
      log('[admin] wallets: balance read failed', error);
      return { status: 502, body: { reason: 'rpc' } };
    }
  }

  return { startSwarm, stopSwarm, setFund, setFeaturedDuel, reserveAgentFor, mergeTrain, wallets };
}
