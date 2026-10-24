import { describe, expect, it } from 'vitest';
import {
  EXPLORER,
  explorerAddress,
  explorerTx,
  formatBlock,
  formatInt,
  formatMs,
  formatMon,
  formatRecord,
  shortHex,
} from '../src/lib/format';

describe('formatInt', () => {
  it('adds en-US thousands commas to numbers', () => {
    expect(formatInt(1950)).toBe('1,950');
    expect(formatInt(0)).toBe('0');
    expect(formatInt(999)).toBe('999');
  });
  it('handles bigint and numeric strings', () => {
    expect(formatInt(73562481n)).toBe('73,562,481');
    expect(formatInt('1234567')).toBe('1,234,567');
  });
  it('handles bigints beyond Number safe range', () => {
    expect(formatInt(12345678901234567890n)).toBe('12,345,678,901,234,567,890');
  });
});

describe('formatInt with invalid input', () => {
  it('returns non-integer strings as-is instead of throwing', () => {
    expect(formatInt('abc')).toBe('abc');
    expect(formatInt('1.5')).toBe('1.5');
    expect(formatInt('')).toBe('');
  });
  it('shows an em dash for NaN', () => {
    expect(formatInt(NaN)).toBe('—');
  });
});

describe('formatMs', () => {
  it('appends the ms unit', () => {
    expect(formatMs(312)).toBe('312 ms');
  });
  it('uses thousands commas, never seconds', () => {
    expect(formatMs(1240)).toBe('1,240 ms');
  });
  it('rounds to an integer', () => {
    expect(formatMs(311.6)).toBe('312 ms');
  });
});

describe('formatBlock', () => {
  it('prefixes # and adds commas', () => {
    expect(formatBlock(73562481)).toBe('#73,562,481');
    expect(formatBlock(73562481n)).toBe('#73,562,481');
  });
});

describe('shortHex', () => {
  it('keeps first 4 chars and last 2, preserving case', () => {
    expect(shortHex('0xAbCdEf0012')).toBe('0xAb…12');
  });
  it('returns short strings unchanged', () => {
    expect(shortHex('0xAb12')).toBe('0xAb12');
  });
});

describe('explorer links', () => {
  it('points at MonadScan testnet', () => {
    expect(EXPLORER).toBe('https://testnet.monadscan.com');
    expect(explorerTx('0xabc')).toBe('https://testnet.monadscan.com/tx/0xabc');
    expect(explorerAddress('0xdef')).toBe('https://testnet.monadscan.com/address/0xdef');
  });
});

describe('formatRecord', () => {
  it('formats wins and losses', () => {
    expect(formatRecord(12, 4)).toBe('12 W · 4 L');
  });
});

describe('formatMon', () => {
  it('drops trailing zeros', () => {
    expect(formatMon('50000000000000000')).toBe('0.05');
    expect(formatMon(1_000_000_000_000_000_000n)).toBe('1');
  });
});
