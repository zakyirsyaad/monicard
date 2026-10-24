import { blitzArenaAbi } from '@nad/shared';
import { encodeAbiParameters, encodeEventTopics, type Hex, type TransactionReceipt } from 'viem';
import { describe, expect, test } from 'vitest';
import { createReceiptHub } from '../src/receiptHub';
import { attachStats, createStats } from '../src/stats';

const CARDS: Hex = '0x1111111111111111111111111111111111111111';
const ARENA: Hex = '0x2222222222222222222222222222222222222222';
const OTHER: Hex = '0x3333333333333333333333333333333333333333';
const PLAYER: Hex = '0x4444444444444444444444444444444444444444';
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

function attackedLog(address: Hex = ARENA) {
  const topics = encodeEventTopics({ abi: blitzArenaAbi, eventName: 'Attacked', args: { id: 1n, attacker: PLAYER } });
  const data = encodeAbiParameters([{ type: 'uint16' }, { type: 'uint256' }, { type: 'uint16' }], [3, 9n, 80]);
  return { address, topics, data };
}

const receipt = (n: number, to: Hex | null, logs: unknown[] = []) =>
  ({ transactionHash: h(n), blockNumber: 1n, status: 'success', to, logs }) as unknown as TransactionReceipt;

function setup() {
  const clock = { t: 0 };
  const stats = createStats({ cards: CARDS, arena: ARENA, now: () => clock.t });
  return { clock, stats };
}

describe('stats', () => {
  test('starts empty', () => {
    const { stats } = setup();
    expect(stats.snapshot()).toEqual({ txTotal: 0, txPerSec: 0, avgLatencyMs: 0 });
  });

  test('txPerSec averages attacks over a 5 s sliding window', () => {
    const { stats, clock } = setup();
    clock.t = 1_000;
    stats.recordAttack(10);
    clock.t = 3_000;
    stats.recordAttack(15);
    expect(stats.snapshot().txPerSec).toBe(5); // 25 / 5 s
    clock.t = 6_500; // the t=1000 sample has left the window
    expect(stats.snapshot().txPerSec).toBe(3); // 15 / 5 s
    clock.t = 20_000;
    expect(stats.snapshot().txPerSec).toBe(0);
  });

  test('avgLatencyMs is the rounded mean of the last 100 latencies', () => {
    const { stats } = setup();
    stats.recordLatency(100);
    stats.recordLatency(201);
    expect(stats.snapshot().avgLatencyMs).toBe(151); // 150.5 rounds up
    for (let i = 0; i < 100; i++) stats.recordLatency(10);
    expect(stats.snapshot().avgLatencyMs).toBe(10);
  });

  test('ingested receipts update txTotal, attacks and lastTxHash only for our contracts', () => {
    const { stats, clock } = setup();
    const hub = createReceiptHub();
    attachStats(hub, stats);
    clock.t = 1_000;
    hub.ingest(1n, [
      receipt(1, CARDS),
      receipt(2, ARENA, [attackedLog(), attackedLog(), attackedLog(OTHER)]),
      receipt(3, OTHER, [attackedLog()]),
      receipt(4, null),
    ]);
    const snap = stats.snapshot();
    expect(snap.txTotal).toBe(2);
    expect(snap.lastTxHash).toBe(h(2));
    expect(snap.txPerSec).toBe(0.4); // 2 attacked logs from arena / 5 s
  });

  test('lastTxHash follows the latest tx and is compared case-insensitively on addresses', () => {
    const { stats } = setup();
    const hub = createReceiptHub();
    attachStats(hub, stats);
    hub.ingest(1n, [receipt(1, ARENA)]);
    hub.ingest(2n, [receipt(5, ARENA.toUpperCase().replace('0X', '0x') as Hex), receipt(6, CARDS)]);
    expect(stats.snapshot().lastTxHash).toBe(h(6));
    expect(stats.snapshot().txTotal).toBe(3);
  });
});
