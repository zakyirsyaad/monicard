import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, TimeoutError, isTransient } from '../src/lib/api';
import {
  CARD_MAX_TRIES,
  CARD_NOT_FOUND_TRIES,
  fetchCardWithRetry,
} from '../src/lib/cardFetch';
import { withRetryParam } from '../src/lib/cardImage';
import type { CardMeta } from '../src/lib/types';

const META = { nadgacha: { status: 'ready' } } as unknown as CardMeta;

describe('isTransient', () => {
  it.each([429, 500, 502, 503, 504])('treats ApiError %i as transient', (status) => {
    expect(isTransient(new ApiError(status, `http_${status}`))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409])('treats ApiError %i as permanent', (status) => {
    expect(isTransient(new ApiError(status, `http_${status}`))).toBe(false);
  });

  it('treats network and timeout errors as transient', () => {
    expect(isTransient(new NetworkError())).toBe(true);
    expect(isTransient(new TimeoutError(5000))).toBe(true);
  });

  it('treats unknown values as permanent', () => {
    expect(isTransient(new Error('boom'))).toBe(false);
    expect(isTransient('503')).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe('fetchCardWithRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a 503 and then returns the card', async () => {
    const getCard = vi
      .fn<(id: string) => Promise<CardMeta | null>>()
      .mockRejectedValueOnce(new ApiError(503, 'http_503'))
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValue(META);
    const done = fetchCardWithRetry('7', { getCard });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe(META);
    expect(getCard).toHaveBeenCalledTimes(3);
  });

  it('gives up after the max number of transient failures and rethrows', async () => {
    const getCard = vi
      .fn<(id: string) => Promise<CardMeta | null>>()
      .mockRejectedValue(new ApiError(503, 'http_503'));
    const done = fetchCardWithRetry('7', { getCard });
    const settled = done.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err).toBeInstanceOf(ApiError);
    expect(getCard).toHaveBeenCalledTimes(CARD_MAX_TRIES);
  });

  it('keeps the total retry window around six seconds', async () => {
    const getCard = vi
      .fn<(id: string) => Promise<CardMeta | null>>()
      .mockRejectedValue(new ApiError(503, 'http_503'));
    const started = Date.now();
    const done = fetchCardWithRetry('7', { getCard }).catch(() => undefined);
    await vi.runAllTimersAsync();
    await done;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThanOrEqual(7000);
  });

  it('returns null after the not-found retries (404)', async () => {
    const getCard = vi.fn<(id: string) => Promise<CardMeta | null>>().mockResolvedValue(null);
    const done = fetchCardWithRetry('7', { getCard });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeNull();
    expect(getCard).toHaveBeenCalledTimes(CARD_NOT_FOUND_TRIES);
  });

  it('throws a permanent error immediately', async () => {
    const getCard = vi
      .fn<(id: string) => Promise<CardMeta | null>>()
      .mockRejectedValue(new ApiError(400, 'bad_id'));
    await expect(fetchCardWithRetry('x', { getCard })).rejects.toBeInstanceOf(ApiError);
    expect(getCard).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once cancelled', async () => {
    let cancelled = false;
    const getCard = vi.fn<(id: string) => Promise<CardMeta | null>>().mockImplementation(async () => {
      cancelled = true;
      throw new ApiError(503, 'http_503');
    });
    const done = fetchCardWithRetry('7', { getCard, isCancelled: () => cancelled });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeNull();
    expect(getCard).toHaveBeenCalledTimes(1);
  });
});

describe('withRetryParam', () => {
  it('leaves the url alone for the first attempt', () => {
    expect(withRetryParam('/card/1/image.svg', 0)).toBe('/card/1/image.svg');
  });

  it('adds ?r= when there is no query', () => {
    expect(withRetryParam('/card/1/image.svg', 2)).toBe('/card/1/image.svg?r=2');
  });

  it('adds &r= when a query exists', () => {
    expect(withRetryParam('/card/1/image.svg?v=ready', 3)).toBe('/card/1/image.svg?v=ready&r=3');
  });
});

describe('card load messages', () => {
  it('uses a friendly message for the final failure', async () => {
    const { CARD_LOAD_FAILED } = await import('../src/lib/cardFetch');
    expect(CARD_LOAD_FAILED).toMatch(/couldn't load that card/);
  });
});
