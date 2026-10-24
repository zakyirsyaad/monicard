import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseTransaction } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { blitzArenaAbi, nadCardsAbi } from '../src/lib/abi';
import {
  FUND_SETTLE_MS,
  FundError,
  MIN_FUND_WEI,
  MaybeLandedError,
  RevertedError,
  TX_GAP_MS,
  createDuel,
  ensureFunds,
  freePull,
  joinDuel,
  mustSucceed,
  msSinceLastTx,
  paidPull,
  sendCall,
} from '../src/lib/actions';
import { ApiError, NetworkError, TimeoutError } from '../src/lib/api';
import type { Account, Api, Config, FundResult, RelayResult } from '../src/lib/types';

const CARDS = '0x1111111111111111111111111111111111111111' as const;
const ARENA = '0x2222222222222222222222222222222222222222' as const;
const PULL_PRICE = '50000000000000000';

const config = {
  chainId: 10143,
  contracts: { cards: CARDS, arena: ARENA },
  gasLimits: { freePull: 400000, paidPull: 410000, createDuel: 300000, joinDuel: 310000, attack: 1, settle: 1 },
  gasPrice: '50000000000',
  batchMs: 1000,
  pullPrice: PULL_PRICE,
  event: { name: 'Test', sponsor: null },
  agent: '0x3333333333333333333333333333333333333333',
  bots: [],
} satisfies Config;

const account = privateKeyToAccount(generatePrivateKey());

function acct(balance: bigint, nonce = 0): Account {
  return { nonce, balance: balance.toString(), cardId: null, hasPulled: false };
}

const success = (events: RelayResult['events'] = {}): RelayResult => ({
  hash: `0x${'ab'.repeat(32)}`,
  status: 'success',
  latencyMs: 300,
  blockNumber: '100',
  events,
});

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    getConfig: vi.fn(() => Promise.resolve(config)),
    getAccount: vi.fn(() => Promise.resolve(acct(MIN_FUND_WEI * 5n))),
    fund: vi.fn((): Promise<FundResult> => Promise.resolve({ funded: false, reason: 'balance_ok' })),
    relay: vi.fn(() => Promise.resolve(success())),
    getCard: vi.fn(() => Promise.resolve(null)),
    challengeAgent: vi.fn(() => Promise.resolve({ ok: true as const })),
    getStake: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

function deps(api: Api, sleep = vi.fn(() => Promise.resolve())) {
  return { api, account, config, sleep };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureFunds', () => {
  it('funds a low balance and waits for the settle window before the first tx', async () => {
    const getAccount = vi
      .fn<Api['getAccount']>()
      .mockResolvedValueOnce(acct(0n))
      .mockResolvedValueOnce(acct(MIN_FUND_WEI * 3n));
    const fund = vi.fn(() => Promise.resolve({ funded: true, txHash: `0x${'cd'.repeat(32)}` as Hex }));
    const sleep = vi.fn(() => Promise.resolve());

    const fresh = await ensureFunds({ api: makeApi({ getAccount, fund }), sleep }, account.address);

    expect(fund).toHaveBeenCalledWith(account.address);
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(FUND_SETTLE_MS).toBe(1500);
    expect(fresh.balance).toBe((MIN_FUND_WEI * 3n).toString());
  });

  it('does not fund when the balance is enough', async () => {
    const fund = vi.fn(() => Promise.resolve({ funded: true }));
    const sleep = vi.fn(() => Promise.resolve());
    await ensureFunds({ api: makeApi({ fund }), sleep }, account.address);
    expect(fund).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honours a custom minimum', async () => {
    const fund = vi.fn(() => Promise.resolve({ funded: false, reason: 'balance_ok' as const }));
    await ensureFunds({ api: makeApi({ fund }), sleep: vi.fn() }, account.address, MIN_FUND_WEI * 10n);
    expect(fund).toHaveBeenCalledOnce();
  });

  it('throws FundError(disabled) when funding is off and the balance is low', async () => {
    const api = makeApi({
      getAccount: vi.fn(() => Promise.resolve(acct(0n))),
      fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'disabled' as const })),
    });
    await expect(ensureFunds({ api, sleep: vi.fn() }, account.address)).rejects.toMatchObject({
      name: 'FundError',
      reason: 'disabled',
    });
  });

  it.each(['limit_address', 'limit_ip', 'budget'] as const)('throws FundError(%s)', async (reason) => {
    const api = makeApi({
      getAccount: vi.fn(() => Promise.resolve(acct(0n))),
      fund: vi.fn(() => Promise.resolve({ funded: false, reason })),
    });
    const err = await ensureFunds({ api, sleep: vi.fn() }, account.address).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FundError);
    expect((err as FundError).reason).toBe(reason);
  });

  it('accepts balance_ok from the server even when below our minimum', async () => {
    const api = makeApi({
      getAccount: vi.fn(() => Promise.resolve(acct(MIN_FUND_WEI / 2n))),
      fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'balance_ok' as const })),
    });
    const fresh = await ensureFunds({ api, sleep: vi.fn() }, account.address);
    expect(fresh.balance).toBe((MIN_FUND_WEI / 2n).toString());
  });
});

describe('sendCall', () => {
  const call = { fn: 'freePull', to: CARDS, data: '0x1234' as Hex, gas: 400000 };

  it('signs with the account nonce and relays the raw tx', async () => {
    const relay = vi.fn<Api['relay']>(() => Promise.resolve(success()));
    const api = makeApi({ getAccount: vi.fn(() => Promise.resolve(acct(MIN_FUND_WEI, 7))), relay });
    await sendCall(deps(api), call);
    const raw = relay.mock.calls[0]?.[0] as Hex;
    const tx = parseTransaction(raw);
    expect(tx.nonce).toBe(7);
    expect(tx.to?.toLowerCase()).toBe(CARDS);
    expect(tx.gas).toBe(400000n);
  });

  it('resends the identical raw tx after a timeout', async () => {
    const relay = vi
      .fn<Api['relay']>()
      .mockRejectedValueOnce(new TimeoutError(5000))
      .mockRejectedValueOnce(new TimeoutError(5000))
      .mockResolvedValueOnce(success());
    const result = await sendCall(deps(makeApi({ relay })), call);
    expect(result.status).toBe('success');
    expect(relay).toHaveBeenCalledTimes(3);
    const [first, second, third] = relay.mock.calls.map((c) => c[0]);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('gives up after three resends', async () => {
    const relay = vi.fn<Api['relay']>().mockRejectedValue(new TimeoutError(5000));
    await expect(sendCall(deps(makeApi({ relay })), call)).rejects.toBeInstanceOf(TimeoutError);
    expect(relay).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['paidPull', { value: 50_000_000_000_000_000n }],
    ['createDuel', {}],
    ['joinDuel', {}],
    ['stake', { value: 50_000_000_000_000_000n }],
    ['claim', {}],
  ])('throws MaybeLandedError when every resend of %s times out', async (fn, extra) => {
    const relay = vi.fn<Api['relay']>().mockRejectedValue(new TimeoutError(5000));
    const err = await sendCall(deps(makeApi({ relay })), { ...call, fn, ...extra }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaybeLandedError);
    expect((err as MaybeLandedError).fn).toBe(fn);
    expect(relay).toHaveBeenCalledTimes(4);
  });

  it('throws MaybeLandedError when a paidPull resend fails with a network error after a timeout', async () => {
    const relay = vi
      .fn<Api['relay']>()
      .mockRejectedValueOnce(new TimeoutError(5000))
      .mockRejectedValueOnce(new NetworkError('offline'));
    const paid = { ...call, fn: 'paidPull', value: 50_000_000_000_000_000n };
    const err = await sendCall(deps(makeApi({ relay })), paid).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaybeLandedError);
  });

  it('throws MaybeLandedError when a createDuel resend is refused by the server after a timeout', async () => {
    const relay = vi
      .fn<Api['relay']>()
      .mockRejectedValueOnce(new TimeoutError(5000))
      .mockRejectedValueOnce(new ApiError(429, 'budget'));
    const err = await sendCall(deps(makeApi({ relay })), { ...call, fn: 'createDuel' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaybeLandedError);
  });

  it('still rethrows a network error after a timeout for a safe call (freePull)', async () => {
    const relay = vi
      .fn<Api['relay']>()
      .mockRejectedValueOnce(new TimeoutError(5000))
      .mockRejectedValueOnce(new NetworkError('offline'));
    await expect(sendCall(deps(makeApi({ relay })), call)).rejects.toBeInstanceOf(NetworkError);
  });

  it('refetches the nonce and retries once on a nonce error', async () => {
    const getAccount = vi
      .fn<Api['getAccount']>()
      .mockResolvedValueOnce(acct(MIN_FUND_WEI, 3))
      .mockResolvedValueOnce(acct(MIN_FUND_WEI, 4));
    const relay = vi
      .fn<Api['relay']>()
      .mockRejectedValueOnce(new ApiError(400, 'nonce_too_low'))
      .mockResolvedValueOnce(success());
    await sendCall(deps(makeApi({ getAccount, relay })), call);
    expect(relay).toHaveBeenCalledTimes(2);
    expect(parseTransaction(relay.mock.calls[0]?.[0] as Hex).nonce).toBe(3);
    expect(parseTransaction(relay.mock.calls[1]?.[0] as Hex).nonce).toBe(4);
  });

  it('does not re-sign after a timeout when the nonce has moved: the first send probably landed', async () => {
    const getAccount = vi
      .fn<Api['getAccount']>()
      .mockResolvedValueOnce(acct(MIN_FUND_WEI, 5))
      .mockResolvedValueOnce(acct(MIN_FUND_WEI, 6));
    const relay = vi
      .fn<Api['relay']>()
      .mockRejectedValueOnce(new TimeoutError(5000))
      .mockRejectedValueOnce(new ApiError(400, 'nonce_too_low'));
    const err = await sendCall(deps(makeApi({ getAccount, relay })), call).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaybeLandedError);
    expect(relay).toHaveBeenCalledTimes(2);
    expect(relay.mock.calls[1]?.[0]).toBe(relay.mock.calls[0]?.[0]);
  });

  it('rethrows the nonce error after a timeout when the chain nonce has not moved', async () => {
    const getAccount = vi.fn<Api['getAccount']>().mockResolvedValue(acct(MIN_FUND_WEI, 5));
    const relay = vi
      .fn<Api['relay']>()
      .mockRejectedValueOnce(new TimeoutError(5000))
      .mockRejectedValueOnce(new ApiError(400, 'nonce_too_low'));
    await expect(sendCall(deps(makeApi({ getAccount, relay })), call)).rejects.toBeInstanceOf(ApiError);
    expect(relay).toHaveBeenCalledTimes(2);
  });

  it('does not retry a second nonce error', async () => {
    const relay = vi.fn<Api['relay']>().mockRejectedValue(new ApiError(400, 'nonce_too_low'));
    await expect(sendCall(deps(makeApi({ relay })), call)).rejects.toBeInstanceOf(ApiError);
    expect(relay).toHaveBeenCalledTimes(2);
  });

  it('does not retry other relay errors', async () => {
    const relay = vi.fn<Api['relay']>().mockRejectedValue(new ApiError(400, 'balance'));
    await expect(sendCall(deps(makeApi({ relay })), call)).rejects.toMatchObject({ reason: 'balance' });
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it('records the time of the last relay attempt', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    await sendCall({ ...deps(makeApi()), now: () => 12345 }, call);
    expect(store.get('nad.lastTxAt')).toBe('12345');
  });

  it('survives blocked storage', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    await expect(sendCall(deps(makeApi()), call)).resolves.toBeDefined();
  });
});

describe('msSinceLastTx', () => {
  it('is Infinity when unknown', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    expect(msSinceLastTx(() => 5000)).toBe(Infinity);
  });

  it('measures from the stored timestamp', () => {
    vi.stubGlobal('localStorage', { getItem: () => '4000', setItem: () => undefined });
    expect(msSinceLastTx(() => 5000)).toBe(1000);
    expect(TX_GAP_MS).toBe(1500);
  });

  it('is Infinity when the stored value is garbage or storage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'abc', setItem: () => undefined });
    expect(msSinceLastTx(() => 5000)).toBe(Infinity);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(msSinceLastTx(() => 5000)).toBe(Infinity);
  });
});

describe('call helpers', () => {
  function relayed(api: Api) {
    const raw = (api.relay as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Hex;
    return parseTransaction(raw);
  }

  it('freePull calls CardsNFT.freePull with its gas limit', async () => {
    const api = makeApi();
    await freePull(deps(api));
    const tx = relayed(api);
    expect(tx.to?.toLowerCase()).toBe(CARDS);
    expect(tx.gas).toBe(400000n);
    expect(tx.value ?? 0n).toBe(0n);
    expect(decodeFunctionData({ abi: nadCardsAbi, data: tx.data! }).functionName).toBe('freePull');
  });

  it('paidPull sends value = pullPrice', async () => {
    const api = makeApi();
    await paidPull(deps(api), PULL_PRICE);
    const tx = relayed(api);
    expect(tx.value).toBe(BigInt(PULL_PRICE));
    expect(tx.gas).toBe(410000n);
    expect(decodeFunctionData({ abi: nadCardsAbi, data: tx.data! }).functionName).toBe('paidPull');
  });

  it('createDuel encodes the card id for the arena', async () => {
    const api = makeApi();
    await createDuel(deps(api), '42');
    const tx = relayed(api);
    expect(tx.to?.toLowerCase()).toBe(ARENA);
    expect(tx.gas).toBe(300000n);
    const decoded = decodeFunctionData({ abi: blitzArenaAbi, data: tx.data! });
    expect(decoded.functionName).toBe('createDuel');
    expect(decoded.args).toEqual([42n]);
  });

  it('joinDuel encodes duel id and card id', async () => {
    const api = makeApi();
    await joinDuel(deps(api), '9', '42');
    const tx = relayed(api);
    expect(tx.gas).toBe(310000n);
    const decoded = decodeFunctionData({ abi: blitzArenaAbi, data: tx.data! });
    expect(decoded.functionName).toBe('joinDuel');
    expect(decoded.args).toEqual([9n, 42n]);
  });
});

describe('mustSucceed', () => {
  it('returns a successful result', () => {
    const res = success({ tokenId: '5' });
    expect(mustSucceed(res, 'freePull')).toBe(res);
  });

  it('throws a RevertedError carrying the function name', () => {
    const res: RelayResult = { ...success(), status: 'reverted' };
    const err = (() => {
      try {
        mustSucceed(res, 'freePull');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(RevertedError);
    expect(err).toMatchObject({ status: 'reverted', fn: 'freePull' });
  });
});
