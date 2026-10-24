import { describe, expect, test, vi } from 'vitest';
import { createBattleLimiter, handleBattle, parseMatchId, battleRoutes, type BattleDeps } from '../src/agent/battleRoutes';
import type { BattleResult } from '../src/agent/battleRunner';

const T0 = 1_700_000_000_000;
const IP = '5.6.7.8';

function makeDeps(result: BattleResult = 'ok'): { deps: BattleDeps; battle: ReturnType<typeof vi.fn> } {
  const battle = vi.fn(async (_matchId: bigint) => result);
  return { deps: { runner: { battle }, limiter: createBattleLimiter() }, battle };
}

const post = (app: ReturnType<typeof battleRoutes>, body: string, headers: Record<string, string> = {}) =>
  app.request('/battle', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('parseMatchId', () => {
  test('accepts decimal strings and safe non-negative integers', () => {
    expect(parseMatchId({ matchId: '7' })).toBe(7n);
    expect(parseMatchId({ matchId: 8 })).toBe(8n);
    expect(parseMatchId({ matchId: 0 })).toBe(0n);
  });

  test('rejects malformed bodies', () => {
    for (const body of [null, 'x', {}, { matchId: 'abc' }, { matchId: '-1' }, { matchId: 1.5 }, { matchId: true }, { matchId: '1'.repeat(21) }]) {
      expect(parseMatchId(body)).toBeNull();
    }
  });
});

describe('handleBattle', () => {
  test('200 ok and forwards the parsed id', async () => {
    const { deps, battle } = makeDeps();
    expect(await handleBattle({ matchId: '12' }, IP, deps)).toEqual({ status: 200, json: { ok: true } });
    expect(battle).toHaveBeenCalledWith(12n);
  });

  test('400 bad_request without consuming the limit', async () => {
    const { deps, battle } = makeDeps();
    expect(await handleBattle({}, IP, deps)).toEqual({ status: 400, json: { reason: 'bad_request' } });
    expect(battle).not.toHaveBeenCalled();
  });

  test('maps runner rejections to 409', async () => {
    for (const reason of ['busy', 'not_open', 'send_failed'] as const) {
      const { deps } = makeDeps(reason);
      expect(await handleBattle({ matchId: 1 }, IP, deps)).toEqual({ status: 409, json: { reason } });
    }
  });

  test('runner throw becomes 409 busy and is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const battle = vi.fn(async () => {
      throw new Error('boom');
    });
    const deps: BattleDeps = { runner: { battle }, limiter: createBattleLimiter() };
    expect(await handleBattle({ matchId: 1 }, IP, deps)).toEqual({ status: 409, json: { reason: 'busy' } });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('429 limit_ip after five valid requests from one IP', async () => {
    const { deps, battle } = makeDeps();
    for (let i = 0; i < 5; i += 1) {
      expect(await handleBattle({ matchId: i + 1 }, IP, deps)).toEqual({ status: 200, json: { ok: true } });
    }
    expect(await handleBattle({ matchId: 6 }, IP, deps)).toEqual({ status: 429, json: { reason: 'limit_ip' } });
    expect(battle).toHaveBeenCalledTimes(5);
    expect(await handleBattle({ matchId: 7 }, '9.9.9.9', deps)).toEqual({ status: 200, json: { ok: true } });
  });
});

describe('battleRoutes', () => {
  test('POST /agent/battle uses the x-real-ip header', async () => {
    const { deps } = makeDeps();
    const app = battleRoutes(deps);
    const res = await post(app, JSON.stringify({ matchId: '12' }), { 'x-real-ip': IP });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});