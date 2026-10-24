import { describe, expect, test } from 'vitest';
import { parseDeployment } from '../src/env';

const CARDS = '0x7AF33CB3823Ff99D37411A678452A7980d14CF9F';
const ARENA = '0xc08c323df6a5f9fAbaF75A6060E4CA357F2251f9';
const VAULT = '0x642C1364b62344128087549ceeD9268D5E3385df';
const ZERO = `0x${'0'.repeat(40)}`;
const GAS = {
  freePull: 189_000,
  paidPull: 189_000,
  createDuel: 122_000,
  joinDuel: 137_000,
  attack: 62_000,
  settle: 107_000,
};

const base = {
  chainId: 10143,
  cards: CARDS,
  arena: ARENA,
  deployBlock: 73719179,
  gasLimits: GAS,
};

describe('parseDeployment', () => {
  test('keeps stakeVault optional', () => {
    expect(parseDeployment(base).stakeVault).toBeUndefined();
  });

  test('accepts a non-zero stakeVault address', () => {
    expect(parseDeployment({ ...base, stakeVault: VAULT }).stakeVault).toBe(VAULT);
  });

  test('rejects the zero stakeVault address', () => {
    expect(() => parseDeployment({ ...base, stakeVault: ZERO })).toThrow(/zero address/i);
  });

  test('keeps optional stake and claim gas limits', () => {
    const parsed = parseDeployment({
      ...base,
      gasLimits: { ...GAS, stake: 131_000, claim: 154_000 },
    });
    expect(parsed.gasLimits.stake).toBe(131_000);
    expect(parsed.gasLimits.claim).toBe(154_000);
  });
});