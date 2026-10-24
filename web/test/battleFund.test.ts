import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MIN_FUND_WEI } from '../src/lib/actions';
import { battleErrorText } from '../src/lib/battle/errors';
import { BATTLE_MIN_WEI, ensureBattleWallet } from '../src/lib/battle/fund';
import { FundError } from '../src/lib/actions';
import type { Account, Api, Config, FundResult } from '../src/lib/types';

const config = {
  chainId: 10143,
  contracts: {
    cards: '0x1111111111111111111111111111111111111111',
    arena: '0x2222222222222222222222222222222222222222',
  },
  gasLimits: { freePull: 1, paidPull: 1, createDuel: 1, joinDuel: 1, attack: 1, settle: 1 },
  gasPrice: '50000000000',
  batchMs: 1000,
  pullPrice: '50000000000000000',
  event: { name: 'Test', sponsor: null },
  agent: '0x3333333333333333333333333333333333333333',
  bots: [],
} satisfies Config;

const account = privateKeyToAccount(generatePrivateKey());
const acct = (balance: bigint): Account => ({ nonce: 0, balance: balance.toString(), cardId: null, hasPulled: false });

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    getConfig: vi.fn(() => Promise.resolve(config)),
    getAccount: vi.fn(() => Promise.resolve(acct(MIN_FUND_WEI))),
    fund: vi.fn((): Promise<FundResult> => Promise.resolve({ funded: false, reason: 'balance_ok' })),
    relay: vi.fn(),
    getCard: vi.fn(() => Promise.resolve(null)),
    challengeAgent: vi.fn(() => Promise.resolve({ ok: true as const })),
    getStake: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureBattleWallet', () => {
  it('tops up a burner under 0.03 MON and waits out the N9 settle window', async () => {
    const getAccount = vi
      .fn<Api['getAccount']>()
      .mockResolvedValueOnce(acct(0n))
      .mockResolvedValueOnce(acct(MIN_FUND_WEI));
    const fund = vi.fn<Api['fund']>(() => Promise.resolve({ funded: true, txHash: `0x${'cd'.repeat(32)}` }));
    const sleep = vi.fn(() => Promise.resolve());
    const steps: string[] = [];

    await ensureBattleWallet({ api: makeApi({ getAccount, fund }), account, config, sleep }, (step) =>
      steps.push(step),
    );

    expect(BATTLE_MIN_WEI).toBe(30_000_000_000_000_000n);
    expect(fund).toHaveBeenCalledWith(account.address);
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(steps).toEqual(['wallet', 'send']);
  });

  it('skips /fund when the burner already has 0.03 MON', async () => {
    const fund = vi.fn<Api['fund']>(() => Promise.resolve({ funded: true }));
    const sleep = vi.fn(() => Promise.resolve());
    await ensureBattleWallet({ api: makeApi({ fund }), account, config, sleep });
    expect(fund).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['limit_address', 'limit_ip', 'budget'] as const)('keeps FundError(%s) for the UI', async (reason) => {
    const api = makeApi({
      getAccount: vi.fn(() => Promise.resolve(acct(0n))),
      fund: vi.fn(() => Promise.resolve({ funded: false, reason })),
    });
    const err = await ensureBattleWallet({ api, account, config, sleep: vi.fn() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FundError);
    expect((err as FundError).reason).toBe(reason);
  });
});

describe('battleErrorText', () => {
  it('explains a spent event budget', () => {
    expect(battleErrorText(new FundError('budget'), { fn: 'act' })).toMatch(/budget/i);
  });

  it('explains the per-address top-up limit', () => {
    expect(battleErrorText(new FundError('limit_address'), { fn: 'joinMatch' })).toMatch(/this wallet/i);
  });

  it('falls back to the shared action mapping', () => {
    expect(battleErrorText(new Error('boom'), { fn: 'act' })).toBe("That didn't go through. Try again.");
  });
});