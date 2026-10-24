import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { parseWsMessage } from '../src/lib/arenaState';
import { COUNTDOWN_BLOCKS } from '../src/lib/game';
import type { DuelView, WsMessage } from '../src/lib/types';
import { createMockChain } from '../src/mock/chain';
import type { MockChain } from '../src/mock/chain';
import { createMockSocket } from '../src/mock/socket';

const PAUSE_BLOCKS = 20;
const MAX_TICKS = 600;
let chain: MockChain;

/** Small deterministic generator so the duel flow is repeatable. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  chain = createMockChain({ blockMs: 0, rng: seeded(7) });
  chain.disableAutoFriend();
});

afterEach(() => {
  chain.dispose();
  vi.useRealTimers();
});

const ticks = (n: number) => {
  for (let i = 0; i < n; i++) chain.tick();
};
/** Tick until `done()`; fails the test when it never happens. */
function runUntil(done: () => boolean, max = MAX_TICKS): number {
  for (let i = 0; i < max; i++) {
    if (done()) return i;
    chain.tick();
  }
  throw new Error('condition not reached');
}
const isBot = (a: Hex) => chain.config.bots.some((b) => b.toLowerCase() === a.toLowerCase());
const botOnly = (d: DuelView) => isBot(d.p1) && isBot(d.p2);
const isAgent = (a: Hex) => a.toLowerCase() === chain.config.agent.toLowerCase();
const isGuestVsAgent = (d: DuelView) =>
  (isAgent(d.p1) || isAgent(d.p2)) && [d.p1, d.p2].some((a) => !isBot(a) && !isAgent(a));
const guestDuels = () => chain.duels().filter(isGuestVsAgent);

describe('mock showcase', () => {
  it('config exposes enough bot addresses for three bot-vs-bot lanes plus the friend', () => {
    expect(new Set(chain.config.bots.map((b) => b.toLowerCase())).size).toBe(chain.config.bots.length);
    expect(chain.config.bots.length).toBeGreaterThanOrEqual(7);
    expect(chain.config.bots).not.toContain(chain.config.agent);
  });

  it('does nothing until started', () => {
    ticks(30);
    expect(chain.duels()).toHaveLength(0);
  });

  it('starts an AI Agent vs guest duel immediately, with a guest that is not a bot', () => {
    chain.startShowcase();
    const duels = chain.duels();
    expect(duels).toHaveLength(1);
    expect(isGuestVsAgent(duels[0]!)).toBe(true);
    expect(duels[0]!.status).toBe('Active');
  });

  it('brings in three bot-vs-bot lanes shortly after', () => {
    chain.startShowcase();
    ticks(20);
    const active = chain.duels().filter((d) => d.status === 'Active');
    expect(active.filter(botOnly)).toHaveLength(3);
    expect(active.filter(isGuestVsAgent)).toHaveLength(1);
  });

  it('bots tap: both sides lose hp over time', () => {
    chain.startShowcase();
    ticks(COUNTDOWN_BLOCKS + 15);
    const d = chain.duels()[0]!;
    expect(d.hp1).toBeLessThan(d.maxHp1);
    expect(d.hp2).toBeLessThan(d.maxHp2);
  });

  it('restarts every lane after its duel settles', () => {
    chain.startShowcase();
    runUntil(() => chain.duels().length > 4 && chain.duels().slice(0, 4).every((d) => d.settled));
    ticks(1);
    const active = chain.duels().filter((d) => d.status === 'Active');
    expect(active.filter(isGuestVsAgent).length).toBeLessThanOrEqual(1);
    expect(guestDuels().length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the last result on screen for the pause before the lane restarts', () => {
    chain.startShowcase();
    runUntil(() => chain.duels()[0]!.settled);
    ticks(PAUSE_BLOCKS - 4);
    expect(guestDuels()).toHaveLength(1);
    runUntil(() => guestDuels().length === 2, PAUSE_BLOCKS);
    expect(guestDuels()[1]!.status).toBe('Active');
  });

  it('the AI Agent learns from its showcase duels', () => {
    chain.startShowcase();
    expect(chain.agentMsg().testnet.duels).toBe(0);
    runUntil(() => chain.duels()[0]!.settled);
    expect(chain.agentMsg().testnet.duels).toBe(1);
    expect(chain.agentMsg().lessons).toHaveLength(1);
  });

  it('stop() ends it and cancels restarts; start is reference counted', () => {
    const stopA = chain.startShowcase();
    const stopB = chain.startShowcase();
    ticks(20);
    const created = chain.duels().length;
    stopA();
    stopA(); // idempotent
    runUntil(() => chain.duels().length > created);
    stopB();
    const afterStop = chain.duels().length;
    ticks(300);
    expect(chain.duels()).toHaveLength(afterStop);
  });

  it('never features a bot-only duel, and features nothing while only bots are fighting', () => {
    chain.startShowcase();
    let botsOnlyMoments = 0;
    for (let i = 0; i < 300; i++) {
      chain.tick();
      const msg = chain.duelsMsg('all');
      const active = msg.duels.filter((d) => d.status === 'Active');
      const featured = msg.duels.find((d) => d.id === msg.featuredId);
      if (featured) {
        expect(isGuestVsAgent(featured)).toBe(true);
        expect(featured.status).toBe('Active');
      } else if (active.length > 0) {
        botsOnlyMoments += 1;
        expect(active.every(botOnly)).toBe(true);
      }
    }
    expect(botsOnlyMoments).toBeGreaterThan(0);
  });

  it('statsMsg carries a lastTxHash once any tx happened, and counts showcase latency', () => {
    expect(chain.statsMsg().lastTxHash).toBeUndefined();
    chain.startShowcase();
    ticks(COUNTDOWN_BLOCKS + 10);
    const stats = chain.statsMsg();
    expect(stats.txTotal).toBeGreaterThan(0);
    expect(stats.lastTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(stats.avgLatencyMs).toBeGreaterThan(0);
    const before = stats.lastTxHash;
    ticks(6);
    expect(chain.statsMsg().lastTxHash).not.toBe(before);
  });
});

describe('mock socket showcase option', () => {
  const flush = () => Promise.resolve();

  function connect(showcase: boolean) {
    const messages: WsMessage[] = [];
    const socket = createMockSocket('ws://localhost/ws?scope=all', chain, { showcase });
    socket.onmessage = (ev) => {
      const msg = parseWsMessage(ev.data);
      if (msg) messages.push(msg);
    };
    return { socket, messages };
  }

  it('starts the showcase on connect and stops it on close', async () => {
    const { socket, messages } = connect(true);
    await flush();
    expect(chain.duels().length).toBeGreaterThan(0);
    const duelsMsg = messages.find((m) => m.type === 'duels');
    expect(duelsMsg?.type === 'duels' && duelsMsg.duels.length).toBeGreaterThan(0);
    socket.close();
    const n = chain.duels().length;
    ticks(300);
    expect(chain.duels()).toHaveLength(n);
  });

  it('does not start it for a duel scope or when the option is off', async () => {
    connect(false);
    createMockSocket('ws://localhost/ws?scope=duel:0', chain, { showcase: true });
    await flush();
    expect(chain.duels()).toHaveLength(0);
  });

  it('close() before the connect microtask never starts it', async () => {
    const { socket } = connect(true);
    socket.close();
    await flush();
    expect(chain.duels()).toHaveLength(0);
  });
});
