import { beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { BURNER_KEY, loadOrCreateBurner, resetBurnerCache } from '../src/lib/burner';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

const VALID = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

beforeEach(() => resetBurnerCache());

describe('loadOrCreateBurner', () => {
  it('uses the storage key nad.burner', () => {
    expect(BURNER_KEY).toBe('nad.burner');
  });

  it('creates and persists a key when storage is empty', () => {
    const s = fakeStorage();
    const acct = loadOrCreateBurner(s);
    const stored = s.data.get('nad.burner');
    expect(stored).toMatch(/^0x[0-9a-f]{64}$/);
    expect(privateKeyToAccount(stored as `0x${string}`).address).toBe(acct.address);
  });

  it('reloads the same key from storage', () => {
    const s = fakeStorage({ 'nad.burner': VALID });
    const acct = loadOrCreateBurner(s);
    expect(acct.address).toBe(privateKeyToAccount(VALID).address);
    expect(s.data.get('nad.burner')).toBe(VALID);
  });

  it('replaces an invalid stored value', () => {
    for (const bad of ['garbage', '0x1234', VALID.slice(0, -1) + 'z', VALID.slice(2)]) {
      resetBurnerCache();
      const s = fakeStorage({ 'nad.burner': bad });
      loadOrCreateBurner(s);
      const stored = s.data.get('nad.burner');
      expect(stored).not.toBe(bad);
      expect(stored).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('survives throwing storage with an in-memory key', () => {
    const a = loadOrCreateBurner(throwing);
    const b = loadOrCreateBurner(throwing);
    expect(a.address).toBe(b.address);
  });

  it('memoizes repeated calls', () => {
    const s = fakeStorage();
    const a = loadOrCreateBurner(s);
    const b = loadOrCreateBurner(s);
    expect(b).toBe(a);
  });
});
