import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import type { Hex } from 'viem';
import { parseWsMessage } from '../src/lib/arenaState';
import type { WsMessage } from '../src/lib/types';
import { createMockApi } from '../src/mock/api';
import { createMockChain } from '../src/mock/chain';
import type { MockChain } from '../src/mock/chain';
import { createMockSocket } from '../src/mock/socket';

const ALICE = '0x00000000000000000000000000000000000a11ce' as const;
const BOB = '0x0000000000000000000000000000000000000b0b' as const;

let chain: MockChain;

beforeEach(() => {
  vi.useFakeTimers();
  chain = createMockChain({ blockMs: 0 });
  chain.disableAutoFriend();
});

afterEach(() => {
  chain.dispose();
  vi.useRealTimers();
});

function collect(url: string) {
  const messages: WsMessage[] = [];
  const socket = createMockSocket(url, chain);
  let opened = 0;
  socket.onopen = () => (opened += 1);
  socket.onmessage = (ev) => {
    const msg = parseWsMessage(ev.data);
    if (msg) messages.push(msg);
  };
  return { socket, messages, opened: () => opened };
}

const flush = () => Promise.resolve();

function makeDuel(addr: Hex) {
  const card = chain.freePull(addr).events.tokenId!;
  return chain.createDuel(addr, card).events.duelId!;
}

describe('mock socket', () => {
  it('opens on a microtask and sends duels, stats and agent snapshots', async () => {
    makeDuel(ALICE);
    const { messages, opened } = collect('ws://localhost/ws?scope=all');
    expect(opened()).toBe(0);
    await flush();
    expect(opened()).toBe(1);
    expect(messages.map((m) => m.type)).toEqual(['duels', 'stats', 'agent']);
    const duels = messages[0];
    expect(duels?.type === 'duels' && duels.duels.map((d) => d.id)).toEqual(['0']);
  });

  it('scope=duel:<id> only includes that duel', async () => {
    makeDuel(ALICE);
    makeDuel(BOB);
    const { messages } = collect('ws://localhost/ws?scope=duel:1');
    await flush();
    const duels = messages[0];
    expect(duels?.type === 'duels' && duels.duels.map((d) => d.id)).toEqual(['1']);
  });

  it('sends duels and stats on every block, agent on lesson changes, and never a leaderboard', async () => {
    const { messages, socket } = collect('ws://localhost/ws?scope=all');
    await flush();
    messages.length = 0;
    chain.tick();
    chain.tick();
    expect(messages.map((m) => m.type)).toEqual(['duels', 'stats', 'duels', 'stats']);
    const last = messages.at(-1);
    expect(last?.type === 'stats' && last.block).toBe(String(chain.block()));

    socket.close();
    messages.length = 0;
    chain.tick();
    expect(messages).toEqual([]);
    expect(messages.some((m) => m.type === 'leaderboard')).toBe(false);
  });

  it('reports treasury, zero unique players and zero total duels', async () => {
    chain.credit(ALICE, parseEther('1'));
    chain.paidPull(ALICE, parseEther('0.05'));
    const { messages } = collect('ws://localhost/ws?scope=all');
    await flush();
    const stats = messages.find((m) => m.type === 'stats');
    expect(stats).toMatchObject({ treasury: parseEther('0.05').toString(), uniquePlayers: 0, totalDuels: 0 });
  });

  it('pushes an agent message when the AI Agent learns from a duel', async () => {
    const duelId = makeDuel(ALICE);
    chain.challengeAgent(duelId);
    vi.advanceTimersByTime(1500);
    const { messages } = collect('ws://localhost/ws?scope=all');
    await flush();
    messages.length = 0;
    for (let i = 0; i < 200 && !messages.some((m) => m.type === 'agent'); i++) chain.tick();
    const agent = messages.find((m) => m.type === 'agent');
    expect(agent?.type === 'agent' && agent.lessons[0]?.duelId).toBe(duelId);
  });

  it('close() before the microtask suppresses the open', async () => {
    const { socket, opened } = collect('ws://localhost/ws?scope=all');
    socket.close();
    await flush();
    expect(opened()).toBe(0);
  });
});

describe('mock api', () => {
  it('serves the stable config and account/fund/card/challenge over the chain', async () => {
    const api = createMockApi(() => chain);
    const config = await api.getConfig();
    expect(config).toMatchObject({
      chainId: 10143,
      batchMs: 1000,
      pullPrice: '50000000000000000',
      event: { name: 'NadGacha BlitzArena', sponsor: 'Monad Blitz Jogja' },
    });
    expect(config.bots).toHaveLength(1);

    expect(await api.getAccount(ALICE)).toEqual({ nonce: 0, balance: '0', cardId: null, hasPulled: false });
    expect(await api.fund(ALICE)).toMatchObject({ funded: true });
    expect(await api.getCard('1')).toBeNull();
    expect(await api.challengeAgent('9')).toEqual({ ok: false, reason: 'not_open' });
  });
});
