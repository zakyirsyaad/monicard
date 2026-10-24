import type { Hex } from 'viem';
import type { DuelView } from './types';

export type Side = 1 | 2;
export type DuelPhase = 'loading' | 'waiting' | 'join' | 'spectator' | 'countdown' | 'battle' | 'ended';
export type Outcome = 'Victory' | 'Defeat' | 'Draw';

export type SideStats = {
  hp: number;
  maxHp: number;
  atk: number;
  mult: number;
  lastBlock: number;
  skillUsed: boolean;
  card: number;
};

/** Monad testnet block time used for on-screen seconds: 0.3 s = 3 / 10. */
const BLOCK_TENTHS = 3;
const TENTHS = 10;

export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const otherSide = (side: Side): Side => (side === 1 ? 2 : 1);

export function isFinal(duel: DuelView): boolean {
  return duel.status === 'P1Won' || duel.status === 'P2Won' || duel.status === 'Draw';
}

export function mySide(duel: DuelView, address: Hex): Side | null {
  if (sameAddress(duel.p1, address)) return 1;
  if (sameAddress(duel.p2, address)) return 2;
  return null;
}

/** Address of the other side. */
export function opponentOf(duel: DuelView, side: Side): Hex {
  return side === 1 ? duel.p2 : duel.p1;
}

export function phase(duel: DuelView | null, block: number, address: Hex): DuelPhase {
  if (!duel) return 'loading';
  const side = mySide(duel, address);
  if (duel.status === 'Open') return side === 1 ? 'waiting' : 'join';
  if (side === null) return 'spectator';
  if (isFinal(duel) || block >= duel.endBlock) return 'ended';
  return block < duel.startBlock ? 'countdown' : 'battle';
}

/**
 * A visitor who saw the join screen and is now a spectator lost the race to join
 * (someone else joined first, or their own join reverted): say so instead of "already underway".
 */
export function lostJoinRace(view: DuelPhase, sawJoinView: boolean): boolean {
  return view === 'spectator' && sawJoinView;
}

export function sideStats(duel: DuelView, side: Side): SideStats {
  return side === 1
    ? {
        hp: duel.hp1,
        maxHp: duel.maxHp1,
        atk: duel.atk1,
        mult: duel.mult1,
        lastBlock: duel.lastBlock1,
        skillUsed: duel.skill1,
        card: duel.card1,
      }
    : {
        hp: duel.hp2,
        maxHp: duel.maxHp2,
        atk: duel.atk2,
        mult: duel.mult2,
        lastBlock: duel.lastBlock2,
        skillUsed: duel.skill2,
        card: duel.card2,
      };
}

export function outcome(duel: DuelView, side: Side): Outcome | null {
  if (duel.status === 'Draw') return 'Draw';
  if (duel.status === 'P1Won') return side === 1 ? 'Victory' : 'Defeat';
  if (duel.status === 'P2Won') return side === 2 ? 'Victory' : 'Defeat';
  return null;
}

/** Integer math: (blocks × 0.3) in floating point would round 3.0000000000000004 up to 4. */
const blocksToSeconds = (blocks: number): number => Math.ceil((blocks * BLOCK_TENTHS) / TENTHS);

export function countdownSeconds(startBlock: number, block: number): number {
  return Math.max(1, blocksToSeconds(startBlock - block));
}

export function secondsLeft(endBlock: number, block: number): number {
  return Math.max(0, blocksToSeconds(endBlock - block));
}
