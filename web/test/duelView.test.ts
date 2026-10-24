import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import {
  countdownSeconds,
  lostJoinRace,
  mySide,
  opponentOf,
  outcome,
  phase,
  secondsLeft,
  sideStats,
} from '../src/lib/duelView';
import type { DuelView } from '../src/lib/types';

const P1: Hex = '0xAbCd000000000000000000000000000000000001';
const P2: Hex = '0xabcd000000000000000000000000000000000002';
const OTHER: Hex = '0x9999000000000000000000000000000000000003';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

const ACTIVE: DuelView = {
  id: '4',
  p1: P1,
  p2: P2,
  hp1: 1500,
  hp2: 1200,
  atk1: 12,
  atk2: 14,
  mult1: 150,
  mult2: 75,
  lastBlock1: 110,
  lastBlock2: 112,
  skill1: false,
  skill2: true,
  status: 'Active',
  startBlock: 110,
  endBlock: 177,
  card1: 7,
  card2: 9,
  maxHp1: 1600,
  maxHp2: 1700,
  settled: false,
};

const OPEN: DuelView = { ...ACTIVE, p2: ZERO, status: 'Open', startBlock: 0, endBlock: 0, card2: 0 };

describe('mySide', () => {
  it('finds the side case-insensitively', () => {
    expect(mySide(ACTIVE, P1.toLowerCase() as Hex)).toBe(1);
    expect(mySide(ACTIVE, P2.toUpperCase().replace('0X', '0x') as Hex)).toBe(2);
  });
  it('returns null for a non-participant', () => {
    expect(mySide(ACTIVE, OTHER)).toBeNull();
    expect(mySide(OPEN, OTHER)).toBeNull();
  });
});

describe('opponentOf', () => {
  it('returns the other side address', () => {
    expect(opponentOf(ACTIVE, 1)).toBe(P2);
    expect(opponentOf(ACTIVE, 2)).toBe(P1);
  });
});

describe('phase', () => {
  it('is loading without a duel', () => {
    expect(phase(null, 100, P1)).toBe('loading');
  });
  it('is waiting for p1 and join for anyone else while Open', () => {
    expect(phase(OPEN, 100, P1)).toBe('waiting');
    expect(phase(OPEN, 100, OTHER)).toBe('join');
  });
  it('is countdown before startBlock and battle from startBlock to endBlock', () => {
    expect(phase(ACTIVE, 109, P1)).toBe('countdown');
    expect(phase(ACTIVE, 110, P2)).toBe('battle');
    expect(phase(ACTIVE, 176, P1)).toBe('battle');
  });
  it('is ended once Active reaches endBlock or the status is final', () => {
    expect(phase(ACTIVE, 177, P1)).toBe('ended');
    expect(phase({ ...ACTIVE, status: 'P1Won' }, 150, P2)).toBe('ended');
    expect(phase({ ...ACTIVE, status: 'P2Won' }, 150, P1)).toBe('ended');
    expect(phase({ ...ACTIVE, status: 'Draw' }, 150, P1)).toBe('ended');
  });
  it('is spectator for a non-participant once the duel left Open', () => {
    expect(phase(ACTIVE, 105, OTHER)).toBe('spectator');
    expect(phase(ACTIVE, 150, OTHER)).toBe('spectator');
    expect(phase({ ...ACTIVE, status: 'P1Won' }, 190, OTHER)).toBe('spectator');
  });
});

describe('sideStats', () => {
  it('reads each side of the duel', () => {
    expect(sideStats(ACTIVE, 1)).toEqual({
      hp: 1500,
      maxHp: 1600,
      atk: 12,
      mult: 150,
      lastBlock: 110,
      skillUsed: false,
      card: 7,
    });
    expect(sideStats(ACTIVE, 2)).toEqual({
      hp: 1200,
      maxHp: 1700,
      atk: 14,
      mult: 75,
      lastBlock: 112,
      skillUsed: true,
      card: 9,
    });
  });
});

describe('outcome', () => {
  it('maps the final status to the side', () => {
    expect(outcome({ ...ACTIVE, status: 'P1Won' }, 1)).toBe('Victory');
    expect(outcome({ ...ACTIVE, status: 'P1Won' }, 2)).toBe('Defeat');
    expect(outcome({ ...ACTIVE, status: 'P2Won' }, 2)).toBe('Victory');
    expect(outcome({ ...ACTIVE, status: 'P2Won' }, 1)).toBe('Defeat');
    expect(outcome({ ...ACTIVE, status: 'Draw' }, 1)).toBe('Draw');
  });
  it('is null while the duel is not final', () => {
    expect(outcome(ACTIVE, 1)).toBeNull();
    expect(outcome(OPEN, 1)).toBeNull();
  });
});

describe('countdownSeconds', () => {
  it('converts remaining blocks to seconds at 0.3 s per block, rounded up', () => {
    expect(countdownSeconds(110, 100)).toBe(3);
    expect(countdownSeconds(110, 104)).toBe(2);
    expect(countdownSeconds(110, 106)).toBe(2);
    expect(countdownSeconds(110, 107)).toBe(1);
  });
  it('never shows less than 1', () => {
    expect(countdownSeconds(110, 110)).toBe(1);
    expect(countdownSeconds(110, 120)).toBe(1);
  });
});

describe('secondsLeft', () => {
  it('converts remaining blocks to whole seconds, rounded up', () => {
    expect(secondsLeft(177, 110)).toBe(21);
    expect(secondsLeft(177, 167)).toBe(3);
    expect(secondsLeft(177, 176)).toBe(1);
  });
  it('is 0 at or after endBlock', () => {
    expect(secondsLeft(177, 177)).toBe(0);
    expect(secondsLeft(177, 200)).toBe(0);
  });
});

describe('lostJoinRace', () => {
  it('is true when a visitor who saw the join view is now a spectator', () => {
    expect(lostJoinRace('spectator', true)).toBe(true);
  });
  it('is false for a spectator who never saw the join view', () => {
    expect(lostJoinRace('spectator', false)).toBe(false);
  });
  it('is false for any other view', () => {
    expect(lostJoinRace('join', true)).toBe(false);
    expect(lostJoinRace('countdown', true)).toBe(false);
    expect(lostJoinRace('ended', true)).toBe(false);
  });
});
