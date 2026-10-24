import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError, TimeoutError, createHttpApi } from '../src/lib/api';

type Call = { url: string; init: RequestInit | undefined };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const ADDR = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}` as const;

describe('createHttpApi endpoints', () => {
  it('getConfig GETs /config and parses the body', async () => {
    const cfg = { chainId: 10143, batchMs: 1000, pullPrice: '50000000000000000' };
    const { fn, calls } = fakeFetch(() => json(cfg));
    const api = createHttpApi('', fn);
    expect(await api.getConfig()).toEqual(cfg);
    expect(calls[0]?.url).toBe('/config');
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
  });

  it('prefixes the base url', async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    await createHttpApi('http://x:1', fn).getConfig();
    expect(calls[0]?.url).toBe('http://x:1/config');
  });

  it('getAccount puts the address in the path', async () => {
    const acct = { nonce: 3, balance: '1000', cardId: null, hasPulled: false };
    const { fn, calls } = fakeFetch(() => json(acct));
    expect(await createHttpApi('', fn).getAccount(ADDR)).toEqual(acct);
    expect(calls[0]?.url).toBe(`/account/${ADDR}`);
  });

  it('fund POSTs {address} as JSON', async () => {
    const { fn, calls } = fakeFetch(() => json({ funded: true, txHash: HASH }));
    const res = await createHttpApi('', fn).fund(ADDR);
    expect(res).toEqual({ funded: true, txHash: HASH });
    expect(calls[0]?.url).toBe('/fund');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ address: ADDR });
  });

  it('fund passes through a not-funded reason', async () => {
    const { fn } = fakeFetch(() => json({ funded: false, reason: 'balance_ok' }));
    expect(await createHttpApi('', fn).fund(ADDR)).toEqual({ funded: false, reason: 'balance_ok' });
  });

  it('relay POSTs {rawTx} as JSON and parses the result', async () => {
    const result = {
      hash: HASH,
      status: 'success',
      latencyMs: 412,
      blockNumber: '100',
      events: { duelId: '7' },
    };
    const { fn, calls } = fakeFetch(() => json(result));
    expect(await createHttpApi('', fn).relay('0xdeadbeef')).toEqual(result);
    expect(calls[0]?.url).toBe('/relay');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ rawTx: '0xdeadbeef' });
  });

  it('getCard GETs /card/:id', async () => {
    const { fn, calls } = fakeFetch(() => json({ status: 'forging' }));
    expect(await createHttpApi('', fn).getCard('42')).toEqual({ status: 'forging' });
    expect(calls[0]?.url).toBe('/card/42');
  });

  it('getCard maps 404 to null', async () => {
    const { fn } = fakeFetch(() => json({ reason: 'not_found' }, 404));
    expect(await createHttpApi('', fn).getCard('999')).toBeNull();
  });

  it('challengeAgent POSTs {duelId}', async () => {
    const { fn, calls } = fakeFetch(() => json({ ok: true }));
    expect(await createHttpApi('', fn).challengeAgent('5')).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('/agent/challenge');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ duelId: '5' });
  });

  it('challengeAgent resolves 409 and 429 as {ok:false, reason}', async () => {
    const busy = fakeFetch(() => json({ reason: 'busy' }, 409));
    expect(await createHttpApi('', busy.fn).challengeAgent('5')).toEqual({
      ok: false,
      reason: 'busy',
    });
    const limited = fakeFetch(() => json({ reason: 'limit_ip' }, 429));
    expect(await createHttpApi('', limited.fn).challengeAgent('5')).toEqual({
      ok: false,
      reason: 'limit_ip',
    });
  });

  it('challengeAgent throws ApiError for an unknown 409 reason', async () => {
    const { fn } = fakeFetch(() => json({ reason: 'weird' }, 409));
    const err = await createHttpApi('', fn)
      .challengeAgent('5')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).reason).toBe('weird');
  });

  it('challengeAgent accepts every known refusal reason', async () => {
    for (const reason of ['busy', 'reserved', 'not_open', 'stale', 'limit_ip']) {
      const { fn } = fakeFetch(() => json({ reason }, reason === 'limit_ip' ? 429 : 409));
      expect(await createHttpApi('', fn).challengeAgent('5')).toEqual({ ok: false, reason });
    }
  });

  it('challengeAgent still throws on other statuses', async () => {
    const { fn } = fakeFetch(() => json({ reason: 'boom' }, 500));
    await expect(createHttpApi('', fn).challengeAgent('5')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('createHttpApi errors', () => {
  it('maps a {reason} body to ApiError', async () => {
    const { fn } = fakeFetch(() => json({ reason: 'limit_ip' }, 429));
    const err = await createHttpApi('', fn)
      .relay('0x00')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).reason).toBe('limit_ip');
  });

  it('falls back to http_<status> when there is no reason', async () => {
    const { fn } = fakeFetch(() => new Response('oops', { status: 502 }));
    const err = await createHttpApi('', fn)
      .getConfig()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).reason).toBe('http_502');
  });

  it('wraps a rejected fetch in NetworkError', async () => {
    const fn = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(createHttpApi('', fn).getConfig()).rejects.toBeInstanceOf(NetworkError);
    await expect(createHttpApi('', fn).relay('0x00')).rejects.toBeInstanceOf(NetworkError);
  });

  it('relay throws TimeoutError when the request exceeds timeoutMs', async () => {
    let aborted = false;
    const fn = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof fetch;
    const err = await createHttpApi('', fn)
      .relay('0x00', 20)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });

  it('relay does not time out when the response arrives in time', async () => {
    const { fn } = fakeFetch(() =>
      json({ hash: HASH, status: 'success', latencyMs: 1, blockNumber: '1', events: {} }),
    );
    const res = await createHttpApi('', fn).relay('0x00', 1000);
    expect(res.status).toBe('success');
  });
});
