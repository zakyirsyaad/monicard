import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import {
  AGENT_NAME,
  duelStatusText,
  pickFeatured,
  sideLabel,
  statsItems,
  swarmDuels,
  tileStatusText,
  treasuryMon,
  winratePct,
} from '../src/lib/arenaView';
import type { DuelView, StatsMsg } from '../src/lib/types';

const AGENT: Hex = '0x00000000000000000000000000000000000000a9';
const BOT_A: Hex = '0x00000000000000000000000000000000000000b1';
const BOT_B: Hex = '0x00000000000000000000000000000000000000b2';
const GUEST: Hex = '0x00000000000000000000000000000000000ca401';
const ZERO: Hex = '0x0000000000000000000000000000000000000000';
const BOTS = [BOT_A, BOT_B];

function duel(id: string, over: Partial<DuelView> = {}): DuelView {
  return {
    id,
    p1: GUEST,
    p2: AGENT,
    hp1: 1500,
    hp2: 1500,
    atk1: 12,
    atk2: 12,
    mult1: 100,
    mult2: 100,
    lastBlock1: 110,
    lastBlock2: 110,
    skill1: false,
    skill2: false,
    status: 'Active',
    startBlock: 110,
    endBlock: 177,
    card1: 1,
    card2: 2,
    maxHp1: 1500,
    maxHp2: 1500,
    settled: false,
    ...over,
  };
}

const botDuel = (id: string, over: Partial<DuelView> = {}) => duel(id, { p1: BOT_A, p2: BOT_B, ...over });

describe('sideLabel', () => {
  it('names the agent exactly "AI Agent", case-insensitively', () => {
    expect(AGENT_NAME).toBe('AI Agent');
    expect(sideLabel(AGENT, AGENT)).toBe('AI Agent');
    expect(sideLabel(AGENT.toUpperCase().replace('0X', '0x') as Hex, AGENT)).toBe('AI Agent');
  });
  it('shortens any other address', () => {
    expect(sideLabel(GUEST, AGENT)).toBe('0x00…01');
  });
});

describe('winratePct', () => {
  it('is null when there are no duels', () => {
    expect(winratePct(0, 0)).toBeNull();
  });
  it('rounds wins / duels to a whole percent', () => {
    expect(winratePct(1, 3)).toBe(33);
    expect(winratePct(2, 3)).toBe(67);
    expect(winratePct(5, 5)).toBe(100);
    expect(winratePct(0, 4)).toBe(0);
  });
});

describe('treasuryMon', () => {
  it('formats wei as MON with 2 decimals', () => {
    expect(treasuryMon('0')).toBe('0.00');
    expect(treasuryMon('1250000000000000000')).toBe('1.25');
    expect(treasuryMon('50000000000000000')).toBe('0.05');
    expect(treasuryMon('12345600000000000000000')).toBe('12,345.60');
  });
  it('shows <0.01 for a positive amount below 0.01 MON', () => {
    expect(treasuryMon('1')).toBe('<0.01');
    expect(treasuryMon('9999999999999999')).toBe('<0.01');
    expect(treasuryMon('10000000000000000')).toBe('0.01');
  });
  it('falls back to 0.00 for an invalid wei string', () => {
    expect(treasuryMon('')).toBe('0.00');
    expect(treasuryMon('abc')).toBe('0.00');
    expect(treasuryMon('1.5')).toBe('0.00');
  });
});

describe('statsItems', () => {
  const stats = (over: Partial<StatsMsg> = {}): StatsMsg => ({
    type: 'stats',
    block: '1',
    txTotal: 1234,
    txPerSec: 3,
    avgLatencyMs: 300,
    uniquePlayers: 12,
    totalDuels: 1500,
    treasury: '1250000000000000000',
    ...over,
  });

  it('lists every item with thousands commas', () => {
    expect(statsItems(stats(), '1.25')).toEqual([
      { key: 'players', text: '12 players' },
      { key: 'duels', text: '1,500 duels' },
      { key: 'tx', text: '1,234 onchain tx' },
      { key: 'treasury', text: 'Treasury 1.25 MON' },
    ]);
  });

  it('hides items whose value is 0', () => {
    const items = statsItems(stats({ uniquePlayers: 0, totalDuels: 0, treasury: '0' }), '0.00');
    expect(items.map((i) => i.key)).toEqual(['tx']);
  });

  it('is empty when everything is 0', () => {
    expect(statsItems(stats({ txTotal: 0, uniquePlayers: 0, totalDuels: 0, treasury: '0' }), '0.00')).toEqual([]);
  });

  it('does not throw on an invalid treasury and hides the item', () => {
    const items = statsItems(stats({ treasury: 'not-a-number' }), '0.00');
    expect(items.map((i) => i.key)).toEqual(['players', 'duels', 'tx']);
  });

  it('is empty before the first stats message', () => {
    expect(statsItems(null, '0.00')).toEqual([]);
  });
});

describe('pickFeatured', () => {
  it('uses featuredId when that duel is present', () => {
    const list = [duel('1'), duel('2')];
    expect(pickFeatured(list, '1', BOTS)?.id).toBe('1');
  });

  it('falls back to the newest non-bot duel when featuredId is null or unknown', () => {
    const list = [duel('1'), botDuel('5'), duel('3'), duel('2')];
    expect(pickFeatured(list, null, BOTS)?.id).toBe('3');
    expect(pickFeatured(list, '99', BOTS)?.id).toBe('3');
  });

  it('compares numeric ids, not strings', () => {
    expect(pickFeatured([duel('9'), duel('10')], null, BOTS)?.id).toBe('10');
  });

  it('counts a duel with one human side as non-bot (bot vs human)', () => {
    const list = [duel('1', { p1: BOT_A, p2: GUEST })];
    expect(pickFeatured(list, null, BOTS)?.id).toBe('1');
  });

  it('skips bot-only and still-open duels', () => {
    const list = [botDuel('4'), duel('3', { status: 'Open', p2: ZERO })];
    expect(pickFeatured(list, null, BOTS)).toBeNull();
  });

  it('matches bot addresses case-insensitively', () => {
    const lower = BOT_A.toLowerCase() as Hex;
    expect(pickFeatured([duel('1', { p1: lower, p2: BOT_B })], null, BOTS)).toBeNull();
  });

  it('keeps a finished duel as the fallback', () => {
    expect(pickFeatured([duel('1', { status: 'P1Won', settled: true })], null, BOTS)?.id).toBe('1');
  });

  it('is null for no duels', () => {
    expect(pickFeatured([], null, BOTS)).toBeNull();
  });
});

describe('swarmDuels', () => {
  const BLOCK = 120;

  it('includes active and just-finished unsettled duels, excluding the featured one', () => {
    const list = [
      duel('1'),
      botDuel('2'),
      botDuel('3', { status: 'P1Won' }),
      botDuel('4', { status: 'P2Won', settled: true }),
      duel('5', { status: 'Open', p2: ZERO }),
    ];
    expect(swarmDuels(list, '1', BLOCK).map((d) => d.id)).toEqual(['2', '3']);
  });

  it('keeps a stable order by numeric id', () => {
    const list = [botDuel('10'), botDuel('9'), botDuel('2')];
    expect(swarmDuels(list, null, BLOCK).map((d) => d.id)).toEqual(['2', '9', '10']);
  });

  it('drops duels stuck unsettled long after their end block', () => {
    const stale = botDuel('7', { endBlock: BLOCK - 500 });
    const fresh = botDuel('8', { endBlock: BLOCK - 5 });
    expect(swarmDuels([stale, fresh], null, BLOCK).map((d) => d.id)).toEqual(['8']);
  });

  it('is empty when nothing qualifies', () => {
    expect(swarmDuels([duel('1')], '1', BLOCK)).toEqual([]);
  });
});

describe('duelStatusText', () => {
  const labels = { p1: '0x00…01', p2: 'AI Agent' };

  it('counts down before the start block', () => {
    expect(duelStatusText(duel('1', { startBlock: 110, endBlock: 177 }), 100, labels)).toBe('Starts in 3s');
  });

  it('shows seconds left while active', () => {
    expect(duelStatusText(duel('1', { startBlock: 110, endBlock: 177 }), 150, labels)).toBe('9s left');
  });

  it('shows 0s left at or past the end block until the result lands', () => {
    expect(duelStatusText(duel('1', { endBlock: 177 }), 180, labels)).toBe('0s left');
  });

  it('names the winner or a draw', () => {
    expect(duelStatusText(duel('1', { status: 'P1Won' }), 200, labels)).toBe('0x00…01 wins');
    expect(duelStatusText(duel('1', { status: 'P2Won' }), 200, labels)).toBe('AI Agent wins');
    expect(duelStatusText(duel('1', { status: 'Draw' }), 200, labels)).toBe('Draw');
  });

  it('waits for an opponent while open', () => {
    expect(duelStatusText(duel('1', { status: 'Open', p2: ZERO }), 0, labels)).toBe('Waiting for an opponent');
  });
});

describe('tileStatusText', () => {
  it('counts down, shows seconds left, and marks finished duels', () => {
    const d = duel('1', { startBlock: 110, endBlock: 177 });
    expect(tileStatusText(d, 100)).toBe('Starts in 3s');
    expect(tileStatusText(d, 150)).toBe('9s left');
    expect(tileStatusText(duel('1', { status: 'P2Won' }), 150)).toBe('Finished');
    expect(tileStatusText(duel('1', { status: 'Draw' }), 150)).toBe('Finished');
  });
});
