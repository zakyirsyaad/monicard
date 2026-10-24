import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { nadCardsAbi } from '@nad/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { createAccountReader } from './account';
import { buildApp, isApiPath } from './app';
import { createChain } from './chain';
import { env } from './env';

const chain = createChain(env.RPC_URLS, env.chainId);
const agent = privateKeyToAccount(env.AGENT_KEY).address;

// Read once: the price is immutable in NadCards, and relay validation needs it at boot.
const pullPrice = await chain.call((client) =>
  client.readContract({ address: env.cards, abi: nadCardsAbi, functionName: 'PULL_PRICE' }),
);

const app = buildApp({
  chainId: env.chainId,
  cards: env.cards,
  arena: env.arena,
  gasLimits: env.gasLimits,
  batchMs: env.BATCH_MS,
  pullPrice,
  event: { name: env.EVENT_NAME, sponsor: env.EVENT_SPONSOR ?? null },
  agent,
  dataDir: env.DATA_DIR,
  getGasPrice: chain.getGasPrice,
  accounts: createAccountReader({ chain, cards: env.cards }),
});

const webDist = join(env.ROOT, 'web', 'dist');
const indexPath = join(webDist, 'index.html');
if (existsSync(indexPath)) {
  const indexHtml = readFileSync(indexPath, 'utf8');
  // Assets first; unknown non-API paths are SPA routes such as /duel/:id.
  app.use('*', serveStatic({ root: webDist }));
  app.get('*', (c) => {
    if (isApiPath(c.req.path)) return c.json({ reason: 'not_found' }, 404);
    return c.html(indexHtml);
  });
} else {
  console.warn(`[server] ${indexPath} not found — serving API only`);
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[server] Monicard API on http://localhost:${info.port} (deployment ${env.DEPLOYMENT}, chain ${env.chainId})`);
});