import type { Hex } from '@nad/shared';
import type { TransactionReceipt } from 'viem';
import { describe, expect, test, vi } from 'vitest';
import { BOARD_EMPTY, MATCH_WINDOW_SIZE } from '../src/battle';
import type { ChainLike } from '../src/chainTypes';
import { startPoller } from '../src/poller';
import type { ReceiptHub } from '../src/receiptHub';
import type { MatchesMsg, WsMessage } from '../src/ws';

vi.mock('ws', () => ({ WebSocketServer: class {} }));

const BATTLE = '0x00000000000000000000000000000000000000b1' as Hex;
const ARENA = '0x00000000000000000000000000000000000000a1' as Hex;
const CARDS = '0x00000000000000000000000000000000000000c1' as Hex;
const P1 = '0x0000000000000000000000000000000000000001' as Hex;
const P2 = '0x0000000000000000000000000000000000000002' as Hex;

const zeros = (n: number): number[] => new Array<number>(n).fill(0);

function rawMatch(id: bigint, status = 1): Record<string, unknown> {
  return {
    p1: P1,
    p2: P2,
    status,
    turn: id % 2n === 0n ? 1 : 2,
    score1: 0,
    score2: 0,
    lastMoveBlock: 100,
    special1: false,
    special2: false,
    drawn1: 1,
    drawn2: 1,
    placed1: 0,
    placed2: 0,
    el1: zeros(10),
    el2: zeros(10),
    rar1: zeros(10),
    rar2: zeros(10),
    atk1: zeros(10),
    atk2: zeros(10),
    maxHp1: zeros(10),
    maxHp2: zeros(10),
    hp1: zeros(10),
    hp2: zeros(10),
    board1: [BOARD_EMPTY, BOARD_EMPTY, BOARD_EMPTY],
    board2: [BOARD_EMPTY, BOARD_EMPTY, BOARD_EMPTY],
  };
}

function makeHarness(matchCount: bigint, subscribed: string[] = []) {
  const reads: { fn: string; from?: bigint; count?: bigint; id?: bigint }[] = [];
  const client = {
    readContract: vi.fn(async (p: { functionName: string; args?: bigint[] }) => {
      const [first, second] = p.args ?? [];
      reads.push({ fn: p.functionName, from: first, count: second, id: first });
      if (p.functionName === 'duelCount') return 0n;
      if (p.functionName === 'matchCount') return matchCount;
      if (p.functionName === 'getMatches') {
        return Array.from({ length: Number(second) }, (_, i) => rawMatch((first ?? 1n) + BigInt(i)));
      }
      if (p.functionName === 'getMatch') return rawMatch(first ?? 1n, 2);
      throw new Error(`unexpected read ${p.functionName}`);
    }),
    getBalance: vi.fn(async () => 0n),
  };
  const chain = { client, call: <T>(fn: (c: unknown) => Promise<T>) => fn(client) } as unknown as ChainLike;

  const listeners: ((block: bigint, receipts: TransactionReceipt[]) => void)[] = [];
  const hub = { onIngest: (cb: (typeof listeners)[number]) => void listeners.push(cb) } as unknown as ReceiptHub;
  const sent: WsMessage[] = [];
  const subs = new Set(subscribed);
  const ws = {
    broadcast: vi.fn((m: WsMessage) => void sent.push(m)),
    onConnect: vi.fn(),
    subscribedIds: () => new Set<string>(),
    subscribedMatchIds: () => subs,
  };
  const poller = startPoller({
    chain,
    hub,
    ws,
    stats: { snapshot: () => ({ txTotal: 0, txPerSec: 0, avgLatencyMs: 0 }) },
    arena: ARENA,
    cards: CARDS,
    battle: BATTLE,
    operator: { send: vi.fn(async () => '0xabc' as Hex) },
    settleGas: 100_000n,
    bots: () => [],
    getAgentMessage: () => null,
    pollMs: 1,
    now: () => 0,
  });
  return { poller, sent, reads, ingest: (block: number) => listeners.forEach((cb) => cb(BigInt(block), [])) };
}

const matchesMessages = (sent: WsMessage[]): MatchesMsg[] => sent.filter((m): m is MatchesMsg => m.type === 'matches');

describe('poller matches feed', () => {
  test('reads the last 64 matches with a 1-based from id and caches getMatch views', async () => {
    const h = makeHarness(70n);
    h.ingest(500);

    await vi.waitFor(() => expect(matchesMessages(h.sent)).toHaveLength(1));
    const getMatches = h.reads.filter((r) => r.fn === 'getMatches');
    expect(getMatches).toEqual([{ fn: 'getMatches', from: 7n, count: 64n, id: 7n }]);

    const msg = matchesMessages(h.sent)[0] as MatchesMsg;
    expect(msg.block).toBe('500');
    expect(msg.matches).toHaveLength(MATCH_WINDOW_SIZE);
    expect(msg.matches[0]?.id).toBe('7');
    expect(msg.matches.at(-1)?.id).toBe('70');
    expect(msg.featuredId).toBe('70');

    expect(h.poller.battleMatch('70')?.id).toBe('70');
    expect(h.poller.battleMatches()).toHaveLength(MATCH_WINDOW_SIZE);
    h.poller.stop();
  });

  test('re-reads a subscribed match outside the window with getMatch', async () => {
    const h = makeHarness(70n, ['3']);
    h.ingest(501);

    await vi.waitFor(() => expect(matchesMessages(h.sent)).toHaveLength(1));
    const getMatch = h.reads.filter((r) => r.fn === 'getMatch');
    expect(getMatch).toEqual([{ fn: 'getMatch', from: 3n, count: undefined, id: 3n }]);

    const msg = matchesMessages(h.sent)[0] as MatchesMsg;
    expect(msg.matches.map((m) => m.id)).toContain('3');
    expect(h.poller.battleMatch('3')).toBeDefined();
    h.poller.stop();
  });

  test('does not emit matches before the battle contract is configured', async () => {
    // Same harness but without `battle`: the feed must stay silent while duels still flow.
    const client = {
      readContract: vi.fn(async (p: { functionName: string }) => (p.functionName === 'duelCount' ? 0n : [])),
      getBalance: vi.fn(async () => 0n),
    };
    const chain = { client, call: <T>(fn: (c: unknown) => Promise<T>) => fn(client) } as unknown as ChainLike;
    const listeners: ((block: bigint, receipts: TransactionReceipt[]) => void)[] = [];
    const hub = { onIngest: (cb: (typeof listeners)[number]) => void listeners.push(cb) } as unknown as ReceiptHub;
    const sent2: WsMessage[] = [];
    const poller = startPoller({
      chain,
      hub,
      ws: { broadcast: (m) => void sent2.push(m), onConnect: vi.fn() },
      stats: { snapshot: () => ({ txTotal: 0, txPerSec: 0, avgLatencyMs: 0 }) },
      arena: ARENA,
      cards: CARDS,
      operator: { send: vi.fn(async () => '0xabc' as Hex) },
      settleGas: 100_000n,
      bots: () => [],
      getAgentMessage: () => null,
      pollMs: 1,
      now: () => 0,
    });
    listeners.forEach((cb) => cb(502n, []));
    await vi.waitFor(() => expect(sent2.some((m) => m.type === 'duels')).toBe(true));
    expect(sent2.some((m) => m.type === 'matches')).toBe(false);
    poller.stop();
  });
});