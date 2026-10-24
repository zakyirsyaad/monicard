import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createLlm, llmFromEnv, logLlmFailureOnce, resetLlmFailureLog, sanitizeText, withTimeout } from '../src/llm';

const CFG = { baseUrl: 'https://llm.example/v1', apiKey: 'sk-secret-key', model: 'test-model' };
const schema = z.object({ title: z.string(), n: z.number() });

const completion = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

const fetchReturning = (res: Response) => vi.fn(async (_url: string, _init?: RequestInit) => res);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createLlm', () => {
  test('posts an OpenAI-compatible request and parses the JSON content', async () => {
    const fetchImpl = fetchReturning(completion('{"title":"Hi","n":3}'));
    const out = await createLlm(CFG, fetchImpl as unknown as typeof fetch).json('sys', 'usr', schema, 1000);
    expect(out).toEqual({ title: 'Hi', n: 3 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://llm.example/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-secret-key');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8,
    });
  });

  test('strips a trailing slash from baseUrl', async () => {
    const fetchImpl = fetchReturning(completion('{"title":"a","n":1}'));
    await createLlm({ ...CFG, baseUrl: 'https://llm.example/v1/' }, fetchImpl as unknown as typeof fetch).json('s', 'u', schema, 1000);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://llm.example/v1/chat/completions');
  });

  test('accepts JSON wrapped in a markdown fence', async () => {
    const fetchImpl = fetchReturning(completion('```json\n{"title":"Fenced","n":1}\n```'));
    const out = await createLlm(CFG, fetchImpl as unknown as typeof fetch).json('s', 'u', schema, 1000);
    expect(out.title).toBe('Fenced');
  });

  test('throws with the status on a non-2xx response and never leaks the key', async () => {
    const fetchImpl = fetchReturning(new Response('nope sk-secret-key', { status: 429 }));
    const err = await createLlm(CFG, fetchImpl as unknown as typeof fetch)
      .json('s', 'u', schema, 1000)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('429');
    expect((err as Error).message).not.toContain('sk-secret-key');
  });

  test('throws Error("timeout") and aborts when the request hangs', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = createLlm(CFG, fetchImpl as unknown as typeof fetch)
      .json('s', 'u', schema, 50)
      .catch((e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(60);
    expect(((await pending) as Error).message).toBe('timeout');
    expect(signal?.aborted).toBe(true);
  });

  test('times out even when fetch ignores the abort signal', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const pending = createLlm(CFG, fetchImpl as unknown as typeof fetch)
      .json('s', 'u', schema, 50)
      .catch((e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(60);
    expect(((await pending) as Error).message).toBe('timeout');
  });

  test('throws when the content is not JSON', async () => {
    const fetchImpl = fetchReturning(completion('sorry, I cannot do that'));
    await expect(createLlm(CFG, fetchImpl as unknown as typeof fetch).json('s', 'u', schema, 1000)).rejects.toThrow();
  });

  test('throws when the JSON fails the schema', async () => {
    const fetchImpl = fetchReturning(completion('{"title":"x","n":"abc"}'));
    await expect(createLlm(CFG, fetchImpl as unknown as typeof fetch).json('s', 'u', schema, 1000)).rejects.toThrow();
  });

  test('throws when choices are missing or content is empty', async () => {
    const empty = fetchReturning(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(createLlm(CFG, empty as unknown as typeof fetch).json('s', 'u', schema, 1000)).rejects.toThrow();
    const blank = fetchReturning(completion(''));
    await expect(createLlm(CFG, blank as unknown as typeof fetch).json('s', 'u', schema, 1000)).rejects.toThrow();
  });
});

describe('llmFromEnv', () => {
  test('returns an Llm when all three variables are set', () => {
    const llm = llmFromEnv({ LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
    expect(llm).not.toBeNull();
    expect(typeof llm?.json).toBe('function');
  });

  test('returns null when any variable is missing or empty', () => {
    expect(llmFromEnv({})).toBeNull();
    expect(llmFromEnv({ LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'k' })).toBeNull();
    expect(llmFromEnv({ LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: '', LLM_MODEL: 'm' })).toBeNull();
    expect(llmFromEnv({ LLM_API_KEY: 'k', LLM_MODEL: 'm' })).toBeNull();
  });
});

describe('sanitizeText', () => {
  test('removes control characters, emoji and collapses whitespace', () => {
    const dirty = ['  Hello', String.fromCharCode(0), ' ', String.fromCharCode(7), 'world ', String.fromCodePoint(0x1f525, 0x1f525), '  again\n\nnow\t! '].join('');
    expect(sanitizeText(dirty)).toBe('Hello world again now !');
  });

  test('removes zero-width joiners and variation selectors left by emoji sequences', () => {
    const zwj = String.fromCodePoint(0x200d);
    const vs16 = String.fromCodePoint(0xfe0f);
    expect(sanitizeText(`a${String.fromCodePoint(0x1f468)}${zwj}${String.fromCodePoint(0x1f469)}b ${String.fromCodePoint(0x2764)}${vs16} c`)).toBe('ab c');
  });

  test('keeps ordinary punctuation and accents', () => {
    expect(sanitizeText("Café's “quote” — fine, ok?")).toBe("Café's “quote” — fine, ok?");
  });
});

describe('withTimeout', () => {
  test('rejects with Error("timeout") and clears the timer on success', async () => {
    vi.useFakeTimers();
    const slow = new Promise<number>(() => undefined);
    const pending = withTimeout(slow, 50).catch((e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(60);
    expect(((await pending) as Error).message).toBe('timeout');
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('logLlmFailureOnce', () => {
  afterEach(() => resetLlmFailureLog());

  test('logs the first failure per scope with the message only', () => {
    resetLlmFailureLog();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = Object.assign(new Error('HTTP 401'), { request: { headers: { authorization: 'Bearer sk-secret-key' } } });
    logLlmFailureOnce('lore', err);
    logLlmFailureOnce('lore', new Error('HTTP 500'));
    logLlmFailureOnce('coach', 'timeout');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(String(warn.mock.calls[0]![0])).toContain('HTTP 401');
    expect(String(warn.mock.calls[0]![0])).not.toContain('sk-secret-key');
    expect(String(warn.mock.calls[1]![0])).toContain('timeout');
  });
});
