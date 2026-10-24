import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEther, type Hex, type TransactionReceipt } from 'viem';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { clientIp } from '../src/clientIp';
import {
  createFundLimiter,
  handleFund,
  isFundEnabled,
  setFundEnabled,
  FUND_AMOUNT_WEI,
  FUND_THRESHOLD_WEI,
  type FundDeps,
  type FundLimiter,
} from '../src/fund';

const ADDR = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;
const TEN_MIN = 600_000;
const T0 = 1_700_000_000_000;
const MON = (v: string) => parseEther(v);
// confirm time far enough in the past that the post-confirm cooldown has already elapsed
const CONFIRMED_LONG_AGO = T0 - 10_000;

let dir: string;
let ledgerPath: string;

function makeLimiter(over: Partial<Parameters<typeof createFundLimiter>[0]> = {}): FundLimiter {
  return createFundLimiter({
    amountWei: FUND_AMOUNT_WEI,
    thresholdWei: FUND_THRESHOLD_WEI,
    maxPerAddress: 3,
    maxPerIpPer10Min: 10,
    budgetWei: MON('3'),
    ledgerPath,
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fund-test-'));
  ledgerPath = join(dir, 'fund.json');
  setFundEnabled(false);
});

describe('createFundLimiter', () => {
  test('funds a fresh address', () => {
    const l = makeLimiter();
    const r = l.reserve({ address: ADDR(1), ip: '1.1.1.1', balanceWei: 0n, now: T0 });
    expect(r).toMatchObject({ fund: true });
  });

  test('skips when balance above threshold', () => {
    const l = makeLimiter();
    const r = l.reserve({ address: ADDR(1), ip: '1.1.1.1', balanceWei: MON('0.2'), now: T0 });
    expect(r).toEqual({ fund: false, reason: 'balance_ok' });
    expect(l.spentWei()).toBe(0n);
  });

  test('stops after 3 fundings per address', () => {
    const l = makeLimiter();
    for (let i = 0; i < 3; i++) {
      const r = l.reserve({ address: ADDR(1), ip: '1.1.1.1', balanceWei: 0n, now: T0 + i });
      expect(r).toMatchObject({ fund: true });
      if (r.fund) r.confirm(CONFIRMED_LONG_AGO);
    }
    const r = l.reserve({ address: ADDR(1), ip: '1.1.1.1', balanceWei: 0n, now: T0 + 10 });
    expect(r).toEqual({ fund: false, reason: 'limit_address' });
  });

  test('compares addresses case-insensitively', () => {
    const l = makeLimiter({ maxPerAddress: 1 });
    const lower = '0x00000000000000000000000000000000000000ab' as Hex;
    const upper = '0x00000000000000000000000000000000000000AB' as Hex;
    const first = l.reserve({ address: lower, ip: 'a', balanceWei: 0n, now: T0 });
    if (first.fund) first.confirm(CONFIRMED_LONG_AGO);
    expect(l.reserve({ address: upper, ip: 'b', balanceWei: 0n, now: T0 + 1 })).toEqual({
      fund: false,
      reason: 'limit_address',
    });
  });

  test('limits 10 per ip per 10 minutes, resets after window', () => {
    const l = makeLimiter({ budgetWei: MON('100') });
    for (let i = 0; i < 10; i++) {
      const r = l.reserve({ address: ADDR(i + 1), ip: '9.9.9.9', balanceWei: 0n, now: T0 + i });
      expect(r).toMatchObject({ fund: true });
      if (r.fund) r.confirm(CONFIRMED_LONG_AGO);
    }
    expect(l.reserve({ address: ADDR(50), ip: '9.9.9.9', balanceWei: 0n, now: T0 + 100 })).toEqual({
      fund: false,
      reason: 'limit_ip',
    });
    // other ip unaffected
    expect(l.reserve({ address: ADDR(51), ip: '8.8.8.8', balanceWei: 0n, now: T0 + 100 })).toMatchObject({ fund: true });
    // after the window it resets
    const later = l.reserve({ address: ADDR(52), ip: '9.9.9.9', balanceWei: 0n, now: T0 + TEN_MIN + 20 });
    expect(later).toMatchObject({ fund: true });
  });

  test('stops when budget exhausted', () => {
    const l = makeLimiter({ maxPerIpPer10Min: 1000 });
    // budget 3 MON / FUND_AMOUNT_WEI 0.15 MON = 20 players
    for (let i = 0; i < 20; i++) {
      const r = l.reserve({ address: ADDR(i + 1), ip: `ip${i}`, balanceWei: 0n, now: T0 + i });
      expect(r).toMatchObject({ fund: true });
      if (r.fund) r.confirm(CONFIRMED_LONG_AGO);
    }
    expect(l.spentWei()).toBe(MON('3'));
    expect(l.reserve({ address: ADDR(99), ip: 'ipx', balanceWei: 0n, now: T0 + 50 })).toEqual({
      fund: false,
      reason: 'budget',
    });
  });

  test('parallel reservations for one address respect the cap', () => {
    const l = makeLimiter();
    const results = Array.from({ length: 5 }, () =>
      l.reserve({ address: ADDR(1), ip: '1.1.1.1', balanceWei: 0n, now: T0 }),
    );
    expect(results.filter((r) => r.fund)).toHaveLength(1);
    expect(results.filter((r) => !r.fund).every((r) => !r.fund && r.reason === 'balance_ok')).toBe(true);
  });

  test('release frees the slot and refunds budget', () => {
    const l = makeLimiter({ maxPerAddress: 1, maxPerIpPer10Min: 1 });
    const first = l.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 });
    expect(l.spentWei()).toBe(FUND_AMOUNT_WEI);
    if (first.fund) first.release();
    expect(l.spentWei()).toBe(0n);
    const second = l.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 + 1 });
    expect(second).toMatchObject({ fund: true });
  });

  test('confirm clears in-flight but keeps counts', () => {
    const l = makeLimiter({ maxPerAddress: 2 });
    const first = l.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 });
    if (first.fund) first.confirm(CONFIRMED_LONG_AGO);
    expect(l.spentWei()).toBe(FUND_AMOUNT_WEI);
    const second = l.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 + 1 });
    expect(second).toMatchObject({ fund: true });
    if (second.fund) second.confirm(CONFIRMED_LONG_AGO);
    expect(l.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 + 2 })).toEqual({
      fund: false,
      reason: 'limit_address',
    });
  });

  test('cooldown after confirm keeps reporting balance_ok for 5s, then allows again', () => {
    const l = makeLimiter({ maxPerAddress: 3 });
    const first = l.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 });
    if (first.fund) first.confirm(T0 + 100);
    const stale = { address: ADDR(1), ip: 'ip', balanceWei: 0n };
    expect(l.reserve({ ...stale, now: T0 + 4_000 })).toEqual({ fund: false, reason: 'balance_ok' });
    expect(l.reserve({ ...stale, now: T0 + 5_099 })).toEqual({ fund: false, reason: 'balance_ok' });
    expect(l.reserve({ ...stale, now: T0 + 5_100 })).toMatchObject({ fund: true });
    expect(l.spentWei()).toBe(FUND_AMOUNT_WEI * 2n);
  });

  test('release does not start a cooldown', () => {
    const l = makeLimiter();
    const first = l.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 });
    if (first.fund) first.release();
    expect(l.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 + 1 })).toMatchObject({ fund: true });
  });

  test('ledger survives restart', () => {
    const l1 = makeLimiter({ maxPerAddress: 1 });
    const r = l1.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 });
    if (r.fund) r.confirm(CONFIRMED_LONG_AGO);
    const l2 = makeLimiter({ maxPerAddress: 1 });
    expect(l2.spentWei()).toBe(FUND_AMOUNT_WEI);
    expect(l2.reserve({ address: ADDR(1), ip: 'ip', balanceWei: 0n, now: T0 + 5 })).toEqual({
      fund: false,
      reason: 'limit_address',
    });
    const saved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(saved.spentWei).toBe(FUND_AMOUNT_WEI.toString());
    expect(saved.perAddress[ADDR(1)]).toBe(1);
  });

  test('missing ledger file starts empty', () => {
    const l = makeLimiter({ ledgerPath: join(dir, 'nested', 'nope.json') });
    expect(l.spentWei()).toBe(0n);
  });

  test('corrupt ledger is renamed and limiter starts empty', () => {
    writeFileSync(ledgerPath, '{not json');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const l = makeLimiter();
    expect(l.spentWei()).toBe(0n);
    expect(existsSync(`${ledgerPath}.corrupt`)).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  test('old ip entries are pruned from the ledger on write', () => {
    const l = makeLimiter();
    const a = l.reserve({ address: ADDR(1), ip: 'old', balanceWei: 0n, now: T0 });
    if (a.fund) a.confirm(CONFIRMED_LONG_AGO);
    const b = l.reserve({ address: ADDR(2), ip: 'new', balanceWei: 0n, now: T0 + TEN_MIN + 1 });
    if (b.fund) b.confirm(CONFIRMED_LONG_AGO);
    const saved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(saved.ipLog.old).toBeUndefined();
    expect(saved.ipLog.new).toHaveLength(1);
  });
});

describe('fund enabled flag', () => {
  test('defaults false and toggles', () => {
    expect(isFundEnabled()).toBe(false);
    setFundEnabled(true);
    expect(isFundEnabled()).toBe(true);
  });
});

const OK_RECEIPT = { status: 'success' } as TransactionReceipt;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;

function makeDeps(over: Partial<FundDeps> = {}) {
  const send = vi.fn(async () => TX_HASH);
  const wait = vi.fn(async () => OK_RECEIPT);
  const getBalance = vi.fn(async () => 0n);
  const deps: FundDeps = {
    limiter: makeLimiter(),
    queue: { address: ADDR(0xaa), send },
    hub: { wait },
    getBalance,
    enabled: () => true,
    ...over,
  };
  return { deps, send, wait, getBalance };
}

describe('handleFund', () => {
  test('rejects a bad address with 400', async () => {
    const { deps } = makeDeps();
    for (const body of [{}, null, { address: 'nope' }, { address: 5 }, 'x']) {
      expect(await handleFund(body, '1.1.1.1', deps)).toEqual({
        status: 400,
        json: { funded: false, reason: 'address' },
      });
    }
  });

  test('returns disabled without touching chain', async () => {
    const { deps, getBalance, send } = makeDeps({ enabled: () => false });
    const r = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(r).toEqual({ status: 200, json: { funded: false, reason: 'disabled' } });
    expect(getBalance).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('defaults to the module-level flag when enabled dep is absent', async () => {
    const { deps } = makeDeps({ enabled: undefined });
    expect((await handleFund({ address: ADDR(1) }, 'ip', deps)).json).toEqual({ funded: false, reason: 'disabled' });
    setFundEnabled(true);
    expect((await handleFund({ address: ADDR(1) }, 'ip', deps)).json).toMatchObject({ funded: true });
  });

  test('passes balance_ok through', async () => {
    const { deps, send } = makeDeps({ getBalance: async () => MON('0.2') });
    const r = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(r).toEqual({ status: 200, json: { funded: false, reason: 'balance_ok' } });
    expect(send).not.toHaveBeenCalled();
  });

  test('success sends 0.3 MON and returns txHash', async () => {
    const { deps, send, wait } = makeDeps();
    const r = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(r).toEqual({ status: 200, json: { funded: true, txHash: TX_HASH } });
    expect(send).toHaveBeenCalledWith({ to: ADDR(1), data: '0x', gas: 21000n, value: FUND_AMOUNT_WEI });
    expect(wait).toHaveBeenCalledWith(TX_HASH, 20_000);
  });

  test('send throw returns 502 and releases the slot', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValue(TX_HASH);
    const { deps } = makeDeps({
      limiter: makeLimiter({ maxPerAddress: 1 }),
      queue: { address: ADDR(0xaa), send },
    });
    const first = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(first).toEqual({ status: 502, json: { funded: false, reason: 'send' } });
    expect(err).toHaveBeenCalledTimes(1);
    const second = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(second).toEqual({ status: 200, json: { funded: true, txHash: TX_HASH } });
    err.mockRestore();
  });

  test('reverted receipt returns 502 and releases', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const limiter = makeLimiter();
    const { deps } = makeDeps({
      limiter,
      hub: { wait: async () => ({ status: 'reverted' }) as TransactionReceipt },
    });
    const r = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(r).toEqual({ status: 502, json: { funded: false, reason: 'send' } });
    expect(limiter.spentWei()).toBe(0n);
    err.mockRestore();
  });

  test('receipt timeout keeps the charge and reports funded with txHash', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const limiter = makeLimiter();
    const { deps } = makeDeps({
      limiter,
      hub: {
        wait: async () => {
          throw new Error('timeout');
        },
      },
    });
    const r = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(r).toEqual({ status: 200, json: { funded: true, txHash: TX_HASH } });
    expect(limiter.spentWei()).toBe(FUND_AMOUNT_WEI);
    // retry right away must not fund again (cooldown + count kept)
    const again = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(again.json).toEqual({ funded: false, reason: 'balance_ok' });
    err.mockRestore();
  });

  test('immediate retry after success is balance_ok (stale balance cooldown)', async () => {
    const { deps, send } = makeDeps();
    await handleFund({ address: ADDR(1) }, 'ip', deps);
    const again = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(again.json).toEqual({ funded: false, reason: 'balance_ok' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('parallel requests for one address fund only once', async () => {
    const { deps, send } = makeDeps();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => handleFund({ address: ADDR(1) }, 'ip', deps)),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.json.funded)).toHaveLength(1);
  });
});

describe('clientIp', () => {
  test('x-real-ip, then last x-forwarded-for, then remoteAddr, then unknown', () => {
    const all = new Headers({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3, 4.4.4.4' });
    expect(clientIp(all, '9.9.9.9')).toBe('2.2.2.2');
    all.delete('x-real-ip');
    expect(clientIp(all, '9.9.9.9')).toBe('4.4.4.4');
    expect(clientIp(new Headers({ 'x-forwarded-for': '6.6.6.6,  5.5.5.5  ' }))).toBe('5.5.5.5');
    expect(clientIp(new Headers(), ' 9.9.9.9 ')).toBe('9.9.9.9');
    expect(clientIp(new Headers())).toBe('unknown');
  });

  test('ignores cf-connecting-ip and a forged first x-forwarded-for entry', () => {
    const h = new Headers({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '6.6.6.6, 7.7.7.7' });
    expect(clientIp(h)).toBe('7.7.7.7');
    expect(clientIp(new Headers({ 'cf-connecting-ip': '1.1.1.1' }), '8.8.8.8')).toBe('8.8.8.8');
  });
});

describe('fundRoutes', () => {
  test('POST /fund funds using the x-real-ip header', async () => {
    const { fundRoutes } = await import('../src/fundRoutes');
    const limiter = makeLimiter();
    const spy = vi.spyOn(limiter, 'reserve');
    const { deps } = makeDeps({ limiter });
    const app = fundRoutes(deps);
    const res = await app.request('/fund', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '7.7.7.7' },
      body: JSON.stringify({ address: ADDR(1) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ funded: true, txHash: TX_HASH });
    expect(spy.mock.calls[0]?.[0].ip).toBe('7.7.7.7');
  });

  test('POST /fund falls back to the node socket address', async () => {
    const { fundRoutes } = await import('../src/fundRoutes');
    const limiter = makeLimiter();
    const spy = vi.spyOn(limiter, 'reserve');
    const { deps } = makeDeps({ limiter });
    const env = { incoming: { socket: { remoteAddress: '10.1.2.3' } } };
    await fundRoutes(deps).request(
      '/fund',
      { method: 'POST', body: JSON.stringify({ address: ADDR(1) }) },
      env,
    );
    expect(spy.mock.calls[0]?.[0].ip).toBe('10.1.2.3');
  });

  test('POST /fund with invalid JSON returns 400', async () => {
    const { fundRoutes } = await import('../src/fundRoutes');
    const { deps } = makeDeps();
    const res = await fundRoutes(deps).request('/fund', { method: 'POST', body: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ funded: false, reason: 'address' });
  });
});

describe('handleFund balance lookup failure', () => {
  test('returns 502 without reserving', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const limiter = makeLimiter();
    const { deps } = makeDeps({
      limiter,
      getBalance: async () => {
        throw new Error('rpc down');
      },
    });
    const r = await handleFund({ address: ADDR(1) }, 'ip', deps);
    expect(r.status).toBe(502);
    expect(limiter.spentWei()).toBe(0n);
    err.mockRestore();
  });
});
