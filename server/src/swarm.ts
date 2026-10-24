import { DUEL_BLOCKS, type DuelView, type Hex } from '@nad/shared';
import type { TransactionReceipt } from 'viem';
import { runDuelPair, type PairSide, type RunDuelPairOpts } from './sim/duelLoop';

export type SwarmBot = {
  address: Hex;
  cardId: bigint;
  send: (data: Hex) => Promise<TransactionReceipt>;
};

export type SwarmDeps = {
  bots: readonly SwarmBot[];
  readDuel: (id: bigint) => Promise<DuelView | null>;
  readBlock: () => Promise<number>;
  balanceOf: (address: Hex) => Promise<bigint>;
  /** Budget one bot needs for one duel (see `estimateDuelCostWei`). */
  duelCostWei: () => bigint;
  rng?: () => number;
  onError?: (err: unknown, ctx: { pair: number; round: number }) => void;
  /** Blocks per attack batch: 10 is ≈3 s at Monad's 0.3 s blocks, at most 30 taps per tx. */
  batchBlocks?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to the real pair loop. */
  runPair?: typeof runDuelPair;
};

export type Swarm = {
  start(pairs: number, rounds: number): Promise<void>;
  stop(): void;
  running(): number;
};

export const DEFAULT_BATCH_BLOCKS = 10;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const MIN_TAPS_PER_SEC = 5;
const TAP_SPAN = 4;
const MIN_SKILL_THRESHOLD = 10;
const SKILL_THRESHOLD_CHOICES = 81;
const PERCENT = 100;
/** maxFeePerGas is twice the base fee on Monad. */
const MAX_FEE_MULTIPLIER = 2n;

const defaultOnError = (err: unknown, ctx: { pair: number; round: number }): void =>
  console.error(`swarm: pair ${ctx.pair} round ${ctx.round} failed`, err);

/**
 * What one bot must hold to see a duel through. Monad charges the gas LIMIT, not the gas
 * used, so every batched attack is charged in full: the create/join plus the attack txs,
 * at maxFeePerGas.
 */
export function estimateDuelCostWei(cfg: {
  gasLimits: { createDuel: number; joinDuel: number; attack: number };
  gasPrice: bigint;
  batchBlocks: number;
}): bigint {
  const batchBlocks = Math.max(1, Math.trunc(cfg.batchBlocks));
  const attacks = BigInt(Math.ceil(DUEL_BLOCKS / batchBlocks) + 1);
  const createOrJoin = BigInt(Math.max(cfg.gasLimits.createDuel, cfg.gasLimits.joinDuel));
  const perBot = createOrJoin + attacks * BigInt(cfg.gasLimits.attack);
  return perBot * MAX_FEE_MULTIPLIER * cfg.gasPrice;
}

/** Per-duel personality: a tap rate in [5, 9) and a skill threshold in [10, 90]. No coach, no LLM. */
function makeSide(bot: SwarmBot, rng: () => number): PairSide {
  const tapsPerSec = MIN_TAPS_PER_SEC + rng() * TAP_SPAN;
  const threshold = MIN_SKILL_THRESHOLD + Math.floor(rng() * SKILL_THRESHOLD_CHOICES);
  return {
    send: bot.send,
    cardId: bot.cardId,
    tapsPerSec: () => tapsPerSec,
    useSkill: (s) => !s.skillUsed && s.myHp * PERCENT <= threshold * s.myMaxHp,
  };
}

/**
 * Demo swarm: bot-vs-bot duels run in parallel pairs so the projector shows many
 * simultaneous transactions. Budgets are checked before every duel, so a pair stops
 * instead of starting a duel that cannot finish; `stop()` lets in-flight duels end.
 */
export function createSwarm(deps: SwarmDeps): Swarm {
  const rng = deps.rng ?? Math.random;
  const onError = deps.onError ?? defaultOnError;
  const runPair = deps.runPair ?? runDuelPair;
  const batchBlocks = deps.batchBlocks ?? DEFAULT_BATCH_BLOCKS;

  let active: Promise<void> | null = null;
  let activePairs = 0;
  let stopping = false;

  async function bothFunded(a: SwarmBot, b: SwarmBot): Promise<boolean> {
    const cost = deps.duelCostWei();
    const [balanceA, balanceB] = await Promise.all([deps.balanceOf(a.address), deps.balanceOf(b.address)]);
    return balanceA >= cost && balanceB >= cost;
  }

  /** Runs up to `rounds` duels back to back; the creator alternates every round. */
  async function runOnePair(a: SwarmBot, b: SwarmBot, pair: number, rounds: number): Promise<void> {
    let failures = 0;
    for (let round = 0; round < rounds; round += 1) {
      if (stopping || failures >= MAX_CONSECUTIVE_FAILURES) return;

      try {
        if (!(await bothFunded(a, b))) return;
      } catch (error) {
        // An unreadable budget must never start a duel blind; retry the next round.
        failures += 1;
        onError(error, { pair, round });
        continue;
      }

      const [creator, joiner] = round % 2 === 0 ? [a, b] : [b, a];
      const opts: RunDuelPairOpts = {
        p1: makeSide(creator, rng),
        p2: makeSide(joiner, rng),
        readDuel: deps.readDuel,
        readBlock: deps.readBlock,
        batchBlocks,
        pollMs: deps.pollMs,
        sleep: deps.sleep,
      };
      try {
        await runPair(opts);
        failures = 0;
      } catch (error) {
        failures += 1;
        onError(error, { pair, round });
      }
    }
  }

  async function run(pairs: number, rounds: number): Promise<void> {
    const cost = deps.duelCostWei();
    const balances = await Promise.all(deps.bots.map((bot) => deps.balanceOf(bot.address)));
    const eligible = deps.bots.filter((_, index) => (balances[index] ?? 0n) >= cost);
    const count = Math.min(pairs, Math.floor(eligible.length / 2));

    activePairs = count;
    if (count === 0) return;

    const jobs: Promise<void>[] = [];
    for (let pair = 0; pair < count; pair += 1) {
      const a = eligible[pair * 2]!;
      const b = eligible[pair * 2 + 1]!;
      jobs.push(runOnePair(a, b, pair, rounds).finally(() => {
        activePairs -= 1;
      }));
    }
    await Promise.all(jobs);
  }

  return {
    async start(pairs, rounds) {
      if (active !== null) throw new Error('swarm already running');
      stopping = false;
      const runPromise = run(pairs, rounds);
      active = runPromise;
      try {
        await runPromise;
      } finally {
        active = null;
      }
    },
    stop() {
      stopping = true;
    },
    running() {
      return activePairs;
    },
  };
}
