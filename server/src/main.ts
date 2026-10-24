import type { Server } from 'node:http';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { nadCardsAbi } from '@nad/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { createAccountReader } from './account';
import { createChain } from './chain';
import { composeApp, createThrottledLogger, type Running } from './compose';
import { env } from './env';
import { createWalletQueue } from './walletQueue';

const SHUTDOWN_FORCE_MS = 5_000;
const REJECTION_LOG_MS = 10_000;

const log = (line: string): void => console.log(line);

async function buildComposed() {
  const chain = createChain(env.RPC_URLS, env.chainId);
  // Read once: the price is immutable in NadCards, and relay validation needs it at boot.
  const pullPrice = await chain.call((client) =>
    client.readContract({ address: env.cards, abi: nadCardsAbi, functionName: 'PULL_PRICE' }),
  );

  return composeApp({
    config: {
      port: env.PORT,
      deployment: env.DEPLOYMENT,
      chainId: env.chainId,
      cards: env.cards,
      arena: env.arena,
      gasLimits: env.gasLimits,
      batchMs: env.BATCH_MS,
      event: { name: env.EVENT_NAME, sponsor: env.EVENT_SPONSOR ?? null },
      dataDir: env.DATA_DIR,
      publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT}`,
      fundEnabled: env.FUND_ENABLED,
      fundBudgetMon: env.FUND_BUDGET_MON,
    },
    chain,
    agent: privateKeyToAccount(env.AGENT_KEY).address,
    pullPrice,
    masterQueue: createWalletQueue(privateKeyToAccount(env.MASTER_KEY), chain),
    operatorQueue: createWalletQueue(privateKeyToAccount(env.OPERATOR_KEY), chain),
    accounts: createAccountReader({ chain, cards: env.cards }),
    webDist: join(env.ROOT, 'web', 'dist'),
    log,
  });
}

function installShutdown(running: Running): void {
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`[server] ${signal} received, shutting down`);
    setTimeout(() => process.exit(1), SHUTDOWN_FORCE_MS).unref();
    running.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  // A rejected promise in a background loop is logged (throttled), never fatal.
  process.on(
    'unhandledRejection',
    createThrottledLogger((line) => console.error(`${line} (unhandled rejection)`), REJECTION_LOG_MS),
  );

  const composed = await buildComposed();
  const server = serve({ fetch: composed.app.fetch, port: env.PORT });
  installShutdown(composed.start(server as Server));
}

main().catch((error: unknown) => {
  console.error('[server] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
