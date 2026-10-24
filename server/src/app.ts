import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { isAddress, type Hex } from 'viem';
import type { AccountReader } from './account';

export type EventInfo = {
  name: string;
  sponsor: string | null;
};

export type AppDeps = {
  chainId: number;
  cards: Hex;
  arena: Hex;
  gasLimits: Record<string, number>;
  batchMs: number;
  pullPrice: bigint;
  event: EventInfo;
  agent: Hex;
  dataDir: string;
  getGasPrice(): Promise<bigint>;
  accounts: AccountReader;
  /** Test seam: replace the DATA_DIR/bots.json read. */
  readBots?: () => Hex[];
};

/** Prefixes owned by the API; anything else may fall through to the SPA. */
export const API_PREFIXES = [
  '/config',
  '/account',
  '/fund',
  '/relay',
  '/card',
  '/agent',
  '/admin',
  '/ws',
] as const;

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * SPA entry handler. Reads index.html on every request: a fresh `pnpm -F web build`
 * replaces both the file and its hashed asset names, so a boot-time copy goes stale.
 * A missing entry is a 404; an unreadable one is a 503 rather than a crash.
 */
export function spaFallback(indexPath: string): (c: Context) => Response {
  return (c) => {
    try {
      return c.html(readFileSync(indexPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ reason: 'not_found' }, 404);
      }
      console.error('[server] cannot read SPA index:', shortMessage(error));
      return c.json({ reason: 'unavailable' }, 503);
    }
  };
}

/** Bot addresses from DATA_DIR/bots.json; a missing or corrupt file is an empty list. */
export function readBots(dataDir: string): Hex[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dataDir, 'bots.json'), 'utf8'));
  } catch {
    return [];
  }

  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object' && Array.isArray((raw as { bots?: unknown }).bots)) {
    list = (raw as { bots: unknown[] }).bots;
  }

  const addresses: Hex[] = [];
  for (const entry of list) {
    const value =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as { address?: unknown }).address === 'string'
          ? (entry as { address: string }).address
          : null;
    if (value !== null && isAddress(value)) addresses.push(value);
  }
  return addresses;
}

function shortMessage(error: unknown): string {
  if (error instanceof Error) return (error as Error & { shortMessage?: string }).shortMessage ?? error.message;
  return String(error);
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  const bots = (): Hex[] => deps.readBots?.() ?? readBots(deps.dataDir);

  app.get('/config', async (c) => {
    try {
      const gasPrice = await deps.getGasPrice();
      return c.json({
        chainId: deps.chainId,
        contracts: { cards: deps.cards, arena: deps.arena },
        gasLimits: deps.gasLimits,
        gasPrice: gasPrice.toString(),
        batchMs: deps.batchMs,
        pullPrice: deps.pullPrice.toString(),
        event: { name: deps.event.name, sponsor: deps.event.sponsor },
        agent: deps.agent,
        bots: bots(),
      });
    } catch (error) {
      console.error('[app] /config failed:', shortMessage(error));
      return c.json({ reason: 'unavailable' }, 503);
    }
  });

  app.get('/account/:address', async (c) => {
    const address = c.req.param('address');
    if (!isAddress(address)) return c.json({ reason: 'invalid_address' }, 400);
    try {
      const view = await deps.accounts.read(address);
      return c.json({
        nonce: view.nonce,
        balance: view.balance.toString(),
        cardId: view.cardId === null ? null : view.cardId.toString(),
        hasPulled: view.hasPulled,
      });
    } catch (error) {
      console.error('[app] /account failed:', shortMessage(error));
      return c.json({ reason: 'unavailable' }, 503);
    }
  });

  app.onError((error, c) => {
    console.error('[app] unhandled error:', shortMessage(error));
    return c.json({ reason: 'internal' }, 500);
  });

  return app;
}