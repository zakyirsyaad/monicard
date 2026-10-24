import type { Hex } from 'viem';
import { mockApi } from '../mock/api';
import type {
  Account,
  AgentChallengeResult,
  Api,
  CardMeta,
  Config,
  FundResult,
  RelayResult,
} from './types';

export type { Api } from './types';

/** Non-2xx response. `reason` comes from the JSON body `{reason}` or is `http_<status>`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`API error ${status}: ${reason}`);
    this.name = 'ApiError';
  }
}

/** The relay request exceeded its timeout. Callers resend the identical raw tx. */
export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/** fetch itself rejected (offline, DNS, CORS, ...). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Network error', { cause });
    this.name = 'NetworkError';
  }
}

export const RELAY_TIMEOUT_MS = 5000;

type AgentRefusal = Extract<AgentChallengeResult, { ok: false }>['reason'];

const AGENT_REFUSALS = new Set([409, 429]);

type Raw = { status: number; ok: boolean; body: unknown };

function parseBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function reasonOf(raw: Raw): string {
  const body = raw.body;
  if (body && typeof body === 'object' && 'reason' in body) {
    const reason = (body as { reason: unknown }).reason;
    if (typeof reason === 'string') return reason;
  }
  return `http_${raw.status}`;
}

export function createHttpApi(
  baseUrl = '',
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Api {
  async function send(
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<Raw> {
    const controller = timeoutMs === undefined ? null : new AbortController();
    let timedOut = false;
    const timer =
      controller && timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;
    try {
      const res = await fetchFn(`${baseUrl}${path}`, { ...init, signal: controller?.signal });
      const text = await res.text();
      return { status: res.status, ok: res.ok, body: parseBody(text) };
    } catch (err) {
      if (timedOut && timeoutMs !== undefined) throw new TimeoutError(timeoutMs);
      throw new NetworkError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function call<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    const raw = await send(path, init, timeoutMs);
    if (!raw.ok) throw new ApiError(raw.status, reasonOf(raw));
    if (raw.body === null) throw new ApiError(raw.status, 'bad_response');
    return raw.body as T;
  }

  const postJson = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    getConfig: () => call<Config>('/config'),
    getAccount: (address: Hex) => call<Account>(`/account/${address}`),
    fund: (address: Hex) => call<FundResult>('/fund', postJson({ address })),
    relay: (rawTx: Hex, timeoutMs = RELAY_TIMEOUT_MS) =>
      call<RelayResult>('/relay', postJson({ rawTx }), timeoutMs),
    async getCard(id: string): Promise<CardMeta | null> {
      const raw = await send(`/card/${id}`);
      if (raw.status === 404) return null;
      if (!raw.ok) throw new ApiError(raw.status, reasonOf(raw));
      if (raw.body === null) throw new ApiError(raw.status, 'bad_response');
      return raw.body as CardMeta;
    },
    async challengeAgent(duelId: string): Promise<AgentChallengeResult> {
      const raw = await send('/agent/challenge', postJson({ duelId }));
      if (raw.ok) return { ok: true };
      if (AGENT_REFUSALS.has(raw.status)) {
        return { ok: false, reason: reasonOf(raw) as AgentRefusal };
      }
      throw new ApiError(raw.status, reasonOf(raw));
    },
  };
}

export const api: Api = import.meta.env.VITE_USE_MOCK === '1' ? mockApi : createHttpApi();
