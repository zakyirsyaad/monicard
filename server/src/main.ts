import type { Server } from 'node:http';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { nadCardsAbi } from '@nad/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { loadBots } from '../scripts/setup-bots';
import { createAccountReader } from './account';
import { createChain } from './chain';
import { composeApp, createThrottledLogger, describeError, type Running } from './compose';
import { env } from './env';
import { createWalletQueue } from './walletQueue';

const SHUTDOWN_FORCE_MS = 5_000;
const REJECTION_LOG_MS = 10_000;

const log = (line: string): void => console.log(line);

async function buildComposed() {
  const chain = createChain(env.RPC_URLS, env.chainId);
  // Read once: the price is immutable in NadCards, and relay validation needs it at boot.
  const [pullPrice, gasPriceWei] = await Promise.all([
    chain.call((client) =>
      client.readContract({ address: env.cards, abi: nadCardsAbi, functionName: 'PULL_PRICE' }),
    ),
    chain.getGasPrice(),
  ]);
  const agentAccount = privateKeyToAccount(env.AGENT_KEY);
  // One queue per key: /agent/challenge and the Card Battle runner share this agent nonce.
  const agentQueue = createWalletQueue(agentAccount, chain);

  return composeApp({
    config: {
      port: env.PORT,
      deployment: env.DEPLOYMENT,
      chainId: env.chainId,
      cards: env.cards,
      arena: env.arena,
      stakeVault: env.stakeVault,
      battle: env.battle,
      battleStakeVault: env.battleStakeVault,
      gasLimits: env.gasLimits,
      batchMs: env.BATCH_MS,
      event: { name: env.EVENT_NAME, sponsor: env.EVENT_SPONSOR ?? null },
      dataDir: env.DATA_DIR,
      publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT}`,
      fundEnabled: env.FUND_ENABLED,
      fundBudgetMon: env.FUND_BUDGET_MON,
    },
    chain,
    agent: agentAccount.address,
    pullPrice,
    adminToken: env.ADMIN_TOKEN,
    masterQueue: createWalletQueue(privateKeyToAccount(env.MASTER_KEY), chain),
    operatorQueue: createWalletQueue(privateKeyToAccount(env.OPERATOR_KEY), chain),
    agentQueue,
    botKeys: loadBots(join(env.DATA_DIR, 'bots.json')),
    gasPriceWei,
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
  // describeError keeps viem's RPC URL out of the fatal line.
  console.error('[server] fatal:', describeError(error));
  process.exit(1);
});
