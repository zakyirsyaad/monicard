import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AccountReader } from '../src/account';
import type { CardData } from '../src/cards/lore';
import {
  composeApp,
  createThrottledLogger,
  type ComposeDeps,
  type ComposeLoops,
} from '../src/compose';
import type { PollerDeps } from '../src/poller';

const CARDS = '0x7af33cb3823ff99d37411a678452a7980d14cf9f' as Hex;
const ARENA = '0xc08c323df6a5f9fabaF75A6060E4CA357F2251f9' as Hex;
const VAULT = '0x642C1364b62344128087549ceeD9268D5E3385df' as Hex;
const AGENT = '0x3333333333333333333333333333333333333333' as Hex;
const BOT = '0x6666666666666666666666666666666666666666' as Hex;
const VALID_ADDRESS = '0x4444444444444444444444444444444444444444';
const INDEX_HTML = '<!doctype html><html><body>spa-index</body></html>';
const GAS_LIMITS = {
  freePull: 189_000,
  paidPull: 189_000,
  createDuel: 122_000,
  joinDuel: 137_000,
  attack: 62_000,
  settle: 107_000,
};

let root: string;
let dataDir: string;
let distWithIndex: string;
let distMissing: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nadgacha-compose-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'bots.json'), JSON.stringify([BOT]));
  distWithIndex = join(root, 'dist');
  mkdirSync(join(distWithIndex, 'assets'), { recursive: true });
  writeFileSync(join(distWithIndex, 'index.html'), INDEX_HTML);
  writeFileSync(join(distWithIndex, 'assets', 'app.js'), 'console.log("asset")');
  distMissing = join(root, 'no-dist-here');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const card1: CardData = { id: 1, atk: 20, hp: 100, element: 0, rarity: 0, wins: 0, losses: 0, mintedAt: 5 };

function fakeQueue(address: Hex) {
  return { address, send: vi.fn(async () => '0x01' as Hex), resyncNonce: vi.fn(async () => {}) };
}

function makeDeps(overrides: Partial<ComposeDeps> = {}): ComposeDeps {
  const client = {} as never;
  const accounts: AccountReader = {
    read: async () => ({ nonce: 0, balance: 0n, cardId: null, hasPulled: false }),
  } as unknown as AccountReader;
  return {
    config: {
      port: 18080,
      deployment: 'testnet',
      chainId: 10143,
      cards: CARDS,
      arena: ARENA,
      gasLimits: GAS_LIMITS,
      batchMs: 1000,
      event: { name: 'Monad Blitz Jogja Vol. 2', sponsor: null },
      dataDir,
      publicUrl: 'http://localhost:18080',
      fundEnabled: false,
      fundBudgetMon: 3,
    },
    chain: {
      chainId: 10143,
      client,
      call: async (fn) => fn(client),
      getGasPrice: async () => 1_000_000_000n,
    },
    agent: AGENT,
    pullPrice: 50_000_000_000_000_000n,
    masterQueue: fakeQueue('0x7777777777777777777777777777777777777777'),
    operatorQueue: fakeQueue('0x8888888888888888888888888888888888888888'),
    accounts,
    webDist: distWithIndex,
    readCard: async (id) => (id === 1 ? card1 : null),
    log: () => {},
    ...overrides,
  };
}

const postJson = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('composeApp HTTP surface', () => {
  test('GET /config returns the public config', async () => {
    const { app } = composeApp(makeDeps());
    const res = await app.request('/config');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.contracts).toEqual({ cards: CARDS, arena: ARENA });
    expect(json.gasLimits).toEqual(GAS_LIMITS);
    expect(json.pullPrice).toBe('50000000000000000');
    expect(json.agent).toBe(AGENT);
    expect(json.bots).toEqual([BOT]);
  });

  test('GET /config exposes the StakeVault and gas limits from the deployment config', async () => {
    const base = makeDeps();
    const deps: ComposeDeps = {
      ...base,
      config: {
        ...base.config,
        stakeVault: VAULT,
        gasLimits: { ...base.config.gasLimits, stake: 131_000, claim: 154_000 },
      },
    };

    const { app } = composeApp(deps);
    const res = await app.request('/config');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { contracts: Record<string, unknown>; gasLimits: Record<string, number> };
    expect(json.contracts).toEqual({ cards: CARDS, arena: ARENA, stakeVault: VAULT });
    expect(json.gasLimits.stake).toBe(131_000);
    expect(json.gasLimits.claim).toBe(154_000);
  });

  test('POST /relay with an invalid body is a 400 from the relay route', async () => {
    const { app } = composeApp(makeDeps());
    const res = await app.request(postJson('/relay', {}));
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('POST /fund with an invalid body is a 400 JSON', async () => {
    const { app } = composeApp(makeDeps());
    const res = await app.request(postJson('/fund', { address: 'nope' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ funded: false, reason: 'address' });
  });

  test('POST /fund reports disabled when FUND_ENABLED is false', async () => {
    const { app } = composeApp(makeDeps());
    const res = await app.request(postJson('/fund', { address: VALID_ADDRESS }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ funded: false, reason: 'disabled' });
  });

  test('GET /card/1 is served by the card routes, never the SPA', async () => {
    const { app } = composeApp(makeDeps());
    const res = await app.request('/card/1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const missing = await app.request('/card/2');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ reason: 'not_found' });
  });

  test('GET /card/1/image.svg is served as an svg', async () => {
    const { app } = composeApp(makeDeps());
    const res = await app.request('/card/1/image.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
  });
});

describe('composeApp SPA fallback', () => {
  test('unknown API paths return a JSON 404 even when the SPA exists', async () => {
    const { app } = composeApp(makeDeps());
    for (const path of ['/relay/xyz', '/agent/none', '/admin/none', '/relay']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ reason: 'not_found' });
    }
  });

  test('unknown non-API paths return index.html when web/dist exists', async () => {
    const { app } = composeApp(makeDeps());
    for (const path of ['/duel/5', '/play', '/pull', '/arena', '/dev']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(INDEX_HTML);
    }
  });

  test('static assets are served from web/dist', async () => {
    const { app } = composeApp(makeDeps());
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('asset');
  });

  test('without web/dist the app is API-only: plain 404 for pages, JSON 404 for API paths, warning logged', async () => {
    const log = vi.fn();
    const { app } = composeApp(makeDeps({ webDist: distMissing, log }));
    const page = await app.request('/play');
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).not.toContain('text/html');
    const api = await app.request('/agent/none');
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ reason: 'not_found' });
    expect((await app.request('/config')).status).toBe(200);
    expect(log.mock.calls.flat().join(' ')).toContain('serving API only');
  });

  test('POST to an unknown non-API path is not answered with the SPA', async () => {
    const { app } = composeApp(makeDeps());
    const res = await app.request(postJson('/play', {}));
    expect(res.status).toBe(404);
  });
});

describe('composeApp start', () => {
  function fakeLoops() {
    const watcher = { latestBlock: () => 0n, lag: () => 0n, stop: vi.fn() };
    const poller = { stop: vi.fn() } as unknown as ReturnType<ComposeLoops['startPoller']>;
    const ws = { broadcast: vi.fn(), onConnect: vi.fn(), subscribedIds: () => new Set<string>(), close: vi.fn() };
    let watcherArgs: Parameters<ComposeLoops['startBlockWatcher']> | undefined;
    let pollerDeps: PollerDeps | undefined;
    const loops: ComposeLoops = {
      createWsHub: vi.fn(() => ws),
      startBlockWatcher: vi.fn((...args: Parameters<ComposeLoops['startBlockWatcher']>) => {
        watcherArgs = args;
        return watcher;
      }),
      startPoller: vi.fn((d: PollerDeps) => {
        pollerDeps = d;
        return poller;
      }),
    };
    return {
      loops,
      watcher,
      poller,
      ws,
      getWatcherArgs: () => watcherArgs!,
      getPollerDeps: () => pollerDeps!,
    };
  }

  const fakeServer = () => ({ close: vi.fn((cb?: (err?: Error) => void) => cb?.()) }) as unknown as Server;

  test('getAgentMessage is null by default and is what the poller receives', () => {
    const f = fakeLoops();
    const deps = makeDeps();
    const composed = composeApp(deps);
    expect(composed.getAgentMessage()).toBeNull();
    composed.start(fakeServer(), f.loops);
    const pd = f.getPollerDeps();
    expect(pd.getAgentMessage).toBe(composed.getAgentMessage);
    expect(pd.getAgentMessage()).toBeNull();
    expect(pd.chain).toBe(deps.chain);
    expect(pd.hub).toBe(composed.hub);
    expect(pd.stats).toBe(composed.stats);
    expect(pd.operator).toBe(deps.operatorQueue);
    expect(pd.settleGas).toBe(BigInt(GAS_LIMITS.settle));
    expect(pd.arena).toBe(ARENA);
    expect(pd.cards).toBe(CARDS);
    expect(pd.bots()).toEqual([BOT]);
    expect(pd.ws).toBe(f.ws);
  });

  test('start wires the block watcher to the receipt hub and logs its errors', () => {
    const f = fakeLoops();
    const log = vi.fn();
    const deps = makeDeps({ log });
    const composed = composeApp(deps);
    const server = fakeServer();
    // Frozen clock: both errors below arrive at the same instant, so any outer throttle would drop one.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      composed.start(server, f.loops);
      expect(f.loops.createWsHub).toHaveBeenCalledWith(server);
      const [chainArg, hubArg, opts] = f.getWatcherArgs();
      expect(chainArg).toBe(deps.chain);
      expect(hubArg).toBe(composed.hub);
      // The watcher throttles its own reports (and appends a suppressed count), so composeApp
      // must not add a second throttle that would swallow them.
      expect(() => opts.onError(new Error('rpc exploded'))).not.toThrow();
      expect(() => opts.onError(new Error('block 7 stuck for over 10000 ms'))).not.toThrow();
    } finally {
      nowSpy.mockRestore();
    }
    const lines = log.mock.calls.flat();
    expect(lines.filter((line) => line.includes('rpc exploded'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('block 7 stuck'))).toHaveLength(1);
  });

  test('stop shuts down watcher, poller, ws and the http server', async () => {
    const f = fakeLoops();
    const server = fakeServer();
    const running = composeApp(makeDeps()).start(server, f.loops);
    await running.stop();
    expect(f.watcher.stop).toHaveBeenCalledOnce();
    expect(f.poller.stop).toHaveBeenCalledOnce();
    expect(f.ws.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  test('stop resolves even if a component throws', async () => {
    const f = fakeLoops();
    f.watcher.stop.mockImplementation(() => {
      throw new Error('boom');
    });
    const log = vi.fn();
    const running = composeApp(makeDeps({ log })).start(fakeServer(), f.loops);
    await expect(running.stop()).resolves.toBeUndefined();
    expect(f.ws.close).toHaveBeenCalledOnce();
  });

  test('start logs which loops started and never the key material', () => {
    const f = fakeLoops();
    const log = vi.fn();
    composeApp(makeDeps({ log })).start(fakeServer(), f.loops);
    const text = log.mock.calls.flat().join('\n');
    expect(text).toContain('18080');
    expect(text).toContain('testnet');
    expect(text).toContain('10143');
    expect(text).toContain('watcher');
    expect(text).toContain('poller');
    expect(text).toContain('fund disabled');
  });
});

describe('createThrottledLogger', () => {
  test('logs the first error, suppresses within the window, then logs again', () => {
    let t = 0;
    const sink = vi.fn();
    const log = createThrottledLogger(sink, 1_000, () => t);
    log('a');
    t = 500;
    log('b');
    t = 1_500;
    log('c');
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0]?.[0]).toContain('a');
    expect(sink.mock.calls[1]?.[0]).toContain('c');
  });
});
