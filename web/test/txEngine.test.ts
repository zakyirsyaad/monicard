import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseTransaction } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { blitzArenaAbi } from '../src/lib/abi';
import { ApiError, NetworkError, TimeoutError } from '../src/lib/api';
import { skillDamage, tapDamage } from '../src/lib/game';
import { createTxEngine } from '../src/lib/txEngine';
import type { TxEngine } from '../src/lib/txEngine';
import type { Config, RelayResult } from '../src/lib/types';

const ARENA = '0x2222222222222222222222222222222222222222' as const;
const ATK = 12;
const MULT = 150;

const config = {
  chainId: 10143,
  contracts: { cards: '0x1111111111111111111111111111111111111111', arena: ARENA },
  gasLimits: { freePull: 1, paidPull: 1, createDuel: 1, joinDuel: 1, attack: 120000, settle: 1 },
  gasPrice: '50000000000',
  batchMs: 1000,
  pullPrice: '50000000000000000',
  event: { name: 'Test', sponsor: null },
  agent: '0x3333333333333333333333333333333333333333',
  bots: [],
} satisfies Config;

const DUEL = { id: 7n, startBlock: 100, endBlock: 167, side: 1 as const, lastBlock: 100, atk: ATK, mult: MULT };

type Pending = { raw: Hex; resolve: (r: RelayResult) => void; reject: (e: unknown) => void };

function fakeRelay() {
  const calls: Pending[] = [];
  const fn = vi.fn(
    (raw: Hex) =>
      new Promise<RelayResult>((resolve, reject) => {
        calls.push({ raw, resolve, reject });
      }),
  );
  return { fn, calls };
}

function ok(blockNumber: number, latencyMs = 400, hash: Hex = `0x${'ab'.repeat(32)}`): RelayResult {
  return { hash, status: 'success', latencyMs, blockNumber: String(blockNumber), events: {} };
}

function decode(raw: Hex) {
  const tx = parseTransaction(raw);
  const { functionName, args } = decodeFunctionData({ abi: blitzArenaAbi, data: tx.data! });
  const [id, taps, useSkill] = args as readonly [bigint, number, boolean];
  return { functionName, id, taps, useSkill, nonce: tx.nonce, to: tx.to, gas: tx.gas };
}

/** Lets pending promise chains (nonce fetch, signing, relay) run without moving the clock. */
async function flush() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

function taps(engine: TxEngine, n: number) {
  for (let i = 0; i < n; i++) engine.tap();
}

let relay: ReturnType<typeof fakeRelay>;
let account: ReturnType<typeof privateKeyToAccount>;

function setup(getNonce = vi.fn(async () => 0)) {
  const engine = createTxEngine({ account, config, relay: relay.fn, getNonce });
  return { engine, getNonce };
}

beforeEach(() => {
  vi.useFakeTimers();
  relay = fakeRelay();
  account = privateKeyToAccount(generatePrivateKey());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('txEngine (plan Task 11 Step 1)', () => {
  it('sends at most one tx in flight', async () => {
    const { engine } = setup();
    engine.onBlock(105);
    engine.start(DUEL);
    taps(engine, 5);
    await flush();
    expect(relay.calls).toHaveLength(1);
    const first = decode(relay.calls[0]!.raw);
    expect(first).toMatchObject({ functionName: 'attack', id: 7n, taps: 1, useSkill: false, to: ARENA, gas: 120000n });

    await vi.advanceTimersByTimeAsync(3000);
    engine.onBlock(108);
    await flush();
    expect(relay.calls).toHaveLength(1);

    relay.calls[0]!.resolve(ok(106));
    await flush();
    expect(relay.calls).toHaveLength(2);
    expect(decode(relay.calls[1]!.raw).taps).toBe(4);
  });

  it('waits batchMs between txs', async () => {
    const { engine } = setup();
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    relay.calls[0]!.resolve(ok(106));
    await flush();
    taps(engine, 3);
    await vi.advanceTimersByTimeAsync(998);
    expect(relay.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    await flush();
    expect(relay.calls).toHaveLength(2);
    expect(decode(relay.calls[1]!.raw).taps).toBe(3);
  });

  it('mirrors contract tap cap per elapsed blocks', async () => {
    const { engine } = setup();
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    taps(engine, 20);
    await vi.advanceTimersByTimeAsync(1000);
    relay.calls[0]!.resolve(ok(107));
    await flush();
    expect(relay.calls).toHaveLength(2);
    expect(decode(relay.calls[1]!.raw).taps).toBe(9);
  });

  it('flushes remaining buffer at endBlock-3 ignoring batchMs', async () => {
    const { engine } = setup();
    engine.onBlock(160);
    engine.start(DUEL);
    engine.tap();
    await flush();
    relay.calls[0]!.resolve(ok(160));
    await flush();
    taps(engine, 4);
    await vi.advanceTimersByTimeAsync(10);
    expect(relay.calls).toHaveLength(1);
    engine.onBlock(164);
    await flush();
    expect(relay.calls).toHaveLength(2);
    expect(decode(relay.calls[1]!.raw).taps).toBe(4);
  });

  it('stops sending at endBlock-2', async () => {
    const { engine } = setup();
    engine.onBlock(160);
    engine.start(DUEL);
    engine.tap();
    await flush();
    taps(engine, 4);
    engine.onBlock(165);
    relay.calls[0]!.resolve(ok(160));
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(relay.calls).toHaveLength(1);
    engine.tap();
    await vi.advanceTimersByTimeAsync(5000);
    expect(relay.calls).toHaveLength(1);
  });

  it('resends identical raw tx on timeout', async () => {
    const sign = vi.spyOn(account, 'signTransaction');
    const { engine } = setup();
    const sent = vi.fn();
    engine.on('sent', sent);
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    relay.calls[0]!.reject(new TimeoutError(5000));
    await flush();
    expect(relay.calls).toHaveLength(2);
    expect(relay.calls[1]!.raw).toBe(relay.calls[0]!.raw);
    relay.calls[1]!.reject(new TimeoutError(5000));
    await flush();
    expect(relay.calls).toHaveLength(3);
    expect(relay.calls[2]!.raw).toBe(relay.calls[0]!.raw);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('resyncs nonce once on nonce error', async () => {
    const getNonce = vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(9).mockResolvedValue(9);
    const { engine } = setup(getNonce);
    const errors = vi.fn();
    engine.on('error', errors);
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    expect(decode(relay.calls[0]!.raw).nonce).toBe(5);
    relay.calls[0]!.reject(new ApiError(400, 'nonce too low'));
    await flush();
    expect(getNonce).toHaveBeenCalledTimes(2);
    expect(relay.calls).toHaveLength(2);
    expect(decode(relay.calls[1]!.raw)).toMatchObject({ nonce: 9, taps: 1 });
    relay.calls[1]!.reject(new ApiError(400, 'nonce too low'));
    await flush();
    expect(relay.calls).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith({ kind: 'relay', reason: 'nonce too low' });
  });

  it('resumes from chain nonce after reload', async () => {
    const { engine, getNonce } = setup(vi.fn(async () => 12));
    engine.onBlock(110);
    engine.start({ ...DUEL, lastBlock: 108 });
    engine.tap();
    await flush();
    expect(decode(relay.calls[0]!.raw).nonce).toBe(12);
    engine.tap();
    await vi.advanceTimersByTimeAsync(1000);
    relay.calls[0]!.resolve(ok(110));
    engine.onBlock(111);
    await flush();
    expect(decode(relay.calls[1]!.raw).nonce).toBe(13);
    expect(getNonce).toHaveBeenCalledTimes(1);
  });

  it('ignores taps before startBlock', async () => {
    const { engine } = setup();
    engine.onBlock(95);
    engine.start(DUEL);
    taps(engine, 5);
    await vi.advanceTimersByTimeAsync(3000);
    engine.onBlock(101);
    await flush();
    expect(relay.calls).toHaveLength(0);
    expect(engine.pendingDamageEstimate(ATK, MULT, 1500, 1500)).toBe(0);
    engine.tap();
    await flush();
    expect(relay.calls).toHaveLength(1);
    expect(decode(relay.calls[0]!.raw).taps).toBe(1);
  });

  it('stats sums confirmed txs, damage and average latency', async () => {
    const { engine } = setup();
    const hash2: Hex = `0x${'cd'.repeat(32)}`;
    engine.onBlock(110);
    engine.start(DUEL);
    expect(engine.stats()).toEqual({ txCount: 0, damageSent: 0, avgLatencyMs: 0, lastTxHash: null });
    engine.tap();
    await flush();
    taps(engine, 4);
    await vi.advanceTimersByTimeAsync(1000);
    relay.calls[0]!.resolve(ok(106, 400));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    relay.calls[1]!.resolve(ok(110, 600, hash2));
    await flush();
    engine.tap();
    engine.onBlock(112);
    await vi.advanceTimersByTimeAsync(1000);
    relay.calls[2]!.resolve({ ...ok(111, 900), status: 'reverted' });
    await flush();
    expect(engine.stats()).toEqual({
      txCount: 2,
      damageSent: tapDamage(1, ATK, MULT) + tapDamage(4, ATK, MULT),
      avgLatencyMs: 500,
      lastTxHash: hash2,
    });
  });
});

describe('txEngine extra rules', () => {
  it('rides the skill on the next tx, once per duel', async () => {
    const { engine } = setup();
    engine.onBlock(110);
    engine.start(DUEL);
    engine.requestSkill();
    await flush();
    expect(decode(relay.calls[0]!.raw)).toMatchObject({ taps: 0, useSkill: true });
    engine.requestSkill();
    engine.tap();
    await vi.advanceTimersByTimeAsync(1000);
    relay.calls[0]!.resolve(ok(110));
    engine.onBlock(111);
    await flush();
    expect(decode(relay.calls[1]!.raw)).toMatchObject({ taps: 1, useSkill: false });
    engine.requestSkill();
    await vi.advanceTimersByTimeAsync(1000);
    relay.calls[1]!.resolve(ok(111));
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(relay.calls).toHaveLength(2);
  });

  it('emits relay, network and reverted errors and keeps the buffer', async () => {
    const { engine } = setup();
    const errors = vi.fn();
    engine.on('error', errors);
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    taps(engine, 2);
    relay.calls[0]!.reject(new ApiError(429, 'rate_limited'));
    await flush();
    expect(errors).toHaveBeenLastCalledWith({ kind: 'relay', reason: 'rate_limited' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(decode(relay.calls[1]!.raw).taps).toBe(2);
    relay.calls[1]!.reject(new NetworkError());
    await flush();
    expect(errors).toHaveBeenLastCalledWith({ kind: 'network' });
    engine.tap();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    relay.calls[2]!.resolve({ ...ok(111), status: 'reverted' });
    await flush();
    expect(errors).toHaveBeenLastCalledWith({ kind: 'reverted', fn: 'attack' });
  });

  it('emits sent then confirmed with tx details', async () => {
    const { engine } = setup(vi.fn(async () => 3));
    const sent = vi.fn();
    const confirmed = vi.fn();
    engine.on('sent', sent);
    const off = engine.on('confirmed', confirmed);
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    expect(sent).toHaveBeenCalledWith({ taps: 1, skill: false, nonce: 3 });
    relay.calls[0]!.resolve(ok(110, 321));
    await flush();
    expect(confirmed).toHaveBeenCalledWith({
      hash: `0x${'ab'.repeat(32)}`,
      latencyMs: 321,
      blockNumber: 110,
      taps: 1,
      skill: false,
    });
    off();
    engine.tap();
    await vi.advanceTimersByTimeAsync(1000);
    engine.onBlock(111);
    await flush();
    relay.calls[1]!.resolve(ok(111));
    await flush();
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('stop() ignores input, clears timers and silences in-flight results', async () => {
    const { engine } = setup();
    const confirmed = vi.fn();
    engine.on('confirmed', confirmed);
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    relay.calls[0]!.resolve(ok(106));
    await flush();
    engine.tap();
    expect(vi.getTimerCount()).toBe(1);
    engine.stop();
    expect(vi.getTimerCount()).toBe(0);
    engine.tap();
    engine.requestSkill();
    engine.onBlock(115);
    await vi.advanceTimersByTimeAsync(5000);
    expect(relay.calls).toHaveLength(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(engine.stats().txCount).toBe(1);
  });

  it('stop() while in flight drops the result and stops timeout resends', async () => {
    const { engine } = setup();
    const confirmed = vi.fn();
    engine.on('confirmed', confirmed);
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    relay.calls[0]!.reject(new TimeoutError(5000));
    engine.stop();
    await flush();
    expect(relay.calls).toHaveLength(1);
    expect(confirmed).not.toHaveBeenCalled();
    expect(engine.stats().txCount).toBe(0);
  });

  it('tap and requestSkill report whether the input was accepted', () => {
    const { engine } = setup();
    expect(engine.tap()).toBe(false); // not started
    expect(engine.requestSkill()).toBe(false);
    engine.onBlock(99);
    engine.start(DUEL);
    expect(engine.tap()).toBe(false); // before startBlock
    engine.onBlock(110);
    expect(engine.tap()).toBe(true);
    expect(engine.requestSkill()).toBe(true);
    expect(engine.requestSkill()).toBe(false); // already requested
    engine.onBlock(165); // endBlock - 2: nothing can be sent anymore
    expect(engine.tap()).toBe(false);
    engine.stop();
    expect(engine.tap()).toBe(false);
  });

  it('a throwing listener does not skip the next send check', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine } = setup();
    const after = vi.fn();
    engine.on('confirmed', () => {
      throw new Error('listener failed');
    });
    engine.on('confirmed', after);
    engine.onBlock(110);
    engine.start(DUEL);
    engine.tap();
    await flush();
    taps(engine, 2);
    await vi.advanceTimersByTimeAsync(1000);
    relay.calls[0]!.resolve(ok(109));
    await flush();
    expect(after).toHaveBeenCalledTimes(1);
    expect(relay.calls).toHaveLength(2);
    expect(decode(relay.calls[1]!.raw).taps).toBe(2);
    expect(report).toHaveBeenCalledTimes(1);
    report.mockRestore();
  });

  it('estimates pending damage from buffer, in-flight and unreflected txs', async () => {
    const { engine } = setup();
    const skill = skillDamage(ATK, MULT, 1000, 1500);
    const estimate = () => engine.pendingDamageEstimate(ATK, MULT, 1000, 1500);
    engine.onBlock(110);
    engine.start(DUEL);
    engine.requestSkill();
    await flush();
    taps(engine, 3);
    // in flight: skill (0 taps); buffered: 3 taps (cap 30 over 10 blocks)
    expect(estimate()).toBe(tapDamage(3, ATK, MULT) + skill);
    relay.calls[0]!.resolve(ok(112));
    await flush();
    // confirmed in block 112 while WS is at 110 → skill still pending; buffer cap 110 − 112 → 0
    expect(estimate()).toBe(skill);
    engine.onBlock(112);
    // reflected now; 0 blocks since the receipt → cap 0
    expect(estimate()).toBe(0);
    engine.onBlock(113);
    expect(estimate()).toBe(tapDamage(3, ATK, MULT));
  });
});
