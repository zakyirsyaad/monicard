import { Hono } from 'hono';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEther, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { emptyAgentData, type AgentData, type Lesson } from '../src/agent/policy';
import { isAuthorized, type AdminDeps, type WalletAddresses } from '../src/admin';
import { adminRoutes } from '../src/adminRoutes';

const TEST_TOKEN = 'test-admin-token';

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;

const WALLETS: WalletAddresses = { master: addr(1), operator: addr(2), agent: addr(3), bots: [addr(4), addr(5)] };

const lesson = (at: number, duelId: string): Lesson => ({
  at,
  duelId,
  text: `lesson ${duelId}`,
  thresholdFrom: 30,
  thresholdTo: 33,
});

const liveData = (): AgentData => ({
  ...emptyAgentData(),
  sim: { duels: 1, wins: 0 },
  testnet: { duels: 2, wins: 1 },
});

const trainedData = (): AgentData => ({
  policy: { skillHpThreshold: 55, finisher: true },
  lessons: [lesson(1000, '9')],
  opponents: {},
  sim: { duels: 5, wins: 3 },
  testnet: { duels: 0, wins: 0 },
});

type Harness = {
  deps: AdminDeps;
  app: Hono;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  running: ReturnType<typeof vi.fn>;
  setFundEnabled: ReturnType<typeof vi.fn>;
  setFeatured: ReturnType<typeof vi.fn>;
  reserveAgent: ReturnType<typeof vi.fn>;
  onAgentChanged: ReturnType<typeof vi.fn>;
  store: { get(): AgentData; update(fn: (d: AgentData) => AgentData): AgentData };
};

function makeHarness(overrides: Partial<AdminDeps> = {}): Harness {
  let live = liveData();
  const store = {
    get: (): AgentData => live,
    update(fn: (d: AgentData) => AgentData): AgentData {
      live = fn(live);
      return live;
    },
  };
  const start = vi.fn(async (_pairs: number, _rounds: number) => undefined);
  const stop = vi.fn();
  const running = vi.fn(() => 0);
  const setFundEnabled = vi.fn();
  const setFeatured = vi.fn();
  const reserveAgent = vi.fn();
  const onAgentChanged = vi.fn();

  const deps: AdminDeps = {
    token: TEST_TOKEN,
    swarm: { start, stop, running },
    setFundEnabled,
    setFeatured,
    reserveAgent,
    agentStore: store,
    trainPath: join(trainDir, 'agent.train.json'),
    onAgentChanged,
    wallets: WALLETS,
    balanceOf: async () => 0n,
    log: () => undefined,
    ...overrides,
  };

  const app = new Hono();
  app.route('/admin', adminRoutes(deps));
  return { deps, app, start, stop, running, setFundEnabled, setFeatured, reserveAgent, onAgentChanged, store };
}

let trainDir: string;

beforeEach(() => {
  trainDir = mkdtempSync(join(tmpdir(), 'admin-test-'));
});

afterEach(() => {
  rmSync(trainDir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const post = (
  app: Hono,
  path: string,
  body?: unknown,
  opts: { token?: string | null; raw?: string } = {},
) => {
  const token = opts.token === undefined ? TEST_TOKEN : opts.token;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['x-admin-token'] = token;
  const payload = opts.raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return app.request(`/admin${path}`, { method: 'POST', headers, body: payload });
};

const get = (app: Hono, path: string, token: string | null = TEST_TOKEN) => {
  const headers: Record<string, string> = {};
  if (token !== null) headers['x-admin-token'] = token;
  return app.request(`/admin${path}`, { headers });
};

describe('isAuthorized', () => {
  test('accepts only an exact token and never an empty configured token', () => {
    expect(isAuthorized('secret', 'secret')).toBe(true);
    expect(isAuthorized('secreT', 'secret')).toBe(false);
    expect(isAuthorized('secret ', 'secret')).toBe(false);
    expect(isAuthorized(undefined, 'secret')).toBe(false);
    expect(isAuthorized('', '')).toBe(false);
    expect(isAuthorized(undefined, '')).toBe(false);
  });
});

describe('adminRoutes auth', () => {
  test('admin routes reject missing or wrong token', async () => {
    const h = makeHarness();

    const missing = await post(h.app, '/swarm', { pairs: 1, rounds: 1 }, { token: null });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ reason: 'unauthorized' });

    expect((await post(h.app, '/swarm', { pairs: 1, rounds: 1 }, { token: 'wrong' })).status).toBe(401);
    expect((await get(h.app, '/wallets', null)).status).toBe(401);
    expect(h.start).not.toHaveBeenCalled();

    const empty = makeHarness({ token: '' });
    expect((await get(empty.app, '/wallets', '')).status).toBe(401);
    expect((await get(empty.app, '/wallets', null)).status).toBe(401);
  });
});

describe('adminRoutes swarm', () => {
  test('POST /swarm validates body, starts swarm, 409 when running', async () => {
    const h = makeHarness();
    const gate = deferred();
    h.start.mockImplementation(() => gate.promise);

    const invalidBodies: unknown[] = [
      undefined,
      {},
      { pairs: 1 },
      { pairs: 0, rounds: 1 },
      { pairs: 51, rounds: 1 },
      { pairs: 1, rounds: 0 },
      { pairs: 1, rounds: 101 },
      { pairs: 1.5, rounds: 1 },
      { pairs: '2', rounds: 2 },
      { pairs: 2, rounds: null },
    ];
    for (const body of invalidBodies) {
      const res = await post(h.app, '/swarm', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ reason: 'bad_request' });
    }
    const invalidJson = await post(h.app, '/swarm', undefined, { raw: 'not json' });
    expect(invalidJson.status).toBe(400);
    expect(h.start).not.toHaveBeenCalled();

    const ok = await post(h.app, '/swarm', { pairs: 2, rounds: 3 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(h.start).toHaveBeenCalledWith(2, 3);
    gate.resolve();

    h.running.mockReturnValue(1);
    const conflict = await post(h.app, '/swarm', { pairs: 1, rounds: 1 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ reason: 'running' });
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  test('a failed swarm start is logged, not returned', async () => {
    const log = vi.fn();
    const h = makeHarness({ log });
    h.start.mockRejectedValue(new Error('boom'));

    const res = await post(h.app, '/swarm', { pairs: 1, rounds: 1 });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toHaveBeenCalled();
  });
});

describe('adminRoutes controls', () => {
  test('fund, featured and agent reserve call their deps with parsed values', async () => {
    const h = makeHarness();

    expect(await (await post(h.app, '/fund', { enabled: true })).json()).toEqual({ ok: true, enabled: true });
    expect(h.setFundEnabled).toHaveBeenLastCalledWith(true);
    expect(await (await post(h.app, '/fund', { enabled: false })).json()).toEqual({ ok: true, enabled: false });
    expect(h.setFundEnabled).toHaveBeenLastCalledWith(false);

    expect(await (await post(h.app, '/featured', { duelId: '12' })).json()).toEqual({ ok: true });
    expect(h.setFeatured).toHaveBeenLastCalledWith('12');
    await post(h.app, '/featured', { duelId: null });
    expect(h.setFeatured).toHaveBeenLastCalledWith(null);

    const upper = '0x' + 'AB'.repeat(20);
    await post(h.app, '/agent/reserve', { p1: upper });
    expect(h.reserveAgent).toHaveBeenLastCalledWith(upper.toLowerCase());
    await post(h.app, '/agent/reserve', { p1: null });
    expect(h.reserveAgent).toHaveBeenLastCalledWith(null);

    expect(await (await post(h.app, '/swarm/stop')).json()).toEqual({ ok: true });
    expect(h.stop).toHaveBeenCalledTimes(1);

    const invalid: Array<[string, unknown]> = [
      ['/fund', {}],
      ['/fund', { enabled: 'yes' }],
      ['/featured', { duelId: 'x' }],
      ['/featured', { duelId: 5 }],
      ['/agent/reserve', { p1: '0x123' }],
      ['/agent/reserve', { p1: 5 }],
    ];
    for (const [path, body] of invalid) {
      expect((await post(h.app, path, body)).status).toBe(400);
    }
    expect(h.setFundEnabled).toHaveBeenCalledTimes(2);
    expect(h.setFeatured).toHaveBeenCalledTimes(2);
    expect(h.reserveAgent).toHaveBeenCalledTimes(2);
  });

  test('unknown routes and wrong methods fall through to the Hono 404', async () => {
    const h = makeHarness();
    expect((await post(h.app, '/nope')).status).toBe(404);
    expect((await get(h.app, '/swarm')).status).toBe(404);
  });
});

describe('adminRoutes merge-train', () => {
  test('merges trained data, keeps live testnet stats, renames the file; second call is 404', async () => {
    const h = makeHarness();
    writeFileSync(h.deps.trainPath, JSON.stringify(trainedData()));

    const res = await post(h.app, '/agent/merge-train');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      policy: { skillHpThreshold: 55, finisher: true },
      sim: { duels: 6, wins: 3 },
    });

    const merged = h.store.get();
    expect(merged.policy).toEqual({ skillHpThreshold: 55, finisher: true });
    expect(merged.sim).toEqual({ duels: 6, wins: 3 });
    expect(merged.testnet).toEqual({ duels: 2, wins: 1 });
    expect(merged.lessons).toEqual([lesson(1000, '9')]);
    expect(h.onAgentChanged).toHaveBeenCalledTimes(1);

    expect(() => readFileSync(h.deps.trainPath, 'utf8')).toThrow();
    expect(readdirSync(trainDir).some((f) => f.startsWith('agent.train.json.merged-'))).toBe(true);

    const again = await post(h.app, '/agent/merge-train');
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ reason: 'no_training' });
    expect(h.store.get().sim).toEqual({ duels: 6, wins: 3 });
    expect(h.onAgentChanged).toHaveBeenCalledTimes(1);
  });

  test('merge-train rejects an invalid training file with 400 and keeps the file', async () => {
    const h = makeHarness();
    const invalid: string[] = [
      '{not json',
      JSON.stringify({ policy: { skillHpThreshold: 'high', finisher: true }, lessons: [], opponents: {}, sim: { duels: 0, wins: 0 }, testnet: { duels: 0, wins: 0 } }),
      JSON.stringify({}),
    ];

    for (const raw of invalid) {
      writeFileSync(h.deps.trainPath, raw);
      const res = await post(h.app, '/agent/merge-train');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ reason: 'invalid_training' });
    }

    expect(h.store.get()).toEqual(liveData());
    expect(h.onAgentChanged).not.toHaveBeenCalled();
    expect(readFileSync(h.deps.trainPath, 'utf8')).toBe(invalid[invalid.length - 1]);
  });
});

describe('adminRoutes wallets', () => {
  test('GET /wallets returns MON-formatted balances', async () => {
    const balances = new Map<Hex, bigint>([
      [WALLETS.master, parseEther('1.5')],
      [WALLETS.operator, parseEther('0.25')],
      [WALLETS.agent, 0n],
      [WALLETS.bots[0]!, parseEther('2')],
      [WALLETS.bots[1]!, 1n],
    ]);
    const h = makeHarness({ balanceOf: async (address) => balances.get(address) ?? 0n });

    const res = await get(h.app, '/wallets');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      master: { address: WALLETS.master, balance: '1.5' },
      operator: { address: WALLETS.operator, balance: '0.25' },
      agent: { address: WALLETS.agent, balance: '0' },
      bots: [
        { address: WALLETS.bots[0], balance: '2' },
        { address: WALLETS.bots[1], balance: '0.000000000000000001' },
      ],
    });
  });

  test('GET /wallets maps a balance read failure to 502', async () => {
    const log = vi.fn();
    const h = makeHarness({
      log,
      balanceOf: async () => {
        throw new Error('rpc down');
      },
    });

    const res = await get(h.app, '/wallets');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ reason: 'rpc' });
    expect(log).toHaveBeenCalled();
  });
});
