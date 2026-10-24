import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FundError } from '../src/lib/actions';
import { actBattle, claimBattleTimeout, createBattle, joinBattle } from '../src/lib/battle/actions';
import { BATTLE_MIN_WEI } from '../src/lib/battle/fund';
import type { ActionDeps } from '../src/lib/actions';
import type { Config, RelayResult } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  ensureFunds: vi.fn(),
  sendCall: vi.fn(),
  actionDeps: vi.fn(),
  account: { address: '0x00000000000000000000000000000000000000aa' },
}));

vi.mock('../src/lib/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/actions')>();
  return { ...actual, ensureFunds: mocks.ensureFunds, sendCall: mocks.sendCall };
});

vi.mock('../src/lib/player', () => ({ actionDeps: mocks.actionDeps }));

const config = {
  chainId: 10143,
  contracts: {
    cards: '0x1111111111111111111111111111111111111111',
    arena: '0x2222222222222222222222222222222222222222',
    battle: '0x4444444444444444444444444444444444444444',
  },
  gasLimits: { freePull: 1, paidPull: 1, createDuel: 1, joinDuel: 1, attack: 1, settle: 1 },
  gasPrice: '50000000000',
  batchMs: 1000,
  pullPrice: '50000000000000000',
  event: { name: 'Test', sponsor: null },
  agent: '0x3333333333333333333333333333333333333333',
  bots: [],
} as unknown as Config;

const result = {
  hash: `0x${'ab'.repeat(32)}`,
  status: 'success',
  latencyMs: 0,
  blockNumber: '1',
  events: { matchId: '9' },
} as unknown as RelayResult;

const deps = { api: {}, account: mocks.account, config, sleep: vi.fn() } as unknown as ActionDeps;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actionDeps.mockReturnValue(deps);
  mocks.ensureFunds.mockResolvedValue({});
  mocks.sendCall.mockResolvedValue(result);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function expectFundedBeforeSend(): void {
  expect(mocks.ensureFunds).toHaveBeenCalledWith(deps, mocks.account.address, BATTLE_MIN_WEI);
  expect(mocks.ensureFunds.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
    mocks.sendCall.mock.invocationCallOrder[0] ?? 0,
  );
}

describe('battle actions fund the burner first', () => {
  it('createMatch', async () => {
    const steps: string[] = [];
    await expect(createBattle(config, (step) => steps.push(step))).resolves.toMatchObject({ id: '9' });
    expectFundedBeforeSend();
    expect(steps).toEqual(['wallet', 'send']);
  });

  it('joinMatch', async () => {
    await expect(joinBattle(config, '9')).resolves.toBe(result);
    expectFundedBeforeSend();
  });

  it('act', async () => {
    await expect(actBattle(config, '9', 255, false)).resolves.toBe(result);
    expectFundedBeforeSend();
  });

  it('claimTimeout', async () => {
    await expect(claimBattleTimeout(config, '9')).resolves.toBe(result);
    expectFundedBeforeSend();
  });

  it('does not send the tx when /fund is refused', async () => {
    mocks.ensureFunds.mockRejectedValue(new FundError('budget'));
    await expect(actBattle(config, '9', 255, false)).rejects.toBeInstanceOf(FundError);
    expect(mocks.sendCall).not.toHaveBeenCalled();
  });

  it('skips funding entirely in mock mode', async () => {
    vi.stubEnv('VITE_USE_MOCK', '1');
    await createBattle(config);
    expect(mocks.ensureFunds).not.toHaveBeenCalled();
  });
});