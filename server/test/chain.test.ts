import { describe, expect, test } from 'vitest';
import { HttpRequestError, TimeoutError, type PublicClient } from 'viem';
import { createChain, isRetryable } from '../src/chain';

const RPC_A = 'https://rpc-a.example';
const RPC_B = 'https://rpc-b.example';

function clientReturning(value: bigint): PublicClient {
  return { getBlockNumber: async () => value } as unknown as PublicClient;
}

function clientThrowing(error: unknown): PublicClient {
  return {
    getBlockNumber: async () => {
      throw error;
    },
  } as unknown as PublicClient;
}

const tooMany = () => new HttpRequestError({ url: RPC_A, status: 429 });
const unavailable = () => new HttpRequestError({ url: RPC_A, status: 503 });
const badRequest = () => new HttpRequestError({ url: RPC_A, status: 400 });
const reverted = () => Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' });

describe('isRetryable', () => {
  test('retries 429, 5xx and timeouts', () => {
    expect(isRetryable(tooMany())).toBe(true);
    expect(isRetryable(unavailable())).toBe(true);
    expect(isRetryable(new HttpRequestError({ url: RPC_A, status: 500 }))).toBe(true);
    expect(isRetryable(new TimeoutError({ url: RPC_A, body: {} }))).toBe(true);
    expect(isRetryable(new Error('The request timed out'))).toBe(true);
    expect(isRetryable(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
  });

  test('retries a retryable error nested in a viem wrapper', () => {
    const wrapped = Object.assign(new Error('call failed'), { cause: tooMany() });
    expect(isRetryable(wrapped)).toBe(true);
  });

  test('does not retry a revert or a bad request', () => {
    expect(isRetryable(reverted())).toBe(false);
    expect(isRetryable(new Error('execution reverted: WrongPrice'))).toBe(false);
    expect(isRetryable(badRequest())).toBe(false);
    expect(isRetryable(new Error('nonce too low'))).toBe(false);
  });
});

describe('createChain', () => {
  test('retries once on the same URL before moving on', async () => {
    let attempts = 0;
    const flaky = {
      getBlockNumber: async () => {
        attempts += 1;
        if (attempts === 1) throw unavailable();
        return 7n;
      },
    } as unknown as PublicClient;
    const sleeps: number[] = [];
    const chain = createChain([RPC_A], 10143, {
      clients: [flaky],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(chain.call((c) => c.getBlockNumber())).resolves.toBe(7n);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([150]);
  });

  test('moves to the next URL when one keeps failing', async () => {
    const attempts: string[] = [];
    const bad = {
      getBlockNumber: async () => {
        attempts.push('bad');
        throw tooMany();
      },
    } as unknown as PublicClient;
    const good = {
      getBlockNumber: async () => {
        attempts.push('good');
        return 42n;
      },
    } as unknown as PublicClient;
    const sleeps: number[] = [];
    const chain = createChain([RPC_A, RPC_B], 10143, {
      clients: [bad, good],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(chain.call((c) => c.getBlockNumber())).resolves.toBe(42n);
    expect(attempts).toEqual(['bad', 'bad', 'good']);
    expect(sleeps).toEqual([150]);
  });

  test('throws after two attempts when there is no other URL', async () => {
    let attempts = 0;
    const bad = {
      getBlockNumber: async () => {
        attempts += 1;
        throw tooMany();
      },
    } as unknown as PublicClient;
    const chain = createChain([RPC_A], 10143, { clients: [bad], sleep: async () => {} });

    await expect(chain.call((c) => c.getBlockNumber())).rejects.toMatchObject({ status: 429 });
    expect(attempts).toBe(2);
  });

  test('does not fail over on a non-retryable error', async () => {
    const attempts: string[] = [];
    const bad = {
      getBlockNumber: async () => {
        attempts.push('bad');
        throw reverted();
      },
    } as unknown as PublicClient;
    const good = {
      getBlockNumber: async () => {
        attempts.push('good');
        return 1n;
      },
    } as unknown as PublicClient;
    const chain = createChain([RPC_A, RPC_B], 10143, { clients: [bad, good], sleep: async () => {} });

    await expect(chain.call((c) => c.getBlockNumber())).rejects.toThrow(/reverted/);
    expect(attempts).toEqual(['bad']);
  });

  test('exposes the first client as the default client', () => {
    const first = clientReturning(1n);
    const second = clientReturning(2n);
    const chain = createChain([RPC_A, RPC_B], 10143, { clients: [first, second] });

    expect(chain.client).toBe(first);
    expect(chain.chainId).toBe(10143);
  });

  test('caches the gas price for ten seconds', async () => {
    let calls = 0;
    let price = 100_000_000_000n;
    let now = 0;
    const client = {
      getGasPrice: async () => {
        calls += 1;
        return price;
      },
    } as unknown as PublicClient;
    const chain = createChain([RPC_A], 10143, {
      clients: [client],
      now: () => now,
      sleep: async () => {},
    });

    await expect(chain.getGasPrice()).resolves.toBe(100_000_000_000n);
    price = 200_000_000_000n;
    now = 9_999;
    await expect(chain.getGasPrice()).resolves.toBe(100_000_000_000n);
    expect(calls).toBe(1);

    now = 10_000;
    await expect(chain.getGasPrice()).resolves.toBe(200_000_000_000n);
    expect(calls).toBe(2);
  });

  test('rejects an empty RPC list', () => {
    expect(() => createChain([], 10143)).toThrow(/RPC URL/);
  });
});