import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Hex } from 'viem';
import type { AgentMsg, Config, DuelView, StatsMsg } from '../src/lib/types';
import { AgentPanel } from '../src/routes/arena/AgentPanel';
import { Header } from '../src/routes/arena/Header';
import { Leaderboard } from '../src/routes/arena/Leaderboard';
import { SwarmGrid } from '../src/routes/arena/SwarmGrid';

const CARDS: Hex = '0x1111111111111111111111111111111111111111';
const ARENA: Hex = '0x2222222222222222222222222222222222222222';
const TX: Hex = '0xabcdef0000000000000000000000000000000000000000000000000000001234';

const CONFIG = {
  contracts: { cards: CARDS, arena: ARENA },
  event: { name: 'NadGacha BlitzArena', sponsor: 'Monad Blitz Jogja' },
} as Config;

const STATS: StatsMsg = {
  type: 'stats',
  block: '1',
  txTotal: 1234,
  txPerSec: 3,
  avgLatencyMs: 300,
  uniquePlayers: 0,
  totalDuels: 0,
  treasury: '0',
};

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('Header', () => {
  it('shows event, sponsor, both contract links, the testnet label and the live state', () => {
    const html = render(<Header config={CONFIG} stats={STATS} block={73_562_100} connected />);
    expect(html).toContain('NadGacha BlitzArena');
    expect(html).toContain('Presented by Monad Blitz Jogja');
    expect(html).toContain('Monad testnet');
    expect(html).toContain(`href="https://testnet.monadscan.com/address/${CARDS}"`);
    expect(html).toContain(`href="https://testnet.monadscan.com/address/${ARENA}"`);
    expect(html).toContain('Cards');
    expect(html).toContain('Arena');
    expect(html).toContain('#73,562,100');
    expect(html).toContain('Live');
  });

  it('hides zero stats and keeps the tx count', () => {
    const html = render(<Header config={CONFIG} stats={STATS} block={1} connected />);
    expect(html).toContain('1,234 onchain tx');
    expect(html).not.toContain('players');
    expect(html).not.toContain('duels');
    expect(html).not.toContain('Treasury');
  });

  it('shows every stat with a middle dot when all are non-zero', () => {
    const stats = { ...STATS, uniquePlayers: 12, totalDuels: 1500, treasury: '1250000000000000000' };
    const html = render(<Header config={CONFIG} stats={stats} block={1} connected />);
    expect(html).toContain('12 players');
    expect(html).toContain('1,500 duels');
    expect(html).toContain('Treasury 1.25 MON');
  });

  it('links the latest tx only when the server sent one', () => {
    expect(render(<Header config={CONFIG} stats={STATS} block={1} connected />)).not.toContain('Latest tx');
    const html = render(<Header config={CONFIG} stats={{ ...STATS, lastTxHash: TX }} block={1} connected />);
    expect(html).toContain('Latest tx');
    expect(html).toContain(`href="https://testnet.monadscan.com/tx/${TX}"`);
  });

  it('omits the sponsor when null and shows Reconnecting… when offline', () => {
    const config = { ...CONFIG, event: { name: 'Solo', sponsor: null } } as Config;
    const html = render(<Header config={config} stats={null} block={0} connected={false} />);
    expect(html).not.toContain('Presented by');
    expect(html).toContain('Reconnecting…');
  });

  it('never prints a full address or hash as text', () => {
    const html = render(<Header config={CONFIG} stats={{ ...STATS, lastTxHash: TX }} block={1} connected />);
    const text = html.replace(/<[^>]*>/g, '');
    expect(text).not.toMatch(/0x[0-9a-fA-F]{12,}/);
  });
});

const AGENT: AgentMsg = {
  type: 'agent',
  level: 3,
  threshold: 40,
  finisher: false,
  sim: { duels: 12_000, wins: 6000 },
  testnet: { duels: 4, wins: 3 },
  lessons: [
    { at: 1, duelId: '1', text: 'oldest', thresholdFrom: 30, thresholdTo: 40 },
    { at: 6, duelId: '6', text: 'newest', thresholdFrom: 40, thresholdTo: 30 },
    { at: 2, duelId: '2', text: 'second', thresholdFrom: 30, thresholdTo: 40 },
    { at: 3, duelId: '3', text: 'third', thresholdFrom: 30, thresholdTo: 40 },
    { at: 4, duelId: '4', text: 'fourth', thresholdFrom: 30, thresholdTo: 40 },
    { at: 5, duelId: '5', text: 'fifth', thresholdFrom: 30, thresholdTo: 40 },
  ],
};

describe('AgentPanel', () => {
  it('warms up before the first agent message', () => {
    expect(render(<AgentPanel agent={null} />)).toContain('AI Agent is warming up…');
  });

  it('shows level, win rate, counts, threshold and the 5 newest lessons', () => {
    const html = render(<AgentPanel agent={AGENT} />);
    expect(html).toContain('Lv.3');
    expect(html).toContain('75% win rate');
    expect(html).toContain('Simulated: 12,000 duels · Testnet: 4 onchain duels');
    expect(html).toContain('Skill threshold 40%');
    expect(html).toContain('40% → 30%');
    expect(html.indexOf('newest')).toBeLessThan(html.indexOf('fifth'));
    expect(html).not.toContain('oldest');
  });

  it('hides the win rate when no testnet duels were played', () => {
    const html = render(<AgentPanel agent={{ ...AGENT, testnet: { duels: 0, wins: 0 }, lessons: [] }} />);
    expect(html).not.toContain('win rate');
  });
});

describe('Leaderboard', () => {
  it('lists the top 10 with label or short address and the record', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      address: `0x${String(i + 1).padStart(40, '0')}` as Hex,
      label: i === 0 ? 'Alice' : null,
      wins: 12 - i,
      losses: i,
      cardId: String(i),
    }));
    const html = render(<Leaderboard entries={entries} />);
    expect(html).toContain('Alice');
    expect(html).toContain('12 W · 0 L');
    expect(html).toContain('0x00…02');
    expect((html.match(/<li/g) ?? []).length).toBe(10);
  });
});

describe('SwarmGrid', () => {
  const duel = (id: string): DuelView =>
    ({
      id,
      hp1: 750,
      maxHp1: 1500,
      hp2: 1500,
      maxHp2: 1500,
      status: 'Active',
      startBlock: 10,
      endBlock: 77,
    }) as DuelView;

  it('renders nothing when there are no tiles', () => {
    expect(render(<SwarmGrid duels={[]} block={20} />)).toBe('');
  });

  it('renders a tile with the id, both tracks (P1 purple, P2 berry) and seconds left', () => {
    const html = render(<SwarmGrid duels={[duel('7')]} block={50} />);
    expect(html).toContain('#7');
    expect(html).toContain('bg-purple');
    expect(html).toContain('bg-berry');
    expect(html).toContain('width:50%');
    expect(html).toContain('9s left');
  });
});
