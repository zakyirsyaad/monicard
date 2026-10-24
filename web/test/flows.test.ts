import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTransaction } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { FundError, MIN_FUND_WEI, RevertedError } from '../src/lib/actions';
import { InsufficientFundsError, pullCard, startDuel } from '../src/lib/flows';
import type { Account, Api, Config, RelayResult } from '../src/lib/types';

const config = {
  chainId: 10143,
  contracts: {
    cards: '0x1111111111111111111111111111111111111111',
    arena: '0x2222222222222222222222222222222222222222',
  },
  gasLimits: { freePull: 4, paidPull: 5, createDuel: 6, joinDuel: 7, attack: 1, settle: 1 },
  gasPrice: '50000000000',
  batchMs: 1000,
  pullPrice: '50000000000000000',
  event: { name: 'Test', sponsor: null },
  agent: '0x3333333333333333333333333333333333333333',
  bots: [],
} satisfies Config;

const PRICE = BigInt(config.pullPrice);
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
    getAccount: vi.fn(() => Promise.resolve(acct(MIN_FUND_WEI * 10n))),
    fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'balance_ok' as const })),
    relay: vi.fn(() => Promise.resolve(result({ events: { tokenId: '12', duelId: '34' } }))),
    getCard: vi.fn(() => Promise.resolve(null)),
    challengeAgent: vi.fn(() => Promise.resolve({ ok: true as const })),
    getStake: vi.fn(() => Promise.resolve(null)),
    ...over,
  };
  return { api, account, config, sleep: vi.fn(() => Promise.resolve()) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pullCard', () => {
  it('free pull returns the minted token id', async () => {
    const d = deps();
    await expect(pullCard(d, { paid: false })).resolves.toBe('12');
    expect(parseTransaction((d.api.relay as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Hex).value ?? 0n).toBe(0n);
  });

  it('paid pull sends the pull price', async () => {
    const d = deps();
    await pullCard(d, { paid: true });
    const tx = parseTransaction((d.api.relay as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Hex);
    expect(tx.value).toBe(PRICE);
  });

  it('paid pull needs the price plus 0.1 MON, otherwise says the balance is short', async () => {
    const d = deps({ getAccount: vi.fn(() => Promise.resolve(acct(PRICE + MIN_FUND_WEI - 1n))) });
    await expect(pullCard(d, { paid: true })).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(d.api.relay).not.toHaveBeenCalled();
  });

  it('waits out the 3-block gap before a paid pull', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '9000', setItem: () => undefined });
    const d = { ...deps(), now: () => 9400 };
    await pullCard(d, { paid: true });
    expect(d.sleep).toHaveBeenCalledWith(1100);
  });

  it('does not wait when the last tx is old enough', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '1000', setItem: () => undefined });
    const d = { ...deps(), now: () => 9400 };
    await pullCard(d, { paid: true });
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it.each(['limit_address', 'limit_ip', 'budget'] as const)(
    'reports a short balance when a paid pull is refused funding (%s)',
    async (reason) => {
      const d = deps({
        getAccount: vi.fn(() => Promise.resolve(acct(PRICE))),
        fund: vi.fn(() => Promise.resolve({ funded: false, reason })),
      });
      await expect(pullCard(d, { paid: true })).rejects.toBeInstanceOf(InsufficientFundsError);
    },
  );

  it('keeps FundError(disabled) for a paid pull', async () => {
    const d = deps({
      getAccount: vi.fn(() => Promise.resolve(acct(PRICE))),
      fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'disabled' as const })),
    });
    await expect(pullCard(d, { paid: true })).rejects.toBeInstanceOf(FundError);
  });

  it('throws RevertedError for a reverted free pull', async () => {
    const d = deps({ relay: vi.fn(() => Promise.resolve(result({ status: 'reverted' }))) });
    const err = await pullCard(d, { paid: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevertedError);
    expect(err).toMatchObject({ fn: 'freePull' });
  });

  it('surfaces FundError when funding is off', async () => {
    const d = deps({
      getAccount: vi.fn(() => Promise.resolve(acct(0n))),
      fund: vi.fn(() => Promise.resolve({ funded: false, reason: 'disabled' as const })),
    });
    await expect(pullCard(d, { paid: false })).rejects.toBeInstanceOf(FundError);
  });

  it('throws when the receipt has no token id', async () => {
    const d = deps({ relay: vi.fn(() => Promise.resolve(result())) });
    await expect(pullCard(d, { paid: false })).rejects.toThrow(/token/i);
  });
});

describe('startDuel', () => {
  it('funds, creates the duel and returns its id', async () => {
    const d = deps();
    await expect(startDuel(d, '12')).resolves.toBe('34');
  });

  it('throws RevertedError(createDuel) on a revert', async () => {
    const d = deps({ relay: vi.fn(() => Promise.resolve(result({ status: 'reverted' }))) });
    await expect(startDuel(d, '12')).rejects.toMatchObject({ fn: 'createDuel' });
  });
});
