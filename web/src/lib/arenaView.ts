import { formatEther } from 'viem';
import type { Hex } from 'viem';
import { countdownSeconds, isFinal, sameAddress, secondsLeft } from './duelView';
import { formatInt, shortHex } from './format';
import type { DuelView, StatsMsg } from './types';

export const AGENT_NAME = 'AI Agent';

/** Unsettled duels this far past their end block (about 60 s) are stuck; keep them off the projector. */
const STALE_BLOCKS = 200;

const treasuryFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type StatsItem = { key: 'players' | 'duels' | 'tx' | 'treasury'; text: string };

/** "AI Agent" for the agent's address, otherwise the shortened address. */
export function sideLabel(address: Hex, agent: Hex): string {
  return sameAddress(address, agent) ? AGENT_NAME : shortHex(address);
}

/** Whole-percent win rate; null when there are no duels to divide by. */
export function winratePct(wins: number, duels: number): number | null {
  return duels > 0 ? Math.round((wins / duels) * 100) : null;
}

/** Treasury in MON with 2 decimals and thousands commas: "1,250.50". */
export function treasuryMon(wei: string): string {
  return treasuryFormatter.format(Number(formatEther(BigInt(wei))));
}

/** The header stats row. Items whose value is 0 are left out. */
export function statsItems(stats: StatsMsg | null, treasury: string): StatsItem[] {
  if (!stats) return [];
  const items: Array<StatsItem | null> = [
    stats.uniquePlayers > 0 ? { key: 'players', text: `${formatInt(stats.uniquePlayers)} players` } : null,
    stats.totalDuels > 0 ? { key: 'duels', text: `${formatInt(stats.totalDuels)} duels` } : null,
    stats.txTotal > 0 ? { key: 'tx', text: `${formatInt(stats.txTotal)} onchain tx` } : null,
    BigInt(stats.treasury) > 0n ? { key: 'treasury', text: `Treasury ${treasury} MON` } : null,
  ];
  return items.filter((item): item is StatsItem => item !== null);
}

const byIdAsc = (a: DuelView, b: DuelView): number => Number(a.id) - Number(b.id);

/** A bot duel has bots on both sides. Bot vs human is not a bot duel. */
function isBotDuel(duel: DuelView, bots: readonly Hex[]): boolean {
  const isBot = (address: Hex): boolean => bots.some((bot) => sameAddress(bot, address));
  return isBot(duel.p1) && isBot(duel.p2);
}

/** The server's featured duel, else the newest duel that is started and not bot vs bot, else null. */
export function pickFeatured(
  duels: readonly DuelView[],
  featuredId: string | null,
  bots: readonly Hex[],
): DuelView | null {
  const featured = featuredId === null ? undefined : duels.find((d) => d.id === featuredId);
  if (featured) return featured;
  const candidates = duels.filter((d) => d.status !== 'Open' && !isBotDuel(d, bots)).sort(byIdAsc);
  return candidates.at(-1) ?? null;
}

/** Tiles for the swarm grid: active or just-finished (unsettled) duels, oldest first, minus the featured one. */
export function swarmDuels(duels: readonly DuelView[], featuredId: string | null, block: number): DuelView[] {
  return duels
    .filter((d) => d.id !== featuredId)
    .filter((d) => (d.status === 'Active' || (isFinal(d) && !d.settled)) && block - d.endBlock <= STALE_BLOCKS)
    .sort(byIdAsc);
}

/** Status line under the featured duel. */
export function duelStatusText(duel: DuelView, block: number, labels: { p1: string; p2: string }): string {
  switch (duel.status) {
    case 'Open':
      return 'Waiting for an opponent';
    case 'P1Won':
      return `${labels.p1} wins`;
    case 'P2Won':
      return `${labels.p2} wins`;
    case 'Draw':
      return 'Draw';
    default:
      return block < duel.startBlock
        ? `Starts in ${countdownSeconds(duel.startBlock, block)}s`
        : `${secondsLeft(duel.endBlock, block)}s left`;
  }
}

/** Short status for a swarm tile. */
export function tileStatusText(duel: DuelView, block: number): string {
  return isFinal(duel) ? 'Finished' : duelStatusText(duel, block, { p1: '', p2: '' });
}
