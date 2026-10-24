import type { Hex } from '@nad/shared';
import type { TransactionReceipt } from 'viem';
import { describe, expect, test, vi } from 'vitest';
import type { RunDuelPairOpts, RunDuelPairResult } from '../src/sim/duelLoop';
import type { SideState } from '../src/sim/types';
import { createSwarm, estimateDuelCostWei, type SwarmBot } from '../src/swarm';

const COST = 10n;
const ZERO = 0n;

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;

const receipt = { status: 'success' } as TransactionReceipt;

const makeBot = (n: number): SwarmBot => ({
  address: addr(n),
  cardId: BigInt(n),
  send: async () => receipt,
});

const funded = (bots: readonly SwarmBot[]): Map<Hex, bigint> => new Map(bots.map((b) => [b.address, COST]));

const duelResult = (): RunDuelPairResult => ({
  duelId: 1n,
  status: 'P1Won',
  p1: { duelId: '1', myElement: 0, oppElement: 1, result: 'win', skillUsedAtHpPct: null, hpTimeline: [] },
  p2: { duelId: '1', myElement: 1, oppElement: 0, result: 'loss', skillUsedAtHpPct: null, hpTimeline: [] },
});

const sideState = (myHp: number, over: Partial<SideState> = {}): SideState => ({
  myHp,
  myMaxHp: 100,
  oppHp: 100,
  atk: 10,
  mult: 1,
  skillUsed: false,
  block: 10,
  endBlock: 77,
  lastBlock: 0,
  ...over,
});

function harness(opts: {
  bots: readonly SwarmBot[];
  balances?: Map<Hex, bigint>;
  runPair?: (o: RunDuelPairOpts) => Promise<RunDuelPairResult>;
  onError?: (err: unknown, ctx: { pair: number; round: number }) => void;
}) {
  const calls: RunDuelPairOpts[] = [];
  const balances = opts.balances ?? funded(opts.bots);
  const swarm = createSwarm({
    bots: opts.bots,
    readDuel: async () => null,
    readBlock: async () => 0,
    balanceOf: async (address) => balances.get(address) ?? ZERO,
    duelCostWei: () => COST,
    rng: () => 0,
    onError: opts.onError ?? (() => undefined),
    runPair: async (o) => {
      calls.push(o);
      return opts.runPair ? opts.runPair(o) : duelResult();
    },
  });
  return { swarm, calls };
}

describe('estimateDuelCostWei', () => {
  test('charges the gas limit of one create/join plus every batched attack, at maxFeePerGas', () => {
    // attacks = ceil(67 / 10) + 1 = 8; (max(122000, 137000) + 8 * 62000) * 2 * 100
    expect(
      estimateDuelCostWei({
        gasLimits: { createDuel: 122_000, joinDuel: 137_000, attack: 62_000 },
        gasPrice: 100n,
        batchBlocks: 10,
      }),
    ).toBe(126_600_000n);
  });

  test('smaller batches need more attack transactions', () => {
    const base = { gasLimits: { createDuel: 100_000, joinDuel: 100_000, attack: 50_000 }, gasPrice: 1n };
    // ceil(67 / 67) + 1 = 2 attacks versus ceil(67 / 3) + 1 = 24
    expect(estimateDuelCostWei({ ...base, batchBlocks: 67 })).toBe(400_000n);
    expect(estimateDuelCostWei({ ...base, batchBlocks: 3 })).toBe(2_600_000n);
  });
});

describe('createSwarm', () => {
  test('swarm pairs capped by available bots', async () => {
    const bots = Array.from({ length: 20 }, (_, i) => makeBot(i + 1));
    const { swarm, calls } = harness({ bots });

    await swarm.start(50, 1);

    expect(calls).toHaveLength(10);
    expect(calls.map((c) => [c.p1.cardId, c.p2.cardId])).toEqual([
      [1n, 2n], [3n, 4n], [5n, 6n], [7n, 8n], [9n, 10n],
      [11n, 12n], [13n, 14n], [15n, 16n], [17n, 18n], [19n, 20n],
    ]);
    expect(swarm.running()).toBe(0);
  });

  test('bots below the duel cost are skipped', async () => {
    const bots = [makeBot(1), makeBot(2), makeBot(3), makeBot(4)];
    const balances = new Map<Hex, bigint>([
      [bots[0]!.address, COST],
      [bots[1]!.address, COST - 1n],
      [bots[2]!.address, COST],
      [bots[3]!.address, ZERO],
    ]);
    const { swarm, calls } = harness({ bots, balances });

    await swarm.start(2, 1);

    expect(calls).toHaveLength(1);
    expect([calls[0]!.p1.cardId, calls[0]!.p2.cardId]).toEqual([1n, 3n]);
  });

  test('fewer than two funded bots resolves immediately without a duel', async () => {
    const { swarm, calls } = harness({ bots: [makeBot(1)], balances: new Map([[addr(1), COST]]) });

    await expect(swarm.start(5, 2)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(swarm.running()).toBe(0);
  });

  test('swarm stops after the requested rounds and alternates the creator', async () => {
    const bots = [makeBot(1), makeBot(2), makeBot(3), makeBot(4)];
    const { swarm, calls } = harness({ bots });

    await swarm.start(2, 3);

    expect(calls).toHaveLength(6);
    const pairOf = (a: bigint, b: bigint) =>
      calls.filter((c) => (c.p1.cardId === a && c.p2.cardId === b) || (c.p1.cardId === b && c.p2.cardId === a));
    // Even rounds: the lower card creates; odd rounds: the other bot creates.
    expect(pairOf(1n, 2n).map((c) => c.p1.cardId)).toEqual([1n, 2n, 1n]);
    expect(pairOf(3n, 4n).map((c) => c.p1.cardId)).toEqual([3n, 4n, 3n]);
    expect(swarm.running()).toBe(0);
  });

  test('draws a tap rate in 5..9 and a skill threshold in 10..90 for each bot', async () => {
    const { swarm, calls } = harness({ bots: [makeBot(1), makeBot(2)] });

    await swarm.start(1, 1);

    const call = calls[0]!;
    for (const side of [call.p1, call.p2]) {
      expect(side.tapsPerSec()).toBeGreaterThanOrEqual(5);
      expect(side.tapsPerSec()).toBeLessThan(9);
    }
    // rng 0 -> threshold 10%: fire only when HP is at or below 10 percent, and never twice.
    expect(call.p1.useSkill(sideState(40))).toBe(false);
    expect(call.p1.useSkill(sideState(10))).toBe(true);
    expect(call.p1.useSkill(sideState(10, { skillUsed: true }))).toBe(false);
  });

  test('running() counts active pairs and drops as pairs finish', async () => {
    const bots = [makeBot(1), makeBot(2), makeBot(3), makeBot(4)];
    const releases = new Map<bigint, () => void>();
    let started = 0;
    let bothStarted: () => void = () => undefined;
    const startedAll = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });

    const { swarm } = harness({
      bots,
      runPair: (o) =>
        new Promise<RunDuelPairResult>((resolve) => {
          releases.set(o.p1.cardId, () => resolve(duelResult()));
          started += 1;
          if (started === 2) bothStarted();
        }),
    });

    const run = swarm.start(2, 1);
    await startedAll;
    expect(swarm.running()).toBe(2);
    releases.get(1n)!();
    await vi.waitFor(() => expect(swarm.running()).toBe(1));
    releases.get(3n)!();
    await run;
    expect(swarm.running()).toBe(0);
  });

  test('stop() prevents new duels and leaves the swarm startable again', async () => {
    const bots = [makeBot(1), makeBot(2)];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const { swarm, calls } = harness({
      bots,
      runPair: async () => {
        firstStarted();
        await gate;
        return duelResult();
      },
    });

    const run = swarm.start(1, 5);
    await started;
    expect(swarm.running()).toBe(1);
    swarm.stop();
    release();
    await run;

    expect(calls).toHaveLength(1);
    expect(swarm.running()).toBe(0);

    // The finished run cleared the stop flag.
    await swarm.start(1, 1);
    expect(calls).toHaveLength(2);
  });

  test('start while running throws', async () => {
    const bots = [makeBot(1), makeBot(2)];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const { swarm } = harness({
      bots,
      runPair: async () => {
        firstStarted();
        await gate;
        return duelResult();
      },
    });

    const run = swarm.start(1, 1);
    await started;
    await expect(swarm.start(1, 1)).rejects.toThrow('swarm already running');
    release();
    await run;
  });

  test('pair stops after 3 consecutive failures and reports onError', async () => {
    const onError = vi.fn();
    const { swarm, calls } = harness({
      bots: [makeBot(1), makeBot(2)],
      onError,
      runPair: async () => {
        throw new Error('boom');
      },
    });

    await expect(swarm.start(1, 10)).resolves.toBeUndefined();

    expect(calls).toHaveLength(3);
    expect(onError.mock.calls.map(([, ctx]) => ctx)).toEqual([
      { pair: 0, round: 0 },
      { pair: 0, round: 1 },
      { pair: 0, round: 2 },
    ]);
    expect(swarm.running()).toBe(0);
  });

  test('a successful duel resets the failure streak', async () => {
    const bots = [makeBot(1), makeBot(2)];
    const outcomes = ['fail', 'fail', 'ok', 'fail', 'fail', 'fail'] as const;
    let index = 0;
    const onError = vi.fn();

    const { swarm, calls } = harness({
      bots,
      onError,
      runPair: async () => {
        const outcome = outcomes[index++] ?? 'ok';
        if (outcome === 'fail') throw new Error('boom');
        return duelResult();
      },
    });

    await swarm.start(1, 10);

    expect(calls).toHaveLength(6);
    expect(onError).toHaveBeenCalledTimes(5);
  });

  test('a failed balance read counts as a duel failure instead of starting blindly', async () => {
    const bots = [makeBot(1), makeBot(2)];
    const onError = vi.fn();
    let reads = 0;
    const swarm = createSwarm({
      bots,
      readDuel: async () => null,
      readBlock: async () => 0,
      balanceOf: async () => {
        reads += 1;
        if (reads > 2) throw new Error('rpc down');
        return COST;
      },
      duelCostWei: () => COST,
      onError,
      runPair: async () => duelResult(),
    });

    await swarm.start(1, 10);

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0]![1]).toEqual({ pair: 0, round: 0 });
  });
});
