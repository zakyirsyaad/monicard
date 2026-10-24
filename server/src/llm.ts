import type { ZodType } from 'zod';

export type LlmConfig = { baseUrl: string; apiKey: string; model: string };

export type Llm = {
  /** Asks for a JSON object and validates it. Throws on timeout, HTTP error, bad JSON or schema mismatch. */
  json<T>(system: string, user: string, schema: ZodType<T>, timeoutMs: number): Promise<T>;
};

const TEMPERATURE = 0.8;
const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/** Rejects with Error('timeout') when `promise` does not settle in `ms`; always clears its timer. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const PICTOGRAPHS = /[\p{Cf}\p{Cs}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Variation_Selector}\p{Me}]/gu;

/** Drops control characters, emoji and pictographs, then collapses whitespace. */
export function sanitizeText(text: string): string {
  return text.replace(CONTROL_CHARS, ' ').replace(PICTOGRAPHS, '').replace(/\s+/g, ' ').trim();
}

function parseContent(res: unknown): string {
  const choices = (res as { choices?: { message?: { content?: unknown } }[] } | null)?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new Error('LLM returned no content');
  return content;
}

function unfence(content: string): string {
  const trimmed = content.trim();
  return FENCE.exec(trimmed)?.[1] ?? trimmed;
}

async function request(cfg: LlmConfig, fetchImpl: typeof fetch, body: string, signal: AbortSignal): Promise<string> {
  const res = await fetchImpl(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`);
  return parseContent(await res.json());
}

/** OpenAI-compatible chat/completions client. The API key is only ever sent in the Authorization header. */
export function createLlm(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): Llm {
  return {
    async json<T>(system: string, user: string, schema: ZodType<T>, timeoutMs: number): Promise<T> {
      const controller = new AbortController();
      const body = JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: TEMPERATURE,
      });
      try {
        const content = await withTimeout(request(cfg, fetchImpl, body, controller.signal), timeoutMs);
        return schema.parse(JSON.parse(unfence(content)));
      } catch (err) {
        controller.abort();
        throw err;
      }
    },
  };
}

/** Null when any of the three variables is missing or empty, so callers fall back to templates. */
export function llmFromEnv(env: { LLM_BASE_URL?: string; LLM_API_KEY?: string; LLM_MODEL?: string }): Llm | null {
  const { LLM_BASE_URL: baseUrl, LLM_API_KEY: apiKey, LLM_MODEL: model } = env;
  if (!baseUrl || !apiKey || !model) return null;
  return createLlm({ baseUrl, apiKey, model });
}

const MAX_LOGGED_CHARS = 200;
const loggedScopes = new Set<string>();

/** Logs the first LLM failure per scope per process: the message only, never the key, prompt or request. */
export function logLlmFailureOnce(scope: string, err: unknown): void {
  if (loggedScopes.has(scope)) return;
  loggedScopes.add(scope);
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[llm] ${scope} call failed, using fallback (further failures are not logged): ${message.slice(0, MAX_LOGGED_CHARS)}`);
}

/** Test helper: forget which scopes have already logged. */
export function resetLlmFailureLog(): void {
  loggedScopes.clear();
}
