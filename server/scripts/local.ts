/**
 * `pnpm local`: one command that runs the whole game on this machine with no MON and no .env.
 * anvil (0.3 s blocks) + contracts + game server + Vite dev server, all as children of this process.
 *
 * The server child gets everything through its environment. server/src/env.ts also loads a repo-root `.env`
 * if one exists, but process.loadEnvFile never overrides a variable that is already set, so every variable we
 * pass wins, and the secret ones we must not inherit (LLM_*, MAINNET_*) are passed as empty strings.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeFunctionData, createPublicClient, http, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { nadCardsAbi } from '@nad/shared';
import {
  ANVIL_CHAIN_ID,
  ANVIL_MNEMONIC,
  anvilChain,
  anvilDeployer,
  createAnvilSender,
  deployGame,
  startAnvil,
  type AnvilHandle,
} from './anvil';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ANVIL_PORT = 8545;
const SERVER_PORT = 8080;
const WEB_PORT = 5173;
const BLOCK_TIME_SEC = 0.3;
const MIN_NODE_MAJOR = 20;
const SERVER_READY_TIMEOUT_MS = 30_000;
const WEB_READY_TIMEOUT_MS = 60_000;
const HTTP_POLL_MS = 250;
const HEALTH_POLL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_MAX_FAILURES = 3;
const KILL_GRACE_MS = 3_000;
const TAIL_LINES = 40;
const ADMIN_TOKEN = 'local-dev'; // not a secret: the server only listens for local use
const FUND_BUDGET_MON = '1000';
const EVENT_NAME = 'Monicard (local)';
const FOUNDRY_HINT = 'Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup';

// Anvil's well-known public dev accounts (indexes into the default mnemonic). Index 0 deploys.
const MASTER_INDEX = 1;
const OPERATOR_INDEX = 2;
const AGENT_INDEX = 3;

/** Variables the local server must never inherit; passed as '' so a repo-root .env cannot add them back. */
const SECRET_ENV_PATTERN = /^(LLM_|MAINNET_)/;
const SHIELDED_NAMES = [
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'MAINNET_RPC_URL',
  'MAINNET_DEPLOYER_KEY',
] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------- pure helpers (unit tested)

export type LocalKeys = { master: Hex; operator: Hex; agent: Hex };

function privateKeyOf(index: number): Hex {
  const raw = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (!raw) throw new Error(`no private key for anvil account ${index}`);
  return `0x${Buffer.from(raw).toString('hex')}`;
}

/** Keys of the public anvil dev accounts that act as faucet, settler and AI Agent. */
export const deriveLocalKeys = (): LocalKeys => ({
  master: privateKeyOf(MASTER_INDEX),
  operator: privateKeyOf(OPERATOR_INDEX),
  agent: privateKeyOf(AGENT_INDEX),
});

/** Environment for the game server: the user's own env, minus the LLM and MAINNET variables, plus the local settings. */
export function buildServerEnv(
  base: Readonly<Record<string, string | undefined>>,
  keys: LocalKeys,
  dataDir: string,
): Record<string, string | undefined> {
  const inherited = Object.fromEntries(Object.entries(base).filter(([name]) => !SECRET_ENV_PATTERN.test(name)));
  return {
    ...inherited,
    DEPLOYMENT: 'anvil',
    PORT: String(SERVER_PORT),
    RPC_URLS: `http://127.0.0.1:${ANVIL_PORT}`,
    MASTER_KEY: keys.master,
    OPERATOR_KEY: keys.operator,
    AGENT_KEY: keys.agent,
    ADMIN_TOKEN,
    FUND_ENABLED: 'true',
    FUND_BUDGET_MON,
    DATA_DIR: dataDir,
    PUBLIC_URL: `http://localhost:${WEB_PORT}`,
    EVENT_NAME,
  };
}

/** Blank the secret variables explicitly so server/src/env.ts cannot fill them from a user `.env`. */
export function shieldFromDotenv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...env, ...Object.fromEntries(SHIELDED_NAMES.map((name) => [name, ''])) };
}

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** First non-internal IPv4 address (the address a phone on the same Wi-Fi can reach), or null. */
export function lanAddress(interfaces: Interfaces): string | null {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // Node 18.0-18.3 reported the family as the number 4.
      const isV4 = entry.family === 'IPv4' || (entry.family as unknown) === 4;
      if (isV4 && !entry.internal) return entry.address;
    }
  }
  return null;
}

/** Returns an error message when this Node is too old, else null. */
export function checkNodeVersion(version: string): string | null {
  const major = Number.parseInt(version.replace(/^v/, ''), 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return null;
  return `Node ${MIN_NODE_MAJOR} or newer is required (found ${version}). Install it from https://nodejs.org`;
}

export type BannerInput = {
  webPort: number;
  lan: string | null;
  cards: string;
  arena: string;
  agentCardId: bigint;
};

export function bannerLines(input: BannerInput): string[] {
  const local = `http://localhost:${input.webPort}`;
  const open = input.lan
    ? `Open ${local} on this computer (or http://${input.lan}:${input.webPort} on your phone, same Wi-Fi).`
    : `Open ${local} on this computer.`;
  return [
    '',
    `Monicard is running locally. ${open}`,
    '',
    `  NadCards   ${input.cards}`,
    `  BlitzArena ${input.arena}`,
    `  AI Agent card #${input.agentCardId}`,
    '',
    `Chain: local anvil (id ${ANVIL_CHAIN_ID}), ${BLOCK_TIME_SEC} s blocks. No real MON is used.`,
    'Press Ctrl+C to stop.',
    '',
  ];
}

// ---------------------------------------------------------------- process registry

type Managed = {
  name: string;
  stop(): void;
  /** Last output lines, for failure reports. */
  tail(): string;
  exited(): boolean;
};

const registry: Managed[] = [];
let shuttingDown = false;

const log = (line: string): void => console.log(line);
const logError = (line: string): void => console.error(line);

/** The server prefixes its own lines with `[server]`; drop it so the registry prefix is not doubled. */
export function stripOwnPrefix(line: string, name: string): string {
  const own = `[${name}]`;
  return line.startsWith(own) ? line.slice(own.length).trimStart() : line;
}

function pipeWithPrefix(stream: NodeJS.ReadableStream | null, prefix: string, lines: string[]): void {
  if (!stream) return;
  let partial = '';
  const name = prefix.slice(1, -1);
  const emit = (rawLine: string): void => {
    const line = stripOwnPrefix(rawLine, name);
    lines.push(line);
    if (lines.length > TAIL_LINES) lines.shift();
    // Once shutdown has begun the children print noise (esbuild "service was stopped", pnpm errors).
    if (!shuttingDown) log(`${prefix} ${line}`);
  };
  stream.on('data', (chunk: Buffer) => {
    const parts = (partial + chunk.toString()).split('\n');
    partial = parts.pop() ?? '';
    parts.forEach(emit);
  });
  stream.on('end', () => {
    if (partial) emit(partial);
  });
}

/** Kill the child's whole process group (pnpm -> tsx -> node), so nothing is orphaned. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

function spawnManaged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): Managed {
  const lines: string[] = [];
  const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let exited = false;
  pipeWithPrefix(child.stdout, `[${name}]`, lines);
  pipeWithPrefix(child.stderr, `[${name}]`, lines);
  child.on('error', (error) => lines.push(`spawn error: ${error.message}`));
  child.on('exit', (code, signal) => {
    exited = true;
    if (!shuttingDown) void fail(`${name} exited unexpectedly (${signal ?? `code ${code}`})`);
  });
  const managed: Managed = {
    name,
    stop: () => killGroup(child, 'SIGTERM'),
    tail: () => lines.join('\n'),
    exited: () => exited,
  };
  registry.push(managed);
  return managed;
}

function trackAnvil(anvil: AnvilHandle): void {
  let failures = 0;
  let stopped = false;
  const probe = async (): Promise<void> => {
    while (!stopped && !shuttingDown) {
      await sleep(HEALTH_POLL_MS);
      try {
        const res = await fetch(anvil.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        await res.arrayBuffer();
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= HEALTH_MAX_FAILURES && !shuttingDown) {
          void fail('anvil stopped answering');
          return;
        }
      }
    }
  };
  registry.push({
    name: 'anvil',
    stop: () => {
      stopped = true;
      anvil.stop();
    },
    tail: () => '(anvil output is not captured; run `anvil --chain-id 10143 --block-time 0.3` by hand to see it)',
    exited: () => stopped,
  });
  void probe();
}

function stopAllSync(): void {
  for (const managed of registry) managed.stop();
}

async function shutdown(code: number): Promise<never> {
  if (shuttingDown) return new Promise<never>(() => undefined); // first caller exits the process
  shuttingDown = true;
  log('Stopping…');
  stopAllSync();
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && registry.some((m) => !m.exited())) await sleep(50);
  log('Stopped.');
  process.exit(code);
}

async function fail(message: string): Promise<never> {
  if (!shuttingDown) {
    logError(`\n${message}`);
    for (const managed of registry) {
      if (managed.exited()) logError(`--- last output of ${managed.name} ---\n${managed.tail()}`);
    }
  }
  return shutdown(1);
}

// ---------------------------------------------------------------- preflight

function anvilOnPath(): boolean {
  return spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, () => probe.close(() => done(true)));
  });
}

async function portIsFree(port: number): Promise<boolean> {
  const busy = (await accepts('127.0.0.1', port)) || (await accepts('::1', port));
  return !busy && (await canListen(port));
}

const PORT_USES: ReadonlyArray<readonly [number, string]> = [
  [ANVIL_PORT, 'anvil'],
  [SERVER_PORT, 'the game server (the web dev proxy is fixed to this port)'],
  [WEB_PORT, 'the Vite dev server'],
];

async function preflight(): Promise<string[]> {
  const problems: string[] = [];
  const nodeProblem = checkNodeVersion(process.version);
  if (nodeProblem) problems.push(nodeProblem);
  if (!anvilOnPath()) problems.push(`anvil was not found on your PATH. ${FOUNDRY_HINT}`);
  for (const [port, use] of PORT_USES) {
    if (!(await portIsFree(port))) {
      problems.push(`Port ${port} is busy but ${use} needs it. Find the process with: lsof -i :${port}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- steps

function expectedDeployment(): { cards: string; arena: string } {
  const raw = readFileSync(join(ROOT, 'deployments', 'anvil.json'), 'utf8');
  return JSON.parse(raw) as { cards: string; arena: string };
}

async function deployAndVerify(rpcUrl: string): Promise<{ cards: Hex; arena: Hex }> {
  const noMineNeeded = async (): Promise<void> => undefined; // anvil mines by itself
  const deployed = await deployGame(rpcUrl, anvilDeployer(), noMineNeeded);
  const expected = expectedDeployment();
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  if (!same(deployed.cards, expected.cards) || !same(deployed.arena, expected.arena)) {
    throw new Error(
      `Deployed addresses differ from deployments/anvil.json (cards ${deployed.cards}, arena ${deployed.arena}). ` +
        'Run this from a fresh anvil: stop any other anvil and start again.',
    );
  }
  return deployed;
}

/** The AI Agent needs a card before the first duel: it does a free pull. */
async function giveAgentACard(rpcUrl: string, cards: Hex): Promise<bigint> {
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: AGENT_INDEX });
  const sender = await createAnvilSender(rpcUrl, account, cards);
  const receipt = await sender.send(encodeFunctionData({ abi: nadCardsAbi, functionName: 'freePull' }));
  if (receipt.status !== 'success') throw new Error('the AI Agent freePull reverted');
  const client = createPublicClient({ chain: anvilChain, transport: http(rpcUrl), cacheTime: 0 });
  const cardId = await client.readContract({
    address: cards,
    abi: nadCardsAbi,
    functionName: 'cardOf',
    args: [account.address],
  });
  if (cardId === 0n) throw new Error('the AI Agent has no card after freePull');
  return cardId;
}

async function waitForHttp(url: string, timeoutMs: number, who: Managed): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (who.exited()) throw new Error(`${who.name} exited before it answered.\n${who.tail()}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      await res.arrayBuffer();
      if (res.ok) return;
    } catch {
      // not answering yet
    }
    await sleep(HTTP_POLL_MS);
  }
  throw new Error(`${who.name} did not answer ${url} within ${timeoutMs / 1000} s.\n${who.tail()}`);
}

async function startServer(keys: LocalKeys): Promise<void> {
  const dataDir = join(ROOT, 'data', 'local');
  mkdirSync(dataDir, { recursive: true });
  const env = shieldFromDotenv(buildServerEnv(process.env, keys, dataDir));
  const server = spawnManaged('server', 'pnpm', ['-F', 'server', 'exec', 'tsx', 'src/main.ts'], env as NodeJS.ProcessEnv);
  await waitForHttp(`http://localhost:${SERVER_PORT}/config`, SERVER_READY_TIMEOUT_MS, server);
}

async function startWeb(): Promise<void> {
  const web = spawnManaged(
    'web',
    'pnpm',
    ['-F', '@nad/web', 'dev', '--port', String(WEB_PORT), '--strictPort'],
    process.env,
  );
  await waitForHttp(`http://localhost:${WEB_PORT}/`, WEB_READY_TIMEOUT_MS, web);
}

async function run(): Promise<void> {
  const problems = await preflight();
  if (problems.length > 0) {
    problems.forEach((problem) => logError(`Error: ${problem}`));
    process.exit(1);
  }
  const keys = deriveLocalKeys();

  log(`Starting anvil (chain ${ANVIL_CHAIN_ID}, ${BLOCK_TIME_SEC} s blocks) on port ${ANVIL_PORT}...`);
  const anvil = await startAnvil(ANVIL_PORT, { blockTimeSec: BLOCK_TIME_SEC });
  trackAnvil(anvil);

  log('Deploying NadCards and BlitzArena...');
  const { cards, arena } = await deployAndVerify(anvil.rpcUrl);
  const agentCardId = await giveAgentACard(anvil.rpcUrl, cards);
  log(`AI Agent holds card #${agentCardId}.`);

  log('Starting the game server...');
  await startServer(keys);
  log('Starting the web dev server...');
  await startWeb();

  bannerLines({ webPort: WEB_PORT, lan: lanAddress(networkInterfaces()), cards, arena, agentCardId }).forEach(log);
}

function main(): void {
  // Also on 'exit': a crash must not leave anvil or the children behind.
  process.on('exit', stopAllSync);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      void shutdown(0);
    });
  }
  run().catch((error: unknown) => void fail(`Failed to start: ${messageOf(error)}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
