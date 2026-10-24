import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blitzArenaAbi, decodeDuels, nadCardsAbi, type Hex } from '@nad/shared';
import { createPublicClient, encodeFunctionData, http, parseEther, type Account, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  anvilChain,
  anvilDeployer,
  createAnvilSender,
  deployGame,
  fundAccount,
  startAnvil,
  startMiner,
  type AnvilHandle,
  type AnvilSender,
} from './anvil';
import { llmCoach, onDuelSettled, ruleCoach, type CoachContext, type CoachOutput } from '../src/agent/coach';
import {
  agentTapRate,
  decideSkill,
  emptyAgentData,
  levelFromWins,
  rollDiscipline,
  type AgentData,
  type Policy,
} from '../src/agent/policy';
import { llmFromEnv, type Llm } from '../src/llm';
import { runDuelPair } from '../src/sim/duelLoop';
import type { DuelSummary, SideState } from '../src/sim/types';

const PORT = 8546;
const ACCOUNT_FUNDS = parseEther('100');
const MINE_TICK_MS = 15;
const BLOCKS_PER_TICK = 3;
const SETUP_MINE_MS = 20;
const BATCH_BLOCKS = 3;
const POLL_MS = 10;
const SAVE_EVERY = 10;
const MAX_CONSECUTIVE_FAILURES = 5;
const PERCENT = 100;
const BOT_MIN_TAPS = 5;
const BOT_TAP_SPAN = 4;
const BOT_MIN_THRESHOLD = 10;
const BOT_THRESHOLD_CHOICES = 81;
const DEFAULT_DUELS = 300;
const DEFAULT_LLM_EVERY = 10;
const DEFAULT_BOTS = 4;
const MS_PER_MINUTE = 60_000;
const RECENT_LESSONS = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- pure helpers

export type TrainArgs = { duels: number; llmEvery: number; bots: number };

function parseCount(flag: string, raw: string | undefined, min: number): number {
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(value) || value < min) {
    throw new Error(`${flag} must be an integer >= ${min} (got ${raw === undefined ? 'nothing' : `"${raw}"`})`);
  }
  return value;
}

/** Parses `--duels N [--llm-every K] [--bots B]`; throws a clear Error on anything invalid. */
export function parseTrainArgs(argv: readonly string[]): TrainArgs {
  const args: TrainArgs = { duels: DEFAULT_DUELS, llmEvery: DEFAULT_LLM_EVERY, bots: DEFAULT_BOTS };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const raw = argv[i + 1];
    if (flag === '--duels') args.duels = parseCount(flag, raw, 1);
    else if (flag === '--llm-every') args.llmEvery = parseCount(flag, raw, 0);
    else if (flag === '--bots') args.bots = parseCount(flag, raw, 1);
    else throw new Error(`unknown argument "${flag}" (use --duels N, --llm-every K, --bots B)`);
  }
  return args;
}

/**
 * Starting point of a training run. sim/testnet counters are reset because the server's
 * mergeTrained ADDS trained.sim to live.sim; the live wins only feed the level computation.
 */
export function prepareTrainingData(live: AgentData | null): { data: AgentData; baseWins: number } {
  if (live === null) return { data: emptyAgentData(), baseWins: 0 };
  return {
    data: {
      policy: { ...live.policy },
      lessons: [...live.lessons],
      opponents: {},
      sim: { duels: 0, wins: 0 },
      testnet: { duels: 0, wins: 0 },
    },
    baseWins: live.sim.wins + live.testnet.wins,
  };
}

export type BotProfile = { tapsPerSec: number; skillThreshold: number };

/** Per-duel bot personality: taps/s uniform in [5, 9), skill threshold uniform integer in [10, 90]. */
export const botProfile = (rng: () => number): BotProfile => ({
  tapsPerSec: BOT_MIN_TAPS + rng() * BOT_TAP_SPAN,
  skillThreshold: BOT_MIN_THRESHOLD + Math.floor(rng() * BOT_THRESHOLD_CHOICES),
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isCounter = (v: unknown): boolean =>
  isRecord(v) && typeof v.duels === 'number' && typeof v.wins === 'number';

/** Minimal shape check for an agent.json read from disk. */
export function isAgentData(v: unknown): v is AgentData {
  return (
    isRecord(v) &&
    isRecord(v.policy) &&
    typeof v.policy.skillHpThreshold === 'number' &&
    typeof v.policy.finisher === 'boolean' &&
    Array.isArray(v.lessons) &&
    isCounter(v.sim) &&
    isCounter(v.testnet)
  );
}

// ------------------------------------------------------------------- file I/O

function resolvePaths(root: string, env: NodeJS.ProcessEnv): { dataDir: string; input: string; output: string } {
  const dataDir = env.DATA_DIR ? path.resolve(root, env.DATA_DIR) : path.join(root, 'data');
  return { dataDir, input: path.join(dataDir, 'agent.json'), output: path.join(dataDir, 'agent.train.json') };
}

/** Reads the live agent.json; a missing file is fine, an unreadable one warns and falls back to null. */
function readLiveData(file: string): AgentData | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isAgentData(parsed)) return parsed;
    console.warn(`warning: ${file} has an unexpected shape; starting from empty agent data`);
  } catch (error) {
    console.warn(`warning: cannot parse ${file} (${error instanceof Error ? error.message : String(error)}); starting from empty agent data`);
  }
  return null;
}

/** Atomic write: temp file, then rename. Opponents are dropped (the server ignores them on merge). */
function persist(file: string, data: AgentData): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...data, opponents: {} }, null, 2)}\n`);
  renameSync(tmp, file);
}

function loadLlm(llmEvery: number, root: string): Llm | null {
  if (llmEvery === 0) return null;
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch {
    // a missing .env is fine
  }
  const llm = llmFromEnv(process.env);
  if (llm === null) console.log('LLM not configured; rule coach for all duels');
  return llm;
}

// ---------------------------------------------------------------------- coach

type CoachFn = (
  s: DuelSummary,
  policy: Policy,
  rng: () => number,
  ctx: CoachContext,
  duelIndex: number,
  lessons: AgentData['lessons'],
) => Promise<CoachOutput>;

/** One place that picks the coach; `stats.llmDuels` counts duels routed to the LLM coach. */
function makeCoach(llm: Llm | null, llmEvery: number, stats: { llmDuels: number }): CoachFn {
  return async (s, policy, rng, ctx, duelIndex, lessons) => {
    if (llm !== null && llmEvery > 0 && (duelIndex + 1) % llmEvery === 0) {
      stats.llmDuels += 1;
      return llmCoach(s, policy, llm, rng, undefined, { recentLessons: lessons.slice(0, RECENT_LESSONS), ctx });
    }
    return ruleCoach(s, policy, rng, ctx);
  };
}

// ---------------------------------------------------------------- chain setup

type Player = { account: Account; sender: AnvilSender; cardId: bigint; element: number };

/** Setup txs are mined one block at a time until the pending send settles. */
async function mineUntilSettled<T>(promise: Promise<T>, mine: (n: number) => Promise<void>): Promise<T> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  promise.then(mark, mark);
  while (!settled) {
    await sleep(SETUP_MINE_MS);
    await mine(1);
  }
  return promise;
}

async function createPlayer(anvil: AnvilHandle, client: PublicClient, cards: Hex, arena: Hex): Promise<Player> {
  const account = privateKeyToAccount(generatePrivateKey());
  await fundAccount(anvil.rpcUrl, account.address, ACCOUNT_FUNDS);
  const setup = await createAnvilSender(anvil.rpcUrl, account, cards);
  const data = encodeFunctionData({ abi: nadCardsAbi, functionName: 'freePull' });
  const receipt = await mineUntilSettled(setup.send(data), anvil.mine);
  if (receipt.status !== 'success') throw new Error(`freePull failed for ${account.address}`);
  const cardId = await client.readContract({ address: cards, abi: nadCardsAbi, functionName: 'cardOf', args: [account.address] });
  if (cardId === 0n) throw new Error(`${account.address} owns no card after freePull`);
  const card = await client.readContract({ address: cards, abi: nadCardsAbi, functionName: 'cards', args: [cardId] });
  const sender = await createAnvilSender(anvil.rpcUrl, account, arena);
  return { account, sender, cardId, element: Number(card.element) };
}

// ------------------------------------------------------------------ the loop

type Rig = { client: PublicClient; arena: Hex; agent: Player; bots: Player[] };

type DuelOutcome = { summary: DuelSummary; ctx: CoachContext };

async function playDuel(rig: Rig, data: AgentData, baseWins: number, index: number, bots: number): Promise<DuelOutcome> {
  const bot = rig.bots[index % bots]!;
  const level = levelFromWins(baseWins + data.sim.wins);
  const followPolicy = rollDiscipline(level, Math.random);
  const skillDraw = Math.random();
  const agentTaps = agentTapRate(Math.random);
  const profile = botProfile(Math.random);
  const policy = data.policy;
  let agentLast: SideState | null = null;

  const result = await runDuelPair({
    p1: {
      send: (d) => bot.sender.send(d),
      cardId: bot.cardId,
      element: bot.element,
      tapsPerSec: () => profile.tapsPerSec,
      useSkill: (s) => !s.skillUsed && s.myHp * PERCENT <= profile.skillThreshold * s.myMaxHp,
    },
    p2: {
      send: (d) => rig.agent.sender.send(d),
      cardId: rig.agent.cardId,
      element: rig.agent.element,
      tapsPerSec: () => agentTaps,
      useSkill: (s) => decideSkill(s, policy, followPolicy, () => skillDraw),
      onBlock: (s) => {
        agentLast = s;
      },
    },
    readDuel: async (id) => {
      const raw = await rig.client.readContract({ address: rig.arena, abi: blitzArenaAbi, functionName: 'getDuels', args: [id, 1n] });
      return decodeDuels(raw, id)[0] ?? null;
    },
    readBlock: () => rig.client.getBlockNumber().then(Number),
    batchBlocks: BATCH_BLOCKS,
    pollMs: POLL_MS,
  });

  const last = agentLast as SideState | null;
  if (last === null) throw new Error(`duel ${result.duelId}: agent side never observed a block`);
  const summary: DuelSummary = { ...result.p2, mode: 'sim', opponent: bot.account.address, followedPolicy: followPolicy };
  return { summary, ctx: { atk: last.atk, mult: last.mult, myMaxHp: last.myMaxHp } };
}

type RunReport = { data: AgentData; completed: number; failed: number; lessonsAdded: number; aborted: boolean };

function progressLine(done: number, total: number, data: AgentData, from: number): string {
  const winrate = data.sim.duels === 0 ? 0 : Math.round((data.sim.wins * PERCENT) / data.sim.duels);
  return `duel ${done}/${total} · winrate ${winrate}% · threshold ${from}→${data.policy.skillHpThreshold} · lessons ${data.lessons.length}`;
}

async function trainLoop(
  rig: Rig,
  args: TrainArgs,
  start: { data: AgentData; baseWins: number },
  coach: CoachFn,
  output: string,
  interrupted: () => boolean,
): Promise<RunReport> {
  let data = start.data;
  const fromThreshold = data.policy.skillHpThreshold;
  let consecutiveFailures = 0;
  let failed = 0;
  let lessonsAdded = 0;

  for (let i = 0; i < args.duels && !interrupted(); i++) {
    try {
      const { summary, ctx } = await playDuel(rig, data, start.baseWins, i, args.bots);
      const out = summary.followedPolicy ? await coach(summary, data.policy, Math.random, ctx, i, data.lessons) : null;
      const next = onDuelSettled(data, summary, out, Date.now());
      if (next.lessons[0] !== data.lessons[0]) lessonsAdded += 1;
      data = next;
      consecutiveFailures = 0;
    } catch (error) {
      failed += 1;
      consecutiveFailures += 1;
      console.error(`duel ${i + 1}/${args.duels} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        persist(output, data);
        return { data, completed: data.sim.duels, failed, lessonsAdded, aborted: true };
      }
    }
    if ((i + 1) % SAVE_EVERY === 0) {
      persist(output, data);
      console.log(progressLine(i + 1, args.duels, data, fromThreshold));
    }
  }
  persist(output, data);
  return { data, completed: data.sim.duels, failed, lessonsAdded, aborted: false };
}

// ----------------------------------------------------------------------- main

async function run(): Promise<void> {
  const args = parseTrainArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const paths = resolvePaths(root, process.env);
  mkdirSync(paths.dataDir, { recursive: true });

  const llm = loadLlm(args.llmEvery, root);
  const start = prepareTrainingData(readLiveData(paths.input));
  const fromThreshold = start.data.policy.skillHpThreshold;
  const llmStats = { llmDuels: 0 };
  const coach = makeCoach(llm, args.llmEvery, llmStats);

  let stop = false;
  process.once('SIGINT', () => {
    stop = true;
    console.log('SIGINT: finishing the current duel, writing partial output');
  });

  const anvil = await startAnvil(PORT);
  const started = Date.now();
  let miner: ReturnType<typeof startMiner> | null = null;
  try {
    const client = createPublicClient({ chain: anvilChain, transport: http(anvil.rpcUrl), cacheTime: 0 });
    const { cards, arena } = await deployGame(anvil.rpcUrl, anvilDeployer(), anvil.mine);
    const agent = await createPlayer(anvil, client, cards, arena);
    const bots: Player[] = [];
    for (let i = 0; i < args.bots; i++) bots.push(await createPlayer(anvil, client, cards, arena));
    console.log(`setup done: agent + ${args.bots} bots on anvil ${arena}`);

    miner = startMiner(anvil.mine, MINE_TICK_MS, BLOCKS_PER_TICK, (e) => console.error('miner failed:', e.message));
    const report = await trainLoop({ client, arena, agent, bots }, args, start, coach, paths.output, () => stop);
    summarize(report, args, fromThreshold, llmStats.llmDuels, paths.output, Date.now() - started);
    if (report.aborted) throw new Error(`aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive failed duels`);
    const minerFailure = miner.failure();
    if (minerFailure) throw new Error(`miner failed: ${minerFailure.message}`);
  } finally {
    if (miner) await miner.stop();
    anvil.stop();
  }
}

function summarize(report: RunReport, args: TrainArgs, from: number, llmDuels: number, file: string, elapsedMs: number): void {
  const { data } = report;
  const perMinute = elapsedMs > 0 ? (report.completed * MS_PER_MINUTE) / elapsedMs : 0;
  console.log(`duels/minute ${perMinute.toFixed(1)} · failed ${report.failed} · lessons added ${report.lessonsAdded} · llm-coached ${llmDuels}/${args.duels}`);
  console.log(
    `TRAIN OK duels=${data.sim.duels} wins=${data.sim.wins} threshold=${from}→${data.policy.skillHpThreshold} lessons=${data.lessons.length} file=${file}`,
  );
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('TRAIN FAILED:', error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
