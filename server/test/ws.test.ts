import type { DuelView } from '@nad/shared';
import { describe, expect, test, vi } from 'vitest';

// `ws` may not be installed for the server package yet; the core under test never touches it.
vi.mock('ws', () => ({ WebSocketServer: class {} }));

import { createWsHubCore, parseScope, type AgentMsg, type DuelsMsg, type StatsMsg, type WsMessage } from '../src/ws';

const duel = (id: string): DuelView =>
  ({ id, p1: '0x01', p2: '0x02', status: 'Active', settled: false }) as unknown as DuelView;

const duelsMsg = (ids: string[], block = '100'): DuelsMsg => ({
  type: 'duels',
  block,
  duels: ids.map(duel),
  featuredId: null,
});
const statsMsg: StatsMsg = {
  type: 'stats',
  block: '100',
  txTotal: 1,
  txPerSec: 2,
  avgLatencyMs: 3,
  uniquePlayers: 0,
  totalDuels: 0,
  treasury: '0',
};
const agentMsg: AgentMsg = {
  type: 'agent',
  level: 1,
  threshold: 5,
  finisher: false,
  sim: { duels: 0, wins: 0 },
  testnet: { duels: 0, wins: 0 },
  lessons: [],
};

function fakeSocket(readyState: number | undefined = 1) {
  const sent: string[] = [];
  const sock: { send(d: string): void; readyState?: number } = { send: (d) => void sent.push(d) };
  if (readyState !== undefined) sock.readyState = readyState;
  return { sock, sent, parsed: (): WsMessage[] => sent.map((s) => JSON.parse(s) as WsMessage) };
}

describe('parseScope', () => {
  test('defaults to all when absent', () => {
    expect(parseScope('/ws')).toBe('all');
    expect(parseScope(undefined)).toBe('all');
  });
  test('parses scope=all', () => expect(parseScope('/ws?scope=all')).toBe('all'));
  test('parses scope=duel:<digits>', () => {
    expect(parseScope('/ws?scope=duel:42')).toEqual({ duelId: '42' });
  });
  test('normalises leading zeros so it matches DuelView ids', () => {
    expect(parseScope('/ws?scope=duel:007')).toEqual({ duelId: '7' });
  });
  test('invalid scopes fall back to all', () => {
    for (const bad of ['duel:', 'duel:abc', 'duel:-1', 'duel:1.5', 'foo', '', 'duel:99999999999999999999999']) {
      expect(parseScope(`/ws?scope=${bad}`)).toBe('all');
    }
  });
});

describe('ws hub core', () => {
  test('duel-scoped connection only receives its duel', () => {
    const core = createWsHubCore();
    const a = fakeSocket();
    core.add(a.sock, { duelId: '2' });
    core.broadcast(duelsMsg(['1', '2', '3']));
    const [msg] = a.parsed() as DuelsMsg[];
    expect(msg!.duels.map((d) => d.id)).toEqual(['2']);
    expect(msg!.block).toBe('100');
  });

  test('scoped connection still gets a duels message (empty) when its duel is absent', () => {
    const core = createWsHubCore();
    const a = fakeSocket();
    core.add(a.sock, { duelId: '9' });
    core.broadcast(duelsMsg(['1', '2'], '555'));
    const [msg] = a.parsed() as DuelsMsg[];
    expect(msg).toMatchObject({ type: 'duels', block: '555', duels: [] });
  });

  test('all-scope connection receives every duel and every message type', () => {
    const core = createWsHubCore();
    const a = fakeSocket();
    core.add(a.sock, 'all');
    core.broadcast(duelsMsg(['1', '2', '3']));
    core.broadcast(statsMsg);
    core.broadcast(agentMsg);
    core.broadcast({ type: 'taunt', duelId: '7', text: 'hi' });
    const msgs = a.parsed();
    expect(msgs.map((m) => m.type)).toEqual(['duels', 'stats', 'agent', 'taunt']);
    expect((msgs[0] as DuelsMsg).duels).toHaveLength(3);
  });

  test('taunts reach only the connection scoped to that duel (and all)', () => {
    const core = createWsHubCore();
    const mine = fakeSocket();
    const other = fakeSocket();
    const all = fakeSocket();
    core.add(mine.sock, { duelId: '7' });
    core.add(other.sock, { duelId: '8' });
    core.add(all.sock, 'all');
    core.broadcast({ type: 'taunt', duelId: '7', text: 'gg' });
    expect(mine.parsed()).toHaveLength(1);
    expect(other.parsed()).toHaveLength(0);
    expect(all.parsed()).toHaveLength(1);
  });

  test('stats and agent reach scoped connections too', () => {
    const core = createWsHubCore();
    const a = fakeSocket();
    core.add(a.sock, { duelId: '1' });
    core.broadcast(statsMsg);
    core.broadcast(agentMsg);
    expect(a.parsed().map((m) => m.type)).toEqual(['stats', 'agent']);
  });

  test('skips sockets that are not open but keeps sockets without readyState', () => {
    const core = createWsHubCore();
    const closed = fakeSocket(3);
    const connecting = fakeSocket(0);
    const bare = fakeSocket(undefined);
    for (const s of [closed, connecting, bare]) core.add(s.sock, 'all');
    core.broadcast(statsMsg);
    expect(closed.sent).toHaveLength(0);
    expect(connecting.sent).toHaveLength(0);
    expect(bare.sent).toHaveLength(1);
  });

  test('a socket whose send throws is removed and does not break the others', () => {
    const core = createWsHubCore();
    const bad = { send: () => { throw new Error('boom'); }, readyState: 1 };
    const good = fakeSocket();
    core.add(bad, 'all');
    core.add(good.sock, 'all');
    core.broadcast(statsMsg);
    expect(good.sent).toHaveLength(1);
    expect(core.size()).toBe(1);
  });

  test('serializes once per distinct payload', () => {
    const core = createWsHubCore();
    const spy = vi.spyOn(JSON, 'stringify');
    const socks = [fakeSocket(), fakeSocket(), fakeSocket(), fakeSocket()];
    core.add(socks[0]!.sock, 'all');
    core.add(socks[1]!.sock, 'all');
    core.add(socks[2]!.sock, { duelId: '1' });
    core.add(socks[3]!.sock, { duelId: '1' });
    spy.mockClear();
    core.broadcast(duelsMsg(['1', '2']));
    expect(spy).toHaveBeenCalledTimes(2); // one for 'all', one for duel:1
    expect(socks[0]!.sent[0]).toBe(socks[1]!.sent[0]);
    spy.mockRestore();
  });

  test('remove and size', () => {
    const core = createWsHubCore();
    const a = fakeSocket();
    core.add(a.sock, 'all');
    expect(core.size()).toBe(1);
    core.remove(a.sock);
    expect(core.size()).toBe(0);
    core.broadcast(statsMsg);
    expect(a.sent).toHaveLength(0);
  });

  test('onConnect callbacks run on add with a scope-filtered send', () => {
    const core = createWsHubCore();
    const seen: unknown[] = [];
    core.onConnect((send, scope) => {
      seen.push(scope);
      send(duelsMsg(['1', '2', '3']));
      send(statsMsg);
    });
    const a = fakeSocket();
    core.add(a.sock, { duelId: '3' });
    expect(seen).toEqual([{ duelId: '3' }]);
    const [first, second] = a.parsed();
    expect((first as DuelsMsg).duels.map((d) => d.id)).toEqual(['3']);
    expect(second!.type).toBe('stats');
  });

  test('a throwing onConnect callback does not prevent the connection', () => {
    const core = createWsHubCore();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.onConnect(() => { throw new Error('bad'); });
    const a = fakeSocket();
    core.add(a.sock, 'all');
    expect(core.size()).toBe(1);
    core.broadcast(statsMsg);
    expect(a.sent).toHaveLength(1);
  });

  test('leaderboard messages are never delivered to scoped connections', () => {
    const core = createWsHubCore();
    const a = fakeSocket();
    core.add(a.sock, { duelId: '1' });
    core.broadcast({ type: 'leaderboard', entries: [] });
    expect(a.sent).toHaveLength(0);
  });
});
