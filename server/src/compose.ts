import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hex } from '@nad/shared';
import { Hono } from 'hono';
import { parseEther } from 'viem';
import type { AccountReader } from './account';
import { buildApp, isApiPath, readBots, type EventInfo } from './app';
import { startBlockWatcher, type BlockWatcher } from './blockWatcher';
import { attachCardMinting, createCardService, createChainCardReader } from './cards/service';
import { cardRoutes } from './cards/routes';
import { createCardStore } from './cards/store';
import type { CardData } from './cards/lore';
import type { Chain } from './chain';
import type { GasLimits } from './env';
import {
  FUND_AMOUNT_WEI,
  FUND_THRESHOLD_WEI,
  MAX_PER_ADDRESS,
  MAX_PER_IP_PER_10_MIN,
  createFundLimiter,
  setFundEnabled,
} from './fund';
import { fundRoutes } from './fundRoutes';
import { startPoller, type Poller, type PollerDeps } from './poller';
import { createReceiptHub, type ReceiptHub } from './receiptHub';
import { relayRoutes } from './relayRoutes';
import { attachStats, createStats, type Stats } from './stats';
import type { WalletQueue } from './walletQueue';
import { createWsHub, type AgentMsg, type WsHub } from './ws';

/** Everything the server needs from env.ts, as plain values (never the keys). */
export type ComposeConfig = {
  port: number;
  deployment: string;
  chainId: number;
  cards: Hex;
  arena: Hex;
  gasLimits: GasLimits;
  batchMs: number;
  event: EventInfo;
  dataDir: string;
  publicUrl: string;
  fundEnabled: boolean;
  fundBudgetMon: number;
};

export type ComposeDeps = {
  config: ComposeConfig;
  chain: Chain;
  agent: Hex;
  pullPrice: bigint;
  /** Pays /fund transfers. */
  masterQueue: WalletQueue;
  /** Sends settle txs from the poller. */
  operatorQueue: WalletQueue;
  accounts: AccountReader;
  /** Built web client directory; may not exist (API-only mode). */
  webDist: string;
  /** Test seam: replaces the on-chain card reader. */
  readCard?: (id: number) => Promise<CardData | null>;
  log: (line: string) => void;
};

/** The background loops, injectable so tests need no sockets or RPC. */
export type ComposeLoops = {
  createWsHub: (server: Server) => WsHub;
  startBlockWatcher: (chain: Chain, hub: ReceiptHub, opts: { onError: (err: unknown) => void }) => BlockWatcher;
  startPoller: (deps: PollerDeps) => Poller;
};

export const DEFAULT_LOOPS: ComposeLoops = { createWsHub, startBlockWatcher, startPoller };

export type Running = { stop(): Promise<void> };

export type Composed = {
  app: Hono;
  hub: ReceiptHub;
  stats: Stats;
  /** Seam: plug the agent store in here (the poller receives exactly this function). */
  getAgentMessage: () => AgentMsg | null;
  /** Attaches ws, starts the watcher and the poller. Call once, after `serve()`. */
  start(server: Server, loops?: ComposeLoops): Running;
};

/** Never include a whole viem error: it can embed the RPC URL. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return (error as Error & { shortMessage?: string }).shortMessage ?? error.message;
  return String(error);
}

/** Error logger that emits at most one line per `intervalMs`. */
export function createThrottledLogger(
  sink: (line: string) => void,
  intervalMs: number,
  now: () => number = Date.now,
): (error: unknown) => void {
  let lastAt: number | null = null;
  return (error) => {
    const t = now();
    if (lastAt !== null && t - lastAt < intervalMs) return;
    lastAt = t;
    sink(`[server] ${describeError(error)}`);
  };
}

const NOT_FOUND = { reason: 'not_found' } as const;
const WATCHER_ERROR_LOG_MS = 10_000;

/**
 * Static assets first, then a single notFound handler: API paths get a JSON 404, other GET paths
 * get the SPA index when `web/dist` exists, everything else a plain 404.
 * Must run AFTER every API route is mounted.
 */
function mountSpa(app: Hono, webDist: string, log: (line: string) => void): void {
  const indexPath = join(webDist, 'index.html');
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
  if (indexHtml === null) log(`[server] ${indexPath} not found, serving API only`);
  else app.use('*', serveStatic({ root: webDist }));

  app.notFound((c) => {
    if (isApiPath(c.req.path)) return c.json(NOT_FOUND, 404);
    if (indexHtml !== null && c.req.method === 'GET') return c.html(indexHtml);
    return c.text('404 Not Found', 404);
  });
}

/**
 * Seams for later routes, mounted before the SPA fallback:
 *   app.route('/', agentRoutes(...))   // /agent
 *   app.route('/', adminRoutes(...))   // /admin
 */
function mountLaterRoutes(_app: Hono): void {
  // intentionally empty
}

function closeServer(server: Server, log: (line: string) => void): Promise<void> {
  return new Promise((resolve) => {
    // Idle keep-alive sockets would otherwise hold close() open.
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close((error?: Error) => {
      if (error) log(`[server] http close: ${describeError(error)}`);
      resolve();
    });
  });
}

function attempt(label: string, log: (line: string) => void, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    log(`[server] stop ${label} failed: ${describeError(error)}`);
  }
}

export function composeApp(deps: ComposeDeps): Composed {
  const { config, chain, log } = deps;
  const getBalance = (address: Hex): Promise<bigint> => chain.call((c) => c.getBalance({ address }));
  const getAgentMessage = (): AgentMsg | null => null;

  const hub = createReceiptHub();
  const stats = createStats({ cards: config.cards, arena: config.arena });
  attachStats(hub, stats);

  const app = buildApp({
    chainId: config.chainId,
    cards: config.cards,
    arena: config.arena,
    gasLimits: config.gasLimits,
    batchMs: config.batchMs,
    pullPrice: deps.pullPrice,
    event: config.event,
    agent: deps.agent,
    dataDir: config.dataDir,
    getGasPrice: chain.getGasPrice,
    accounts: deps.accounts,
  });

  app.route(
    '/',
    relayRoutes({
      chain,
      hub,
      stats,
      cfg: {
        chainId: config.chainId,
        cards: config.cards,
        arena: config.arena,
        gasLimits: config.gasLimits,
        pullPrice: deps.pullPrice,
      },
      getBalance,
    }),
  );

  setFundEnabled(config.fundEnabled);
  const limiter = createFundLimiter({
    amountWei: FUND_AMOUNT_WEI,
    thresholdWei: FUND_THRESHOLD_WEI,
    maxPerAddress: MAX_PER_ADDRESS,
    maxPerIpPer10Min: MAX_PER_IP_PER_10_MIN,
    budgetWei: parseEther(String(config.fundBudgetMon)),
    ledgerPath: join(config.dataDir, 'fund.json'),
  });
  app.route('/', fundRoutes({ limiter, queue: deps.masterQueue, hub, getBalance }));

  const cardService = createCardService({
    readCard: deps.readCard ?? createChainCardReader(chain, config.cards),
    store: createCardStore(config.dataDir),
    llm: null, // final decision: template lore, no LLM for cards
    publicUrl: config.publicUrl,
  });
  attachCardMinting(hub, cardService, config.cards);
  app.route('/', cardRoutes(cardService));

  mountLaterRoutes(app);
  mountSpa(app, deps.webDist, log);

  function start(server: Server, loops: ComposeLoops = DEFAULT_LOOPS): Running {
    const ws = loops.createWsHub(server);
    const watcher = loops.startBlockWatcher(chain, hub, {
      onError: createThrottledLogger(log, WATCHER_ERROR_LOG_MS),
    });
    const poller = loops.startPoller({
      chain,
      hub,
      ws,
      stats,
      arena: config.arena,
      cards: config.cards,
      operator: deps.operatorQueue,
      settleGas: BigInt(config.gasLimits.settle),
      bots: () => readBots(config.dataDir),
      getAgentMessage,
    });
    log(
      `[server] Monicard API on port ${config.port} (deployment ${config.deployment}, chain ${config.chainId}), ` +
        `fund ${config.fundEnabled ? 'enabled' : 'disabled'}, loops: ws, watcher, poller`,
    );

    return {
      async stop() {
        attempt('watcher', log, () => watcher.stop());
        attempt('poller', log, () => poller.stop());
        attempt('ws', log, () => ws.close());
        await closeServer(server, log);
      },
    };
  }

  return { app, hub, stats, getAgentMessage, start };
}
