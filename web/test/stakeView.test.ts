import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import type { Hex } from 'viem';
import {
  canStake,
  formatMon,
  hasStake,
  potWei,
  stakeEnabled,
  stakeOutcome,
  winnerPayoutWei,
} from '../src/lib/stakeView';
import type { Config, DuelView, StakeView } from '../src/lib/types';

const P1: Hex = '0xAbCd000000000000000000000000000000000001';
const P2: Hex = '0xabcd000000000000000000000000000000000002';
const OTHER: Hex = '0x9999000000000000000000000000000000000003';
const VAULT: Hex = '0x7777777777777777777777777777777777777777';

const CONFIG: Config = {
  chainId: 10143,
  contracts: { cards: P1, arena: P2, stakeVault: VAULT },
  gasLimits: { freePull: 1, paidPull: 1, createDuel: 1, joinDuel: 1, attack: 1, settle: 1, stake: 131000, claim: 154000 },
  gasPrice: '1',
  batchMs: 1000,
  pullPrice: '1',
  event: { name: 'T', sponsor: null },
  agent: OTHER,
  bots: [],
};

const DUEL: DuelView = {
  id: '4',
  p1: P1,
  p2: P2,
  hp1: 1500,
  hp2: 1200,
  atk1: 12,
  atk2: 14,
  mult1: 100,
  mult2: 100,
  lastBlock1: 110,
  lastBlock2: 110,
  skill1: false,
  skill2: false,
  status: 'Active',
  startBlock: 110,
  endBlock: 177,
  card1: 7,
  card2: 9,
  maxHp1: 1600,
  maxHp2: 1700,
  settled: false,
};

const OPEN: DuelView = { ...DUEL, p2: '0x0000000000000000000000000000000000000000', status: 'Open', startBlock: 0, endBlock: 0 };
const AMOUNT = parseEther('0.05');
const NONE: StakeView = { amount: 0n, p1Staked: false, p2Staked: false, claimed: false };
const P1_ONLY: StakeView = { ...NONE, amount: AMOUNT, p1Staked: true };
const BOTH: StakeView = { ...NONE, amount: AMOUNT, p1Staked: true, p2Staked: true };

describe('stakeEnabled', () => {
  it('needs the vault address and both gas limits', () => {
    expect(stakeEnabled(CONFIG)).toBe(true);
    expect(stakeEnabled(null)).toBe(false);
    expect(stakeEnabled({ ...CONFIG, contracts: { cards: P1, arena: P2 } })).toBe(false);
    expect(stakeEnabled({ ...CONFIG, gasLimits: { ...CONFIG.gasLimits, stake: undefined } })).toBe(false);
    expect(stakeEnabled({ ...CONFIG, gasLimits: { ...CONFIG.gasLimits, claim: undefined } })).toBe(false);
  });
});

describe('canStake', () => {
  it('lets p1 stake on an open duel', () => {
    expect(canStake(OPEN, 100, P1, NONE)).toBe(true);
    expect(canStake(OPEN, 100, P1, null)).toBe(true);
  });
  it('blocks someone who is not on the duel', () => {
    expect(canStake(DUEL, 100, OTHER, NONE)).toBe(false);
    expect(canStake(OPEN, 100, P2, NONE)).toBe(false);
  });
  it('lets p2 stake only during the countdown', () => {
    expect(canStake(DUEL, 109, P2, P1_ONLY)).toBe(true);
    expect(canStake(DUEL, 110, P2, P1_ONLY)).toBe(false);
  });
  it('blocks a side that already staked, a claimed stake and a finished duel', () => {
    expect(canStake(OPEN, 100, P1, P1_ONLY)).toBe(false);
    expect(canStake(DUEL, 109, P2, BOTH)).toBe(false);
    expect(canStake(DUEL, 109, P2, { ...P1_ONLY, claimed: true })).toBe(false);
    expect(canStake({ ...DUEL, status: 'P1Won' }, 100, P2, P1_ONLY)).toBe(false);
  });
});

describe('potWei and hasStake', () => {
  it('has a pot only when both sides staked', () => {
    expect(potWei(BOTH)).toBe(2n * AMOUNT);
    expect(potWei(P1_ONLY)).toBe(0n);
    expect(potWei(NONE)).toBe(0n);
    expect(potWei(null)).toBe(0n);
  });
  it('hasStake is true when anyone staked', () => {
    expect(hasStake(NONE)).toBe(false);
    expect(hasStake(null)).toBe(false);
    expect(hasStake(P1_ONLY)).toBe(true);
  });
});

describe('winnerPayoutWei', () => {
  it('is twice the stake minus a 5% rake', () => {
    expect(winnerPayoutWei(parseEther('0.05'))).toBe(parseEther('0.095'));
    expect(winnerPayoutWei(parseEther('1'))).toBe(parseEther('1.9'));
  });
  it('floors the rake like the contract', () => {
    // pot 2 * 7 = 14, rake floor(14 * 500 / 10000) = 0
    expect(winnerPayoutWei(7n)).toBe(14n);
    // pot 2 * 333 = 666, rake floor(33.3) = 33
    expect(winnerPayoutWei(333n)).toBe(633n);
  });
});

describe('stakeOutcome', () => {
  const won1: DuelView = { ...DUEL, status: 'P1Won' };
  it('is none without a stake or before the duel is final', () => {
    expect(stakeOutcome(won1, P1, NONE)).toBe('none');
    expect(stakeOutcome(won1, P1, null)).toBe('none');
    expect(stakeOutcome(DUEL, P1, BOTH)).toBe('none');
  });
  it('is win or lose when both staked and the result is decisive', () => {
    expect(stakeOutcome(won1, P1, BOTH)).toBe('win');
    expect(stakeOutcome(won1, P2, BOTH)).toBe('lose');
    expect(stakeOutcome({ ...DUEL, status: 'P2Won' }, P2, BOTH)).toBe('win');
  });
  it('refunds a draw and an unmatched stake', () => {
    expect(stakeOutcome({ ...DUEL, status: 'Draw' }, P1, BOTH)).toBe('refund');
    expect(stakeOutcome(won1, P1, P1_ONLY)).toBe('refund');
    expect(stakeOutcome(won1, P2, P1_ONLY)).toBe('refund');
  });
  it('is none for a bystander', () => {
    expect(stakeOutcome(won1, OTHER, BOTH)).toBe('none');
  });
});

describe('formatMon', () => {
  it('trims trailing zeros', () => {
    expect(formatMon(AMOUNT)).toBe('0.05');
    expect(formatMon(parseEther('0.095'))).toBe('0.095');
    expect(formatMon(parseEther('1'))).toBe('1');
  });
});
