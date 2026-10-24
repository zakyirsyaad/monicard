import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseEther, parseTransaction } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { stakeVaultAbi } from '../src/lib/abi';
import { FundError, MIN_FUND_WEI, MaybeLandedError, RevertedError } from '../src/lib/actions';
import { createHttpApi } from '../src/lib/api';
import { friendlyError, toFriendly } from '../src/lib/errors';
import { claimStake, joinAndStake, stakeOnDuel, StakeFundsError } from '../src/lib/stakeFlows';
import { parseStakeTuple } from '../src/lib/stakeRead';
import type { Account, Api, Config, RelayResult, StakeView } from '../src/lib/types';

const VAULT: Hex = '0x7777777777777777777777777777777777777777';
const config: Config = {
  chainId: 10143,
  contracts: {
    cards: '0x1111111111111111111111111111111111111111',
    arena: '0x2222222222222222222222222222222222222222',
    stakeVault: VAULT,
  },
  gasLimits: { freePull: 4, paidPull: 5, createDuel: 6, joinDuel: 7, attack: 1, settle: 1, stake: 131000, claim: 154000 },
  gasPrice: '50000000000',
  batchMs: 1000,
  pullPrice: '50000000000000000',
  event: { name: 'Test', sponsor: null },
  agent: '0x3333333333333333333333333333333333333333',
  bots: [],
};
const AMOUNT = parseEther('0.05');
const account = privateKeyToAccount(generatePrivateKey());
const acct = (balance: bigint): Account => ({ nonce: 0, balance: balance.toString(), cardId: null, hasPulled: false });
const result = (patch: Partial<RelayResult> = {}): RelayResult => ({
  hash: `0x${'ab'.repeat(32)}`,
  status: 'success',
  latencyMs: 300,
  blockNumber: '100',
  events: {},
  ...patch,
});

function deps(over: Partial<Api> = {}) {
  const api: Api = {
    getConfig: vi.fn(() => Promise.resolve(config)),
    getAccount: vi.fn(() => Promise.resolve(acct(parseEther('5')))),
    fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'balance_ok' as const })),
    relay: vi.fn(() => Promise.resolve(result())),
    getCard: vi.fn(() => Promise.resolve(null)),
    challengeAgent: vi.fn(() => Promise.resolve({ ok: true as const })),
    getStake: vi.fn(() => Promise.resolve(null)),
    ...over,
  };
  return { api, account, config, sleep: vi.fn(() => Promise.resolve()) };
}

const sentTxs = (d: ReturnType<typeof deps>) =>
  (d.api.relay as ReturnType<typeof vi.fn>).mock.calls.map((c) => parseTransaction(c[0] as Hex));

describe('stakeOnDuel', () => {
  it('sends stake(duelId) to the vault with the stake as value and the configured gas', async () => {
    const d = deps();
    await stakeOnDuel(d, '7', AMOUNT);
    const [tx] = sentTxs(d);
    expect(tx?.to?.toLowerCase()).toBe(VAULT);
    expect(tx?.value).toBe(AMOUNT);
    expect(tx?.gas).toBe(131000n);
    expect(decodeFunctionData({ abi: stakeVaultAbi, data: tx?.data ?? '0x' })).toMatchObject({
      functionName: 'stake',
      args: [7n],
    });
  });

  it('tops up to stake + 0.1 MON, waits out the 1,500 ms gap, then stakes', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '9000', setItem: () => undefined });
    const order: string[] = [];
    const d = {
      ...deps({
        getAccount: vi.fn(() => Promise.resolve(acct(AMOUNT + MIN_FUND_WEI - 1n))),
        fund: vi.fn(() => {
          order.push('fund');
          return Promise.resolve({ funded: true as const });
        }),
        relay: vi.fn(() => {
          order.push('relay');
          return Promise.resolve(result());
        }),
      }),
      now: () => 9400,
    };
    d.sleep.mockImplementation(((ms: number) => {
      order.push(`sleep:${ms}`);
      return Promise.resolve();
    }) as () => Promise<void>);
    // The account stays short after funding, so this one must fail before any tx.
    await expect(stakeOnDuel(d, '7', AMOUNT)).rejects.toBeInstanceOf(StakeFundsError);
    expect(order).toEqual(['fund', 'sleep:1500']);
    expect(d.api.relay).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('waits the remaining gap before the value tx', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '9000', setItem: () => undefined });
    const d = { ...deps(), now: () => 9400 };
    await stakeOnDuel(d, '7', AMOUNT);
    expect(d.sleep).toHaveBeenCalledWith(1100);
    vi.unstubAllGlobals();
  });

  it('reports a short balance when the faucet refuses', async () => {
    const d = deps({
      getAccount: vi.fn(() => Promise.resolve(acct(AMOUNT))),
      fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'budget' as const })),
    });
    await expect(stakeOnDuel(d, '7', AMOUNT)).rejects.toBeInstanceOf(StakeFundsError);
    expect(d.api.relay).not.toHaveBeenCalled();
  });

  it('keeps FundError(disabled)', async () => {
    const d = deps({
      getAccount: vi.fn(() => Promise.resolve(acct(0n))),
      fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'disabled' as const })),
    });
    await expect(stakeOnDuel(d, '7', AMOUNT)).rejects.toBeInstanceOf(FundError);
  });

  it('throws RevertedError(stake) on a revert', async () => {
    const d = deps({ relay: vi.fn(() => Promise.resolve(result({ status: 'reverted' }))) });
    await expect(stakeOnDuel(d, '7', AMOUNT)).rejects.toBeInstanceOf(RevertedError);
    await expect(stakeOnDuel(d, '7', AMOUNT)).rejects.toMatchObject({ fn: 'stake' });
  });
});

describe('joinAndStake', () => {
  it('checks funds for stake + 0.1 MON before the join', async () => {
    const d = deps({ getAccount: vi.fn(() => Promise.resolve(acct(AMOUNT))), fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'limit_ip' as const })) });
    await expect(joinAndStake(d, '3', '9', AMOUNT)).rejects.toBeInstanceOf(StakeFundsError);
    expect(d.api.relay).not.toHaveBeenCalled();
  });

  it('joins first, waits at least 1,500 ms, then stakes with value', async () => {
    const order: string[] = [];
    vi.stubGlobal('localStorage', { getItem: () => undefined, setItem: () => undefined });
    const d = deps({
      relay: vi.fn((raw: Hex) => {
        const tx = parseTransaction(raw);
        order.push(tx.value ? 'stake' : 'join');
        return Promise.resolve(result());
      }),
    });
    // Right after the join the last-tx stamp is "now", so the gap is the full 1,500 ms.
    vi.stubGlobal('localStorage', { getItem: () => String(1000), setItem: () => undefined });
    const withNow = { ...d, now: () => 1000 };
    d.sleep.mockImplementation(((ms: number) => {
      order.push(`sleep:${ms}`);
      return Promise.resolve();
    }) as () => Promise<void>);
    const res = await joinAndStake(withNow, '3', '9', AMOUNT);
    expect(res).toMatchObject({ joined: true, staked: true });
    expect(order).toEqual(['join', 'sleep:1500', 'stake']);
    expect(sentTxs(d)[0]?.to?.toLowerCase()).toBe(config.contracts.arena);
    expect(sentTxs(d)[1]?.value).toBe(AMOUNT);
    vi.unstubAllGlobals();
  });

  it('reports a reverted join without staking', async () => {
    const d = deps({ relay: vi.fn(() => Promise.resolve(result({ status: 'reverted' }))) });
    await expect(joinAndStake(d, '3', '9', AMOUNT)).resolves.toEqual({ joined: false });
    expect(d.api.relay).toHaveBeenCalledTimes(1);
  });

  it('keeps the join when the stake reverts', async () => {
    let n = 0;
    const d = deps({
      relay: vi.fn(() => Promise.resolve(result({ status: ++n === 1 ? 'success' : 'reverted' }))),
    });
    const res = await joinAndStake(d, '3', '9', AMOUNT);
    expect(res).toMatchObject({ joined: true, staked: false });
    expect((res as { error: unknown }).error).toMatchObject({ fn: 'stake' });
  });
});

describe('claimStake', () => {
  it('sends claim(duelId) with value 0 and the claim gas limit', async () => {
    const d = deps();
    await claimStake(d, '7');
    const [tx] = sentTxs(d);
    expect(tx?.to?.toLowerCase()).toBe(VAULT);
    expect(tx?.value ?? 0n).toBe(0n);
    expect(tx?.gas).toBe(154000n);
    expect(decodeFunctionData({ abi: stakeVaultAbi, data: tx?.data ?? '0x' })).toMatchObject({
      functionName: 'claim',
      args: [7n],
    });
  });

  it('throws RevertedError(claim) on a revert', async () => {
    const d = deps({ relay: vi.fn(() => Promise.resolve(result({ status: 'reverted' }))) });
    await expect(claimStake(d, '7')).rejects.toMatchObject({ fn: 'claim' });
  });
});

describe('stake errors', () => {
  it('maps reverted stake and claim', () => {
    expect(friendlyError({ kind: 'reverted', fn: 'stake' })).toBe('Staking closed for this duel.');
    expect(friendlyError({ kind: 'reverted', fn: 'claim' })).toBe("The result isn't final yet. Try again in a moment.");
  });
  it('maps thrown stake errors', () => {
    expect(toFriendly(new RevertedError('stake'), { fn: 'stake' })).toBe('Staking closed for this duel.');
    expect(toFriendly(new StakeFundsError(), { fn: 'stake' })).toBe('Not enough test MON to stake.');
    expect(toFriendly(new MaybeLandedError('stake'), { fn: 'stake' })).toBe(
      'That may have gone through. Check your card and try again.',
    );
  });
});

describe('getStake over HTTP', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const view: StakeView = { amount: AMOUNT, p1Staked: true, p2Staked: false, claimed: false };

  it('reads the vault named by /config through the injected reader', async () => {
    const fetchFn = vi.fn(async () => json(config)) as unknown as typeof fetch;
    const read = vi.fn(async () => view);
    const api = createHttpApi('', fetchFn, read);
    await expect(api.getStake('5')).resolves.toEqual(view);
    await api.getStake('6');
    expect(read).toHaveBeenNthCalledWith(1, VAULT, '5');
    expect(read).toHaveBeenNthCalledWith(2, VAULT, '6');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('is null when /config has no vault', async () => {
    const { stakeVault: _unused, ...contracts } = config.contracts;
    void _unused;
    const fetchFn = vi.fn(async () => json({ ...config, contracts })) as unknown as typeof fetch;
    const read = vi.fn();
    await expect(createHttpApi('', fetchFn, read).getStake('5')).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('lets reader errors through so the caller retries on its next trigger', async () => {
    const fetchFn = vi.fn(async () => json(config)) as unknown as typeof fetch;
    const read = vi.fn().mockRejectedValue(new Error('rpc down'));
    await expect(createHttpApi('', fetchFn, read).getStake('5')).rejects.toThrow('rpc down');
  });
});

describe('parseStakeTuple', () => {
  it('maps the stakes() tuple', () => {
    expect(parseStakeTuple([AMOUNT, 100, true, false, false])).toEqual({
      amount: AMOUNT,
      p1Staked: true,
      p2Staked: false,
      claimed: false,
    });
  });
});
