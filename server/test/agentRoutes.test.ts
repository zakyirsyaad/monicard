import { describe, expect, test, vi } from 'vitest';
import { createIpLimiter, handleChallenge, type ChallengeDeps } from '../src/agent/challenge';
import type { ChallengeResult } from '../src/agent/runner';
import { agentRoutes } from '../src/agent/routes';

const T0 = 1_700_000_000_000;
const IP = '5.6.7.8';
const TEN_MIN = 600_000;

function makeDeps(result: ChallengeResult = 'ok', now: () => number = () => T0): {
  deps: ChallengeDeps;
  challenge: ReturnType<typeof vi.fn>;
} {
  const challenge = vi.fn(async (_duelId: bigint) => result);
  return { deps: { runner: { challenge }, limiter: createIpLimiter({ now }) }, challenge };
}

const post = (app: ReturnType<typeof agentRoutes>, body: string, headers: Record<string, string> = {}) =>
  app.request('/challenge', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('createIpLimiter', () => {
  test('allows five requests per IP per window, then rejects', () => {
    const limiter = createIpLimiter({ now: () => T0 });
    for (let i = 0; i < 5; i += 1) expect(limiter.allow(IP)).toBe(true);
    expect(limiter.allow(IP)).toBe(false);
    expect(limiter.allow('9.9.9.9')).toBe(true);
  });

  test('resets after the ten minute window', () => {
    let at = T0;
    const limiter = createIpLimiter({ now: () => at });
    for (let i = 0; i < 5; i += 1) expect(limiter.allow(IP)).toBe(true);
    expect(limiter.allow(IP)).toBe(false);
    at += TEN_MIN + 1;
    expect(limiter.allow(IP)).toBe(true);
  });

  test('counts a sliding window rather than a fixed bucket', () => {
    let at = T0;
    const limiter = createIpLimiter({ now: () => at });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.allow(IP)).toBe(true);
      at += 1_000;
    }
    expect(limiter.allow(IP)).toBe(false);
    at = T0 + TEN_MIN + 1;
    expect(limiter.allow(IP)).toBe(true);
  });
});

describe('handleChallenge', () => {
  test('parses decimal string and safe integer duel ids', async () => {
    const { deps, challenge } = makeDeps();
    expect(await handleChallenge({ duelId: '7' }, IP, deps)).toEqual({ status: 200, json: { ok: true } });
    expect(challenge).toHaveBeenLastCalledWith(7n);
    expect(await handleChallenge({ duelId: 8 }, IP, deps)).toEqual({ status: 200, json: { ok: true } });
    expect(challenge).toHaveBeenLastCalledWith(8n);
  });

  test('400 bad_request for every malformed body, without consuming the limit', async () => {
    const { deps, challenge } = makeDeps();
    const bodies: unknown[] = [
      null,
      'not an object',
      {},
      { duelId: 'abc' },
      { duelId: '-1' },
      { duelId: -1 },
      { duelId: 1.5 },
      { duelId: true },
      { duelId: '1'.repeat(21) },
      { duelId: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const body of bodies) {
      expect(await handleChallenge(body, IP, deps)).toEqual({ status: 400, json: { reason: 'bad_request' } });
    }
    expect(challenge).not.toHaveBeenCalled();
    expect(await handleChallenge({ duelId: 1 }, IP, deps)).toEqual({ status: 200, json: { ok: true } });
  });

  test('maps each runner result to the frozen contract', async () => {
    expect(await handleChallenge({ duelId: 1 }, IP, makeDeps('ok').deps)).toEqual({ status: 200, json: { ok: true } });
    for (const reason of ['busy', 'reserved', 'not_open', 'stale'] as const) {
      const { deps } = makeDeps(reason);
      expect(await handleChallenge({ duelId: 1 }, IP, deps)).toEqual({ status: 409, json: { reason } });
    }
  });

  test('runner throw becomes 409 busy and is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const challenge = vi.fn(async () => {
      throw new Error('boom');
    });
    const deps: ChallengeDeps = { runner: { challenge }, limiter: createIpLimiter({ now: () => T0 }) };
    expect(await handleChallenge({ duelId: 1 }, IP, deps)).toEqual({ status: 409, json: { reason: 'busy' } });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('429 limit_ip after five valid requests from one IP, and the runner is not called again', async () => {
    const { deps, challenge } = makeDeps();
    for (let i = 0; i < 5; i += 1) {
      expect(await handleChallenge({ duelId: i }, IP, deps)).toEqual({ status: 200, json: { ok: true } });
    }
    expect(await handleChallenge({ duelId: 5 }, IP, deps)).toEqual({ status: 429, json: { reason: 'limit_ip' } });
    expect(challenge).toHaveBeenCalledTimes(5);
    expect(await handleChallenge({ duelId: 6 }, '9.9.9.9', deps)).toEqual({ status: 200, json: { ok: true } });
  });
});

describe('agentRoutes', () => {
  test('POST /challenge returns 200 ok', async () => {
    const { deps, challenge } = makeDeps();
    const app = agentRoutes(deps);
    const res = await post(app, JSON.stringify({ duelId: '12' }), { 'x-real-ip': IP });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(challenge).toHaveBeenCalledWith(12n);
  });

  test('400 on invalid JSON or a bad body', async () => {
    const app = agentRoutes(makeDeps().deps);
    for (const body of ['not json', '{}', JSON.stringify({ duelId: 'x' })]) {
      const res = await post(app, body, { 'x-real-ip': IP });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ reason: 'bad_request' });
    }
  });

  test('409 carries the reason', async () => {
    const app = agentRoutes(makeDeps('reserved').deps);
    const res = await post(app, JSON.stringify({ duelId: 3 }), { 'x-real-ip': IP });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: 'reserved' });
  });

  test('429 after five requests from one IP; another IP is still allowed', async () => {
    const app = agentRoutes(makeDeps().deps);
    for (let i = 0; i < 5; i += 1) {
      expect((await post(app, JSON.stringify({ duelId: i }), { 'x-real-ip': IP })).status).toBe(200);
    }
    const limited = await post(app, JSON.stringify({ duelId: 5 }), { 'x-real-ip': IP });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ reason: 'limit_ip' });
    expect((await post(app, JSON.stringify({ duelId: 6 }), { 'x-real-ip': '9.9.9.9' })).status).toBe(200);
  });

  test('the limit window resets after ten minutes', async () => {
    let at = T0;
    const app = agentRoutes(makeDeps('ok', () => at).deps);
    for (let i = 0; i < 5; i += 1) {
      expect((await post(app, JSON.stringify({ duelId: i }), { 'x-real-ip': IP })).status).toBe(200);
    }
    expect((await post(app, JSON.stringify({ duelId: 5 }), { 'x-real-ip': IP })).status).toBe(429);
    at += TEN_MIN + 1;
    expect((await post(app, JSON.stringify({ duelId: 6 }), { 'x-real-ip': IP })).status).toBe(200);
  });
});