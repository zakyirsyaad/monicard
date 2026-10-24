/**
 * setup-bots --pairs N [--topup MON] [--dry-run]   fund + free-pull 2N bots, the agent and the operator
 * setup-bots --sweep                               return the bots' MON to the master wallet
 *
 * Keys live in DATA_DIR/bots.json (mode 0600) and are written BEFORE any MON is sent.
 * Never prints keys; logs addresses, amounts and tx hashes only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nadCardsAbi } from '@nad/shared';
import { encodeFunctionData, formatEther, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createChain } from '../src/chain';
import { loadEnv, type Env } from '../src/env';
import { createWalletQueue } from '../src/walletQueue';

const MAX_PAIRS = 50;
const DEFAULT_TOPUP_MON = '0.15';
const AGENT_TARGET_WEI = parseEther('1');
const OPERATOR_TARGET_WEI = parseEther('0.5');
const TRANSFER_GAS = 21_000n;
const FEE_HEADROOM = 2n; // walletQueue signs maxFee = 2 x gasPrice
const FREE_PULL_N9_BLOCKS = 3n; // N9: a funded wallet cannot send for 3 blocks
const PULL_CONCURRENCY = 5;
const READ_CONCURRENCY = 5;
const BLOCK_POLL_MS = 300;
const RECEIPT_POLL_MS = 300;
const RECEIPT_TIMEOUT_MS = 30_000;
const EXPLORER_TX = 'https://testnet.monadscan.com/tx/';
const BOTS_FILE = 'bots.json';
const PRIVATE_FILE_MODE = 0o600;
const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------- types

export type Bot = { privateKey: Hex; address: Hex; cardId: string | null };

export type Receipt = { status: 'success' | 'reverted'; blockNumber: bigint };

export type SetupArgs = { mode: 'setup'; pairs: number; topupMon: string; dryRun: boolean };
export type SweepArgs = { mode: 'sweep' };
export type CliArgs = SetupArgs | SweepArgs;
export type SetupOptions = Omit<SetupArgs, 'mode'>;

type Queue = { address: Hex; send(req: { to: Hex; data: Hex; gas: bigint; value?: bigint }): Promise<Hex> };

type CommonDeps = {
  loadBots(): Bot[];
  masterQueue: Queue;
  queueFor(privateKey: Hex): Queue;
  getBalance(address: Hex): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  waitReceipt(hash: Hex): Promise<Receipt>;
  log(line: string): void;
};

export type SetupDeps = CommonDeps & {
  saveBots(bots: Bot[]): void;
  generateKey(): Hex;
  agentKey: Hex;
  operatorAddress: Hex;
  cards: Hex;
  freePullGas: bigint;
  getBlockNumber(): Promise<bigint>;
  cardOf(address: Hex): Promise<bigint>;
  hasPulled(address: Hex): Promise<boolean>;
  sleep(ms: number): Promise<void>;
};

export type SweepDeps = CommonDeps & { masterAddress: Hex };

export type SetupResult = {
  ok: boolean;
  dryRun: boolean;
  created: number;
  funded: number;
  totalSentWei: bigint;
  pulled: number;
  failures: string[];
};

export type SweepResult = { ok: boolean; swept: number; totalReturnedWei: bigint; failures: string[] };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ------------------------------------------------------------------- parsing

function parsePairs(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(value) || value < 1 || value > MAX_PAIRS) {
    throw new Error(`--pairs must be an integer from 1 to ${MAX_PAIRS} (got ${raw === undefined ? 'nothing' : `"${raw}"`})`);
  }
  return value;
}

function parseTopup(raw: string | undefined): string {
  const bad = (): never => {
    throw new Error(`--topup must be a positive MON amount such as 0.15 (got ${raw === undefined ? 'nothing' : `"${raw}"`})`);
  };
  if (raw === undefined || !/^\d+(\.\d{1,18})?$/.test(raw)) return bad();
  return parseEther(raw) > 0n ? raw : bad();
}

/** Parses `--pairs N [--topup MON] [--dry-run]` or `--sweep`; throws a clear Error on anything invalid. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let pairs: string | undefined;
  let topup: string | undefined;
  let dryRun = false;
  let sweep = false;
  let sawSetupFlag = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--sweep') sweep = true;
    else if (flag === '--dry-run') {
      dryRun = true;
      sawSetupFlag = true;
    } else if (flag === '--pairs' || flag === '--topup') {
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? next : undefined;
      if (value !== undefined) i += 1;
      if (flag === '--pairs') pairs = value ?? '';
      else topup = value ?? '';
      sawSetupFlag = true;
    } else {
      throw new Error(`unknown argument "${flag}" (use --pairs N [--topup MON] [--dry-run] or --sweep)`);
    }
  }

  if (sweep) {
    if (sawSetupFlag) throw new Error('--sweep cannot be combined with --pairs, --topup or --dry-run');
    return { mode: 'sweep' };
  }
  if (pairs === undefined) throw new Error('--pairs is required (e.g. --pairs 3)');
  return { mode: 'setup', pairs: parsePairs(pairs), topupMon: parseTopup(topup ?? DEFAULT_TOPUP_MON), dryRun };
}

/** Wei still missing to reach `target`; 0 when the balance already covers it. */
export const topupNeeded = (balance: bigint, target: bigint): bigint => (balance >= target ? 0n : target - balance);

// ------------------------------------------------------------------ bots file

function isBot(value: unknown): value is Bot {
  if (typeof value !== 'object' || value === null) return false;
  const bot = value as Record<string, unknown>;
  return (
    typeof bot.privateKey === 'string' &&
    KEY_PATTERN.test(bot.privateKey) &&
    typeof bot.address === 'string' &&
    ADDRESS_PATTERN.test(bot.address) &&
    (bot.cardId === null || typeof bot.cardId === 'string')
  );
}

/** A missing file is an empty list; a corrupt one throws so keys are never overwritten. */
export function loadBots(file: string): Bot[] {
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${file} (${errorText(error)}); fix or move it, it may hold funded keys`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isBot)) {
    throw new Error(`${file} does not hold a JSON array of { privateKey, address, cardId }; fix or move it, it may hold funded keys`);
  }
  return parsed.map((bot) => ({ privateKey: bot.privateKey, address: bot.address, cardId: bot.cardId }));
}

/** Atomic write (tmp + rename), mode 0600, creating the directory. */
export function saveBots(file: string, bots: readonly Bot[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(bots, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  renameSync(tmp, file);
}

/** Keeps every existing entry as-is and appends freshly generated ones up to `count`. */
export function ensureBots(
  existing: readonly Bot[],
  count: number,
  generate: () => Hex,
): { bots: Bot[]; created: number } {
  const bots = [...existing];
  while (bots.length < count) {
    const privateKey = generate();
    bots.push({ privateKey, address: privateKeyToAccount(privateKey).address, cardId: null });
  }
  return { bots, created: bots.length - existing.length };
}

// ------------------------------------------------------------------- helpers

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type ReceiptWaitOptions = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `fetch` until it yields a receipt (null = still pending); throws with the explorer link on timeout. */
export async function waitForReceipt(
  fetch: (hash: Hex) => Promise<Receipt | null>,
  hash: Hex,
  options: ReceiptWaitOptions = {},
): Promise<Receipt> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? RECEIPT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  for (;;) {
    const receipt = await fetch(hash);
    if (receipt) return receipt;
    if (now() >= deadline) {
      throw new Error(`no receipt after ${timeoutMs / 1000}s for ${hash}: ${EXPLORER_TX}${hash}`);
    }
    await sleep(pollMs);
  }
}

async function waitForBlock(deps: Pick<SetupDeps, 'getBlockNumber' | 'sleep'>, target: bigint): Promise<void> {
  while ((await deps.getBlockNumber()) < target) await deps.sleep(BLOCK_POLL_MS);
}

async function sendAndConfirm(
  deps: Pick<CommonDeps, 'waitReceipt'>,
  queue: Queue,
  req: { to: Hex; data: Hex; gas: bigint; value?: bigint },
  what: string,
): Promise<{ hash: Hex; receipt: Receipt }> {
  const hash = await queue.send(req);
  const receipt = await deps.waitReceipt(hash);
  if (receipt.status !== 'success') throw new Error(`${what} reverted: ${EXPLORER_TX}${hash}`);
  return { hash, receipt };
}

const mon = (wei: bigint): string => `${formatEther(wei)} MON`;
const feePerTransfer = (gasPrice: bigint): bigint => TRANSFER_GAS * FEE_HEADROOM * gasPrice;

// ---------------------------------------------------------------------- setup

type Target = { label: 'bot' | 'agent' | 'operator'; address: Hex; target: bigint };
type Transfer = Target & { amount: bigint };

type PullCandidate = { label: 'bot' | 'agent'; address: Hex; privateKey: Hex };

function buildTargets(active: readonly Bot[], deps: SetupDeps, topupWei: bigint): Target[] {
  return [
    ...active.map((bot): Target => ({ label: 'bot', address: bot.address, target: topupWei })),
    { label: 'agent', address: privateKeyToAccount(deps.agentKey).address, target: AGENT_TARGET_WEI },
    { label: 'operator', address: deps.operatorAddress, target: OPERATOR_TARGET_WEI },
  ];
}

async function planTransfers(deps: SetupDeps, targets: readonly Target[]): Promise<Transfer[]> {
  const balances = await mapLimit(targets, READ_CONCURRENCY, (t) => deps.getBalance(t.address));
  return targets
    .map((t, i): Transfer => ({ ...t, amount: topupNeeded(balances[i] as bigint, t.target) }))
    .filter((t) => t.amount > 0n);
}

type FundingOutcome = { fundedBlocks: Map<string, bigint>; failed: Set<string>; failures: string[]; sentWei: bigint };

async function fund(deps: SetupDeps, transfers: readonly Transfer[]): Promise<FundingOutcome> {
  const fundedBlocks = new Map<string, bigint>();
  const failed = new Set<string>();
  const failures: string[] = [];
  let sentWei = 0n;
  for (const t of transfers) {
    try {
      const { hash, receipt } = await sendAndConfirm(
        deps,
        deps.masterQueue,
        { to: t.address, data: '0x', gas: TRANSFER_GAS, value: t.amount },
        `funding ${t.address}`,
      );
      fundedBlocks.set(t.address.toLowerCase(), receipt.blockNumber);
      sentWei += t.amount;
      deps.log(`funded ${t.label} ${t.address} +${mon(t.amount)} block ${receipt.blockNumber} tx ${hash}`);
    } catch (error) {
      failed.add(t.address.toLowerCase());
      failures.push(`funding ${t.label} ${t.address} failed: ${errorText(error)}`);
    }
  }
  return { fundedBlocks, failed, failures, sentWei };
}

type CardState = { candidate: PullCandidate; cardId: bigint; needsPull: boolean };

async function readCardState(deps: SetupDeps, candidate: PullCandidate): Promise<CardState> {
  const cardId = await deps.cardOf(candidate.address);
  if (cardId !== 0n) return { candidate, cardId, needsPull: false };
  if (await deps.hasPulled(candidate.address)) {
    deps.log(`warning: ${candidate.label} ${candidate.address} already used its free pull but owns no card; skipping`);
    return { candidate, cardId: 0n, needsPull: false };
  }
  return { candidate, cardId: 0n, needsPull: true };
}

type PullOutcome = { candidate: PullCandidate; cardId: bigint | null; error: string | null };

async function pullOne(deps: SetupDeps, candidate: PullCandidate): Promise<PullOutcome> {
  try {
    const queue = deps.queueFor(candidate.privateKey);
    const data = encodeFunctionData({ abi: nadCardsAbi, functionName: 'freePull' });
    const { hash } = await sendAndConfirm(
      deps,
      queue,
      { to: deps.cards, data, gas: deps.freePullGas, value: 0n },
      `freePull from ${candidate.address}`,
    );
    const cardId = await deps.cardOf(candidate.address);
    if (cardId === 0n) throw new Error(`no card owned after freePull (tx ${hash})`);
    deps.log(`pulled ${candidate.label} ${candidate.address} card ${cardId} tx ${hash}`);
    return { candidate, cardId, error: null };
  } catch (error) {
    return { candidate, cardId: null, error: `freePull ${candidate.label} ${candidate.address} failed: ${errorText(error)}` };
  }
}

function withCardIds(bots: readonly Bot[], known: ReadonlyMap<string, bigint>): Bot[] {
  return bots.map((bot) => {
    const id = known.get(bot.address.toLowerCase());
    return id === undefined ? bot : { ...bot, cardId: id.toString() };
  });
}

function logPlan(deps: SetupDeps, transfers: readonly Transfer[], total: bigint, masterBalance: bigint, need: bigint): void {
  deps.log(`plan: ${transfers.length} transfer(s), total ${mon(total)}; master ${deps.masterQueue.address} holds ${mon(masterBalance)}`);
  for (const t of transfers) deps.log(`  ${t.label} ${t.address} +${mon(t.amount)}`);
  deps.log(`  needed incl. gas: ${mon(need)}`);
}

export async function runSetup(deps: SetupDeps, opts: SetupOptions): Promise<SetupResult> {
  const topupWei = parseEther(opts.topupMon);
  const { bots, created } = ensureBots(deps.loadBots(), opts.pairs * 2, deps.generateKey);
  if (created > 0 && !opts.dryRun) {
    deps.saveBots(bots); // keys hit disk before any MON moves
    deps.log(`generated ${created} new bot key(s); saved ${bots.length} entries`);
  }
  const active = bots.slice(0, opts.pairs * 2);

  const transfers = await planTransfers(deps, buildTargets(active, deps, topupWei));
  const total = transfers.reduce((sum, t) => sum + t.amount, 0n);
  const [gasPrice, masterBalance] = await Promise.all([deps.getGasPrice(), deps.getBalance(deps.masterQueue.address)]);
  const need = total + feePerTransfer(gasPrice) * BigInt(transfers.length);
  logPlan(deps, transfers, total, masterBalance, need);

  const insufficient = need > masterBalance;
  if (opts.dryRun) {
    if (insufficient) deps.log(`warning: master balance is short by ${mon(need - masterBalance)}; a real run would abort`);
    deps.log('dry run: nothing sent');
    return { ok: true, dryRun: true, created, funded: 0, totalSentWei: 0n, pulled: 0, failures: [] };
  }
  if (insufficient) {
    throw new Error(`master wallet ${deps.masterQueue.address} holds ${mon(masterBalance)} but ${mon(need)} is needed (incl. gas); nothing sent`);
  }

  const funding = await fund(deps, transfers);

  const allCandidates: PullCandidate[] = [
    ...active.map((bot): PullCandidate => ({ label: 'bot', address: bot.address, privateKey: bot.privateKey })),
    { label: 'agent', address: privateKeyToAccount(deps.agentKey).address, privateKey: deps.agentKey },
  ];
  const candidates = allCandidates.filter((c) => !funding.failed.has(c.address.toLowerCase()));
  const states = await mapLimit(candidates, READ_CONCURRENCY, (c) => readCardState(deps, c));

  const known = new Map<string, bigint>();
  for (const s of states) if (s.cardId !== 0n) known.set(s.candidate.address.toLowerCase(), s.cardId);

  const toPull = states.filter((s) => s.needsPull).map((s) => s.candidate);
  const fundedPullBlocks = toPull
    .map((c) => funding.fundedBlocks.get(c.address.toLowerCase()))
    .filter((block): block is bigint => block !== undefined);
  if (fundedPullBlocks.length > 0) {
    const target = fundedPullBlocks.reduce((a, b) => (a > b ? a : b)) + FREE_PULL_N9_BLOCKS;
    deps.log(`waiting for block ${target} before free pulls (N9)`);
    await waitForBlock(deps, target);
  }

  const outcomes = await mapLimit(toPull, PULL_CONCURRENCY, (c) => pullOne(deps, c));
  for (const o of outcomes) if (o.cardId !== null) known.set(o.candidate.address.toLowerCase(), o.cardId);
  deps.saveBots(withCardIds(bots, known));

  const pullFailures = outcomes.flatMap((o) => (o.error === null ? [] : [o.error]));
  const failures = [...funding.failures, ...pullFailures];
  for (const line of failures) deps.log(`FAILED: ${line}`);
  deps.log(`done: funded ${funding.fundedBlocks.size}, sent ${mon(funding.sentWei)}, pulled ${outcomes.length - pullFailures.length}, failures ${failures.length}`);
  return {
    ok: failures.length === 0,
    dryRun: false,
    created,
    funded: funding.fundedBlocks.size,
    totalSentWei: funding.sentWei,
    pulled: outcomes.length - pullFailures.length,
    failures,
  };
}

// ---------------------------------------------------------------------- sweep

export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const bots = deps.loadBots();
  const gasPrice = await deps.getGasPrice();
  const fee = feePerTransfer(gasPrice);

  const outcomes = await mapLimit(bots, PULL_CONCURRENCY, async (bot) => {
    try {
      const balance = await deps.getBalance(bot.address);
      if (balance <= fee) return { returned: 0n, error: null };
      const value = balance - fee;
      const { hash } = await sendAndConfirm(
        deps,
        deps.queueFor(bot.privateKey),
        { to: deps.masterAddress, data: '0x', gas: TRANSFER_GAS, value },
        `sweep from ${bot.address}`,
      );
      deps.log(`swept ${bot.address} -${mon(value)} tx ${hash}`);
      return { returned: value, error: null };
    } catch (error) {
      return { returned: 0n, error: `sweep ${bot.address} failed: ${errorText(error)}` };
    }
  });

  const failures = outcomes.flatMap((o) => (o.error === null ? [] : [o.error]));
  const totalReturnedWei = outcomes.reduce((sum, o) => sum + o.returned, 0n);
  const swept = outcomes.filter((o) => o.returned > 0n).length;
  for (const line of failures) deps.log(`FAILED: ${line}`);
  deps.log(`swept ${swept} of ${bots.length} bot(s), returned ${mon(totalReturnedWei)} to ${deps.masterAddress}`);
  return { ok: failures.length === 0, swept, totalReturnedWei, failures };
}

// ----------------------------------------------------------------------- main

function buildDeps(env: Env): SetupDeps & SweepDeps {
  const chain = createChain(env.RPC_URLS, env.chainId);
  const botsFile = path.join(env.DATA_DIR, BOTS_FILE);
  const master = createWalletQueue(privateKeyToAccount(env.MASTER_KEY), chain);
  const fetchReceipt = (hash: Hex): Promise<Receipt | null> =>
    chain
      .call((c) => c.getTransactionReceipt({ hash }))
      .then((r): Receipt => ({ status: r.status, blockNumber: r.blockNumber }))
      .catch((error: unknown) => {
        if (error instanceof Error && (error.name === 'TransactionReceiptNotFoundError' || /could not be found/i.test(error.message))) {
          return null;
        }
        throw error;
      });

  return {
    loadBots: () => loadBots(botsFile),
    saveBots: (bots) => saveBots(botsFile, bots),
    generateKey: generatePrivateKey,
    agentKey: env.AGENT_KEY,
    operatorAddress: privateKeyToAccount(env.OPERATOR_KEY).address,
    cards: env.cards,
    freePullGas: BigInt(env.gasLimits.freePull),
    masterQueue: master,
    masterAddress: master.address,
    queueFor: (privateKey) => createWalletQueue(privateKeyToAccount(privateKey), chain),
    getBalance: (address) => chain.call((c) => c.getBalance({ address })),
    getBlockNumber: () => chain.call((c) => c.getBlockNumber({ cacheTime: 0 })),
    getGasPrice: () => chain.getGasPrice(),
    cardOf: (address) =>
      chain.call((c) => c.readContract({ address: env.cards, abi: nadCardsAbi, functionName: 'cardOf', args: [address] })),
    hasPulled: (address) =>
      chain.call((c) => c.readContract({ address: env.cards, abi: nadCardsAbi, functionName: 'hasPulled', args: [address] })),
    waitReceipt: (hash) => waitForReceipt(fetchReceipt, hash),
    sleep: defaultSleep,
    log: (line) => console.log(line),
  };
}

async function run(): Promise<boolean> {
  const args = parseArgs(process.argv.slice(2));
  const deps = buildDeps(loadEnv());
  if (args.mode === 'sweep') return (await runSweep(deps)).ok;
  return (await runSetup(deps, { pairs: args.pairs, topupMon: args.topupMon, dryRun: args.dryRun })).ok;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().then(
    (ok) => process.exit(ok ? 0 : 1),
    (error: unknown) => {
      console.error('SETUP-BOTS FAILED:', errorText(error));
      process.exit(1);
    },
  );
}
