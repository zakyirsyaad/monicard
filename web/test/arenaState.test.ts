import { describe, expect, it } from 'vitest';
import { initialArenaState, nextBackoff, reduceArena } from '../src/lib/arenaState';
import type { AgentMsg, DuelView, StatsMsg, WsMessage } from '../src/lib/types';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

function duel(id: string, over: Partial<DuelView> = {}): DuelView {
  return {
    id,
    p1: A,
    p2: B,
    hp1: 100,
    hp2: 100,
    atk1: 10,
    atk2: 10,
    mult1: 1,
    mult2: 1,
    lastBlock1: 0,
    lastBlock2: 0,
    skill1: false,
    skill2: false,
    status: 'Active',
    startBlock: 10,
    endBlock: 50,
    card1: 1,
    card2: 2,
    maxHp1: 100,
    maxHp2: 100,
    settled: false,
    ...over,
  };
}

const duels = (block: string, list: DuelView[], featuredId: string | null = null): WsMessage => ({
  type: 'duels',
  block,
  duels: list,
  featuredId,
});

const stats = (block: string): StatsMsg => ({
  type: 'stats',
  block,
  txTotal: 10,
  txPerSec: 2,
  avgLatencyMs: 300,
  uniquePlayers: 4,
  totalDuels: 2,
  treasury: '1000',
});

describe('reduceArena', () => {
  it('starts empty and disconnected-neutral', () => {
    expect(initialArenaState.duels.size).toBe(0);
    expect(initialArenaState.featuredId).toBeNull();
    expect(initialArenaState.stats).toBeNull();
    expect(initialArenaState.agent).toBeNull();
    expect(initialArenaState.leaderboard).toBeNull();
    expect(initialArenaState.taunts.size).toBe(0);
    expect(initialArenaState.block).toBe(0);
    expect(initialArenaState.blockAt).toBe(0);
  });

  it('duels message sets the map, featuredId and block', () => {
    const s = reduceArena(initialArenaState, duels('100', [duel('1'), duel('2')], '2'), 5000);
    expect([...s.duels.keys()]).toEqual(['1', '2']);
    expect(s.featuredId).toBe('2');
    expect(s.block).toBe(100);
    expect(s.blockAt).toBe(5000);
  });

  it('duels message REPLACES the whole map (snapshot semantics)', () => {
    const s1 = reduceArena(initialArenaState, duels('100', [duel('1'), duel('2')]), 1);
    const s2 = reduceArena(s1, duels('101', [duel('3')]), 2);
    expect([...s2.duels.keys()]).toEqual(['3']);
  });

  it('does not mutate the previous state', () => {
    const s1 = reduceArena(initialArenaState, duels('100', [duel('1')]), 1);
    const s2 = reduceArena(s1, duels('101', [duel('2')]), 2);
    expect(s1.duels.has('1')).toBe(true);
    expect(s1.duels.has('2')).toBe(false);
    expect(s2).not.toBe(s1);
  });

  it('block never decreases and blockAt only moves when it advances', () => {
    const s1 = reduceArena(initialArenaState, duels('100', [duel('1')]), 1000);
    const s2 = reduceArena(s1, duels('99', [duel('1')]), 2000);
    expect(s2.block).toBe(100);
    expect(s2.blockAt).toBe(1000);
    const s3 = reduceArena(s2, duels('100', [duel('1')]), 3000);
    expect(s3.block).toBe(100);
    expect(s3.blockAt).toBe(1000);
    const s4 = reduceArena(s3, stats('101'), 4000);
    expect(s4.block).toBe(101);
    expect(s4.blockAt).toBe(4000);
  });

  it('a stale duels message still replaces the map', () => {
    const s1 = reduceArena(initialArenaState, duels('100', [duel('1')]), 1);
    const s2 = reduceArena(s1, duels('90', [duel('9')]), 2);
    expect([...s2.duels.keys()]).toEqual(['9']);
    expect(s2.block).toBe(100);
  });

  it('stores stats', () => {
    const msg = stats('120');
    const s = reduceArena(initialArenaState, msg, 1);
    expect(s.stats).toEqual(msg);
    expect(s.block).toBe(120);
  });

  it('stores agent and leaderboard', () => {
    const agent: AgentMsg = {
      type: 'agent',
      level: 2,
      threshold: 7,
      finisher: false,
      sim: { duels: 100, wins: 55 },
      testnet: { duels: 3, wins: 1 },
      lessons: [],
    };
    const lb = {
      type: 'leaderboard' as const,
      entries: [{ address: A, label: null, wins: 3, losses: 1, cardId: '5' }],
    };
    const s = reduceArena(reduceArena(initialArenaState, agent, 1), lb, 2);
    expect(s.agent).toEqual(agent);
    expect(s.leaderboard).toEqual(lb.entries);
    expect(s.block).toBe(0);
  });

  it('leaderboard stays null until one arrives', () => {
    const s = reduceArena(initialArenaState, duels('5', []), 1);
    expect(s.leaderboard).toBeNull();
  });

  it('stores taunts per duelId', () => {
    const s1 = reduceArena(initialArenaState, { type: 'taunt', duelId: '1', text: 'hi' }, 1);
    const s2 = reduceArena(s1, { type: 'taunt', duelId: '2', text: 'yo' }, 2);
    const s3 = reduceArena(s2, { type: 'taunt', duelId: '1', text: 'again' }, 3);
    expect(s3.taunts.get('1')).toBe('again');
    expect(s3.taunts.get('2')).toBe('yo');
    expect(s1.taunts.get('1')).toBe('hi');
  });
});

describe('nextBackoff', () => {
  it('starts at 500 and doubles up to an 8 s cap', () => {
    const seq: number[] = [];
    let prev: number | null = null;
    for (let i = 0; i < 6; i++) {
      prev = nextBackoff(prev);
      seq.push(prev);
    }
    expect(seq).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });
});
