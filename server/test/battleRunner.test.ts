import type { Hex } from '@nad/shared';
import { decodeFunctionData, type PublicClient, type TransactionReceipt } from 'viem';
import { describe, expect, test } from 'vitest';
import { BATTLE_RUN_MS, createBattleRunner, type BattleRunnerDeps } from '../src/agent/battleRunner';
import { BOARD_EMPTY, TURN_TIMEOUT_BLOCKS, decodeMatches } from '../src/battle';
import { battleAbi } from '../src/battleAbi';

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;
const AGENT = addr(0xa1);
const PLAYER = addr(0xb2);
const ZERO = addr(0);
const BATTLE = addr(0xb0);

type RawMatch = Record<string, unknown>;
type Send = { fn: string; id: bigint };

const zeros = (n: number): number[] => new Array<number>(n).fill(0);

const match = (over: RawMatch = {}): RawMatch => ({
  p1: PLAYER,
  p2: ZERO,
  status: 0,
  turn: 0,
  score1: 0,
  score2: 0,
  lastMoveBlock: 100,
  special1: false,
  special2: false,
  drawn1: 1,
  drawn2: 0,
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
  ...over,
});

/** Fake chain + queue: join flips a match Active, claimTimeout finishes it for p2. */
function harness(options: { block?: number; clockStepMs?: number } = {}) {
  const matches = new Map<string, RawMatch>();
  const sends: Send[] = [];
  const step = options.clockStepMs ?? 1;
  let block = options.block ?? 100;
  let clock = 0;
  let sleeps = 0;
  let salt = 0;

  const view = (id: bigint) => {
    const raw = matches.get(id.toString());
    return raw === undefined ? undefined : decodeMatches([raw], id)[0];
  };

  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName !== 'getMatch') throw new Error(`unexpected read ${functionName}`);
      const raw = matches.get(String(args?.[0]));
      if (raw === undefined) throw new Error(`match ${String(args?.[0])} missing`);
      return raw;
    },
    getBlockNumber: async () => BigInt(block),
  } as unknown as PublicClient;

  const queue = {
    address: AGENT,
    send: async (req: { to: Hex; data: Hex; gas: bigint }) => {
      const decoded = decodeFunctionData({ abi: battleAbi, data: req.data });
      const id = decoded.args?.[0] as bigint | undefined;
      sends.push({ fn: decoded.functionName, id: id ?? 0n });
      const raw = id === undefined ? undefined : matches.get(id.toString());
      if (raw !== undefined) {
        if (decoded.functionName === 'joinMatch') {
          raw.p2 = AGENT;
          raw.status = 1;
          raw.turn = 1;
          raw.lastMoveBlock = block;
        } else if (decoded.functionName === 'claimTimeout') {
          raw.status = 3;
        } else if (decoded.functionName === 'act') {
          raw.lastMoveBlock = block;
          raw.turn = raw.turn === 2 ? 1 : 2;
        }
      }
      salt += 1;
      return `0x${salt.toString(16).padStart(64, '0')}` as Hex;
    },
  };

  const hub = {
    wait: async (): Promise<TransactionReceipt> =>
      ({ status: 'success', blockNumber: BigInt(block), logs: [] }) as unknown as TransactionReceipt,
  };

  const deps: BattleRunnerDeps = {
    queue,
    hub,
    chain: { client, call: (fn) => fn(client) },
    poller: {
      battleMatch: (id) => view(BigInt(id)),
      // Deliberately stale: the runner must not depend on the poller cache to see blocks pass.
      latestBlock: () => 0,
    },
    contracts: { battle: BATTLE },
    gasLimits: { joinMatch: 102_000, act: 102_000, claimTimeout: 55_000 },
    now: () => clock,
    sleep: async () => {
      clock += step;
      sleeps += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    log: () => {},
  };

  return {
    deps,
    sends,
    add: (id: bigint, raw: RawMatch) => matches.set(id.toString(), raw),
    finish: (id: bigint) => {
      const raw = matches.get(id.toString());
      if (raw !== undefined) raw.status = 2;
    },
    setBlock: (next: number) => {
      block = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    elapsed: () => clock,
    sleeps: () => sleeps,
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition was not reached in time');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('createBattleRunner', () => {
  test('claims the timeout after TURN_TIMEOUT_BLOCKS instead of waiting for the run cap', async () => {
    const h = harness({ block: 100 + TURN_TIMEOUT_BLOCKS - 1, clockStepMs: 400 });
    // The agent already joined; the human has stopped moving one block before the deadline.
    h.add(1n, match({ status: 1, turn: 1, p2: AGENT }));
    const runner = createBattleRunner(h.deps);

    expect(await runner.battle(1n)).toBe('ok');
    await waitUntil(() => h.sleeps() >= 15);
    expect(h.sends.map((send) => send.fn)).not.toContain('claimTimeout');

    h.setBlock(100 + TURN_TIMEOUT_BLOCKS);
    await waitUntil(() => h.sends.some((send) => send.fn === 'claimTimeout'));

    expect(h.sends.map((send) => send.fn)).not.toContain('act');
    expect(h.elapsed()).toBeLessThan(BATTLE_RUN_MS);
    expect(BATTLE_RUN_MS).toBe(120_000);
  });

  test('releases slots when a battle is refused', async () => {
    const h = harness({ block: 120 });
    h.add(1n, match({ p1: AGENT }));
    h.add(2n, match({ status: 1, p2: PLAYER }));
    h.add(3n, match({ status: 2, p2: AGENT }));
    for (let id = 4; id <= 7; id += 1) h.add(BigInt(id), match());
    const runner = createBattleRunner(h.deps);

    expect(await runner.battle(1n)).toBe('not_open');
    expect(await runner.battle(2n)).toBe('not_open');
    expect(await runner.battle(3n)).toBe('not_open');
    expect(runner.busy()).toBe(false);

    expect(await runner.battle(4n)).toBe('ok');
    expect(await runner.battle(5n)).toBe('ok');
    expect(await runner.battle(6n)).toBe('ok');
    expect(await runner.battle(7n)).toBe('busy');

    try {
      h.finish(4n);
      h.finish(5n);
      h.finish(6n);
      await waitUntil(() => !runner.busy());
    } finally {
      h.advance(BATTLE_RUN_MS + 1);
    }
  });

  test('plays three matches at once and refuses a fourth with busy', async () => {
    const h = harness({ block: 120 });
    for (let id = 1; id <= 4; id += 1) h.add(BigInt(id), match());
    const runner = createBattleRunner(h.deps);

    expect(await runner.battle(1n)).toBe('ok');
    expect(await runner.battle(2n)).toBe('ok');
    expect(await runner.battle(3n)).toBe('ok');
    expect(runner.busy()).toBe(true);
    expect(await runner.battle(4n)).toBe('busy');
    expect(h.sends.filter((send) => send.fn === 'joinMatch').map((send) => send.id)).toEqual([1n, 2n, 3n]);

    try {
      h.finish(1n);
      h.finish(2n);
      h.finish(3n);
      await waitUntil(() => !runner.busy());
    } finally {
      // Release any loop that did not observe the finish before the assertion failed.
      h.advance(BATTLE_RUN_MS + 1);
    }
  });
});