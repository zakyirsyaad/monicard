import { Hono } from 'hono';
import { clientIp } from '../clientIp';
import { createIpLimiter, type IpLimiter } from './challenge';
import type { BattleRunner } from './battleRunner';

export type BattleDeps = {
  runner: Pick<BattleRunner, 'battle'>;
  limiter: IpLimiter;
};

export type BattleStatus = 200 | 400 | 409 | 429;
export type BattleResponse = { status: BattleStatus; json: Record<string, unknown> };

const DECIMAL_ID = /^\d{1,20}$/;

const BAD_REQUEST: BattleResponse = { status: 400, json: { reason: 'bad_request' } };
const LIMIT_IP: BattleResponse = { status: 429, json: { reason: 'limit_ip' } };
const OK: BattleResponse = { status: 200, json: { ok: true } };

/** `{matchId}` as a decimal string or a non-negative safe integer; anything else is invalid. */
export function parseMatchId(body: unknown): bigint | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { matchId?: unknown }).matchId;
  if (typeof raw === 'string') return DECIMAL_ID.test(raw) ? BigInt(raw) : null;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  return null;
}

const shortError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Framework-free `POST /agent/battle` handler: 200 ok, 400 bad_request,
 * 409 busy|not_open|send_failed, 429 limit_ip.
 */
export async function handleBattle(body: unknown, ip: string, deps: BattleDeps): Promise<BattleResponse> {
  const matchId = parseMatchId(body);
  if (matchId === null) return BAD_REQUEST;
  if (!deps.limiter.allow(ip)) return LIMIT_IP;

  try {
    const result = await deps.runner.battle(matchId);
    if (result === 'ok') return OK;
    return { status: 409, json: { reason: result } };
  } catch (error) {
    console.error(`[agent] battle failed: ${shortError(error)}`);
    return { status: 409, json: { reason: 'busy' } };
  }
}

type NodeEnv = { incoming?: { socket?: { remoteAddress?: string } } };

/** Mounted at `/agent`: POST /agent/battle. */
export function battleRoutes(deps: BattleDeps): Hono {
  const app = new Hono();
  app.post('/battle', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const remote = (c.env as NodeEnv | undefined)?.incoming?.socket?.remoteAddress;
    const { status, json } = await handleBattle(body, clientIp(c.req.raw.headers, remote), deps);
    return c.json(json, status);
  });
  return app;
}

/** Five battle requests per IP per ten minutes, same budget shape as the tap challenge. */
export const createBattleLimiter = (): IpLimiter => createIpLimiter();