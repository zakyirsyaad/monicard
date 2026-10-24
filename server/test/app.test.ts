import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { Hex, PublicClient } from 'viem';
import type { ChainLike } from '../src/chainTypes';
import { createAccountReader, type AccountReader } from '../src/account';
import { buildApp, isApiPath, readBots, spaFallback, type AppDeps } from '../src/app';

const CARDS = '0x7af33cb3823ff99d37411a678452a7980d14cf9f' as Hex;
const ARENA = '0xc08c323df6a5f9fabaF75A6060E4CA357F2251f9' as Hex;
const AGENT = '0x3333333333333333333333333333333333333333' as Hex;
const USER = '0x4444444444444444444444444444444444444444' as Hex;
const OTHER = '0x5555555555555555555555555555555555555555' as Hex;

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nadgacha-app-'));
});

afterEach(() => {
  rmSync(join(dataDir, 'bots.json'), { force: true });
  rmSync(join(dataDir, 'index.html'), { force: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    chainId: 10143,
    cards: CARDS,
    arena: ARENA,
    gasLimits: {
      freePull: 189_000,
      paidPull: 189_000,
      createDuel: 122_000,
      joinDuel: 137_000,
      attack: 62_000,
      settle: 107_000,
    },
    batchMs: 1000,
    pullPrice: 50_000_000_000_000_000n,
    event: { name: 'Monad Blitz Jogja Vol. 2', sponsor: null },
    agent: AGENT,
    dataDir,
    getGasPrice: async () => 102_000_000_000n,
    accounts: {
      read: async () => ({ nonce: 7, balance: 1_000_000_000_000_000_000n, cardId: null, hasPulled: true }),
    },
    ...overrides,
  };
}

describe('GET /config', () => {
  test('returns the frozen config shape', async () => {
    const res = await buildApp(deps()).request('/config');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chainId: 10143,
      contracts: { cards: CARDS, arena: ARENA },
      gasLimits: {
        freePull: 189_000,
        paidPull: 189_000,
        createDuel: 122_000,
        joinDuel: 137_000,
        attack: 62_000,
        settle: 107_000,
      },
      gasPrice: '102000000000',
      batchMs: 1000,
      pullPrice: '50000000000000000',
      event: { name: 'Monad Blitz Jogja Vol. 2', sponsor: null },
      agent: AGENT,
      bots: [],
    });
  });

  test('reads bot addresses from DATA_DIR/bots.json', async () => {
    writeFileSync(join(dataDir, 'bots.json'), JSON.stringify([USER, { address: OTHER }, 'not-an-address']));

    const body = (await (await buildApp(deps()).request('/config')).json()) as { bots: string[] };

    expect(body.bots).toEqual([USER, OTHER]);
  });

  test('returns an empty bot list for a missing or corrupt file', async () => {
    const missing = (await (await buildApp(deps()).request('/config')).json()) as { bots: string[] };
    expect(missing.bots).toEqual([]);

    writeFileSync(join(dataDir, 'bots.json'), '{not json');
    const corrupt = (await (await buildApp(deps()).request('/config')).json()) as { bots: string[] };
    expect(corrupt.bots).toEqual([]);
  });

  test('returns 503 when the gas price cannot be read', async () => {
    const app = buildApp(
      deps({
        getGasPrice: async () => {
          throw new Error('rpc down');
        },
      }),
    );

    expect((await app.request('/config')).status).toBe(503);
  });
});

describe('GET /account/:address', () => {
  test('returns nonce, balance, cardId and hasPulled', async () => {
    const accounts: AccountReader = {
      read: async () => ({ nonce: 9, balance: 12_345n, cardId: 5n, hasPulled: true }),
    };
    const res = await buildApp(deps({ accounts })).request(`/account/${USER}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nonce: 9, balance: '12345', cardId: '5', hasPulled: true });
  });

  test('returns cardId null when the reader reports no owned card', async () => {
    const accounts: AccountReader = {
      read: async () => ({ nonce: 0, balance: 0n, cardId: null, hasPulled: false }),
    };
    const body = (await (await buildApp(deps({ accounts })).request(`/account/${USER}`)).json()) as {
      cardId: string | null;
      hasPulled: boolean;
    };

    expect(body.cardId).toBeNull();
    expect(body.hasPulled).toBe(false);
  });

  test('rejects an invalid address with 400', async () => {
    const res = await buildApp(deps()).request('/account/not-an-address');
    expect(res.status).toBe(400);
  });

  test('returns 503 when the chain read fails', async () => {
    const accounts: AccountReader = {
      read: async () => {
        throw new Error('rpc down');
      },
    };
    expect((await buildApp(deps({ accounts })).request(`/account/${USER}`)).status).toBe(503);
  });
});

type ReaderOptions = {
  cardOf: bigint;
  hasPulled: boolean;
  owner?: Hex;
  nonce?: number;
  balance?: bigint;
};

function fakeReaderChain(opts: ReaderOptions): { chain: ChainLike; calls: () => number; ownerCalls: () => number } {
  let calls = 0;
  let ownerCalls = 0;
  const client = {
    getTransactionCount: async () => {
      calls += 1;
      return opts.nonce ?? 3;
    },
    getBalance: async () => opts.balance ?? 1n,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'cardOf') return opts.cardOf;
      if (functionName === 'hasPulled') return opts.hasPulled;
      if (functionName === 'ownerOf') {
        ownerCalls += 1;
        return opts.owner;
      }
      throw new Error(`unexpected function ${functionName}`);
    },
  } as unknown as PublicClient;

  return {
    chain: { client, call: async (fn) => fn(client) },
    calls: () => calls,
    ownerCalls: () => ownerCalls,
  };
}

describe('createAccountReader', () => {
  test('returns cardId only while the address still owns the card', async () => {
    const { chain } = fakeReaderChain({ cardOf: 5n, hasPulled: true, owner: OTHER });
    const view = await createAccountReader({ chain, cards: CARDS }).read(USER);

    expect(view).toMatchObject({ nonce: 3, balance: 1n, cardId: null, hasPulled: true });
  });

  test('returns the card id when ownerOf matches', async () => {
    const { chain } = fakeReaderChain({ cardOf: 5n, hasPulled: true, owner: USER });
    const view = await createAccountReader({ chain, cards: CARDS }).read(USER);

    expect(view.cardId).toBe(5n);
  });

  test('skips ownerOf when the address has never pulled', async () => {
    const { chain, ownerCalls } = fakeReaderChain({ cardOf: 0n, hasPulled: false });
    const view = await createAccountReader({ chain, cards: CARDS }).read(USER);

    expect(view.cardId).toBeNull();
    expect(ownerCalls()).toBe(0);
  });

  test('caches the view for one second', async () => {
    const { chain, calls } = fakeReaderChain({ cardOf: 0n, hasPulled: false });
    let now = 0;
    const reader = createAccountReader({ chain, cards: CARDS, now: () => now });

    await reader.read(USER);
    now = 500;
    await reader.read(USER);
    expect(calls()).toBe(1);

    now = 1001;
    await reader.read(USER);
    expect(calls()).toBe(2);
  });
});

describe('readBots', () => {
  test('accepts an object with a bots array and rejects junk entries', () => {
    writeFileSync(join(dataDir, 'bots.json'), JSON.stringify({ bots: [USER, 42, null] }));

    expect(readBots(dataDir)).toEqual([USER]);
  });
});

describe('spaFallback', () => {
  test('reads index.html per request so a fresh build is served', async () => {
    const indexPath = join(dataDir, 'index.html');
    writeFileSync(indexPath, '<html>old-build</html>');
    const app = new Hono();
    app.get('*', spaFallback(indexPath));

    const first = await app.request('/duel/3');
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('old-build');

    writeFileSync(indexPath, '<html>new-build</html>');
    const second = await app.request('/duel/3');
    expect(second.status).toBe(200);
    const body = await second.text();
    expect(body).toContain('new-build');
    expect(body).not.toContain('old-build');
  });

  test('returns 404 when index.html is missing', async () => {
    const app = new Hono();
    app.get('*', spaFallback(join(dataDir, 'missing.html')));

    const res = await app.request('/duel/3');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ reason: 'not_found' });
  });
});

describe('isApiPath', () => {
  test('matches API prefixes at a path boundary', () => {
    expect(isApiPath('/config')).toBe(true);
    expect(isApiPath('/account/0xabc')).toBe(true);
    expect(isApiPath('/admin')).toBe(true);
    expect(isApiPath('/admin/status')).toBe(true);
    expect(isApiPath('/ws')).toBe(true);
    expect(isApiPath('/administrator')).toBe(false);
    expect(isApiPath('/duel/3')).toBe(false);
    expect(isApiPath('/')).toBe(false);
  });
});