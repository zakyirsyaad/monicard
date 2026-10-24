import { blitzArenaAbi, type Hex } from '@nad/shared';
import { parseEventLogs } from 'viem';
import type { ReceiptHub, TxReceipt } from './receiptHub';

export const WINDOW_MS = 5_000;
export const LATENCY_SAMPLES = 100;

export type StatsSnapshot = { txTotal: number; txPerSec: number; avgLatencyMs: number; lastTxHash?: Hex };

export type Stats = {
  recordAttack(count: number): void;
  recordLatency(ms: number): void;
  /**
   * Feed ingested receipts. txTotal counts every receipt whose `to` is cards/arena
   * (including reverted ones); attacks are counted per `Attacked` log emitted by arena.
   */
  recordReceipts(receipts: readonly TxReceipt[]): void;
  snapshot(): StatsSnapshot;
};

export type StatsOptions = { cards: Hex; arena: Hex; now?: () => number };

export function createStats(opts: StatsOptions): Stats {
  const now = opts.now ?? Date.now;
  const cards = opts.cards.toLowerCase();
  const arena = opts.arena.toLowerCase();
  let attacks: { at: number; count: number }[] = [];
  let latencies: number[] = [];
  let txTotal = 0;
  let lastTxHash: Hex | undefined;

  const pruneAttacks = (): void => {
    const cutoff = now() - WINDOW_MS;
    attacks = attacks.filter((a) => a.at > cutoff);
  };

  function countAttacked(receipt: TxReceipt): number {
    const logs = receipt.logs.filter((l) => l.address.toLowerCase() === arena);
    return parseEventLogs({ abi: blitzArenaAbi, eventName: 'Attacked', logs }).length;
  }

  function recordAttack(count: number): void {
    if (count <= 0) return;
    pruneAttacks();
    attacks.push({ at: now(), count });
  }

  return {
    recordAttack,
    recordLatency(ms) {
      latencies = [...latencies, ms].slice(-LATENCY_SAMPLES);
    },
    recordReceipts(receipts) {
      let attackCount = 0;
      for (const r of receipts) {
        const to = r.to?.toLowerCase();
        if (to !== cards && to !== arena) continue;
        txTotal += 1;
        lastTxHash = r.transactionHash;
        attackCount += countAttacked(r);
      }
      recordAttack(attackCount);
    },
    snapshot() {
      pruneAttacks();
      const total = attacks.reduce((sum, a) => sum + a.count, 0);
      const avg = latencies.length === 0 ? 0 : Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length);
      const base = { txTotal, txPerSec: Math.round((total / (WINDOW_MS / 1000)) * 10) / 10, avgLatencyMs: avg };
      return lastTxHash ? { ...base, lastTxHash } : base;
    },
  };
}

/** Feeds the stats from every block the watcher ingests. */
export function attachStats(hub: ReceiptHub, stats: Stats): void {
  hub.onIngest((_block, receipts) => stats.recordReceipts(receipts));
}
