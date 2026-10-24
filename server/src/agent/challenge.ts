import type { createAgentRunner } from './runner';

export type IpLimiter = { allow(ip: string): boolean };

export type ChallengeDeps = {
  runner: Pick<ReturnType<typeof createAgentRunner>, 'challenge'>;
  limiter: IpLimiter;
};

export type ChallengeStatus = 200 | 400 | 409 | 429;
export type ChallengeResponse = { status: ChallengeStatus; json: Record<string, unknown> };

/** Five challenges per IP per ten minutes: the public URL must not drain the agent wallet. */
export const IP_LIMIT_MAX = 5;
export const IP_LIMIT_WINDOW_MS = 600_000;
/** Bound on remembered buckets; expired ones are pruned first. */
export const IP_LIMIT_MAX_BUCKETS = 10_000;
const MAX_DUEL_ID_DIGITS = 20;
const DECIMAL_ID = /^\d{1,20}$/;

const BAD_REQUEST: ChallengeResponse = { status: 400, json: { reason: 'bad_request' } };
const LIMIT_IP: ChallengeResponse = { status: 429, json: { reason: 'limit_ip' } };
const OK: ChallengeResponse = { status: 200, json: { ok: true } };

export function createIpLimiter(opts: { max?: number; windowMs?: number; now?: () => number } = {}): IpLimiter {
  const max = opts.max ?? IP_LIMIT_MAX;
  const windowMs = opts.windowMs ?? IP_LIMIT_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, number[]>();

  function prune(at: number): void {
    for (const [ip, stamps] of buckets) {
      const fresh = stamps.filter((stamp) => at - stamp < windowMs);
      if (fresh.length === 0) buckets.delete(ip);
      else if (fresh.length !== stamps.length) buckets.set(ip, fresh);
    }
  }

  /** Keeps the map from growing forever under a spray of distinct IPs. */
  function cap(at: number): void {
    if (buckets.size <= IP_LIMIT_MAX_BUCKETS) return;
    prune(at);
    while (buckets.size > IP_LIMIT_MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) return;
      buckets.delete(oldest);
    }
  }

  return {
    allow(ip: string): boolean {
      const at = now();
      const recent = (buckets.get(ip) ?? []).filter((stamp) => at - stamp < windowMs);
      if (recent.length >= max) {
        buckets.set(ip, recent);
        return false;
      }
      recent.push(at);
      // Re-insert so Map order tracks recency for the eviction cap.
      buckets.delete(ip);
      buckets.set(ip, recent);
      cap(at);
      return true;
    },
  };
}

/** `{duelId}` as a decimal string or a non-negative safe integer; anything else is invalid. */
export function parseDuelId(body: unknown): bigint | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { duelId?: unknown }).duelId;
  if (typeof raw === 'string') return DECIMAL_ID.test(raw) ? BigInt(raw) : null;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  return null;
}

const shortError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Framework-free `POST /agent/challenge` handler. Only the frozen contract's
 * statuses leave here: 200 ok, 400 bad_request, 409 busy|reserved|not_open|stale,
 * 429 limit_ip.
 */
export async function handleChallenge(body: unknown, ip: string, deps: ChallengeDeps): Promise<ChallengeResponse> {
  const duelId = parseDuelId(body);
  if (duelId === null) return BAD_REQUEST;
  if (!deps.limiter.allow(ip)) return LIMIT_IP;

  try {
    const result = await deps.runner.challenge(duelId);
    if (result === 'ok') return OK;
    return { status: 409, json: { reason: result } };
  } catch (error) {
    // The runner should only throw on unexpected failures; busy is the retryable answer.
    console.error(`[agent] challenge failed: ${shortError(error)}`);
    return { status: 409, json: { reason: 'busy' } };
  }
}