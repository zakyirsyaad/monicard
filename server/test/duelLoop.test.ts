import { describe, expect, it } from 'vitest';
import {
  allowedTaps,
  blitzArenaAbi,
  DUEL_BLOCKS,
  type DuelStatus,
  type DuelView,
  type Hex,
} from '@nad/shared';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  type TransactionReceipt,
} from 'viem';
import { runDuelPair, runSide, sideStateFromDuel, type PairSide } from '../src/sim/duelLoop';
import type { SideState } from '../src/sim/types';

const END_BLOCK = 100;
const START_BLOCK = END_BLOCK - DUEL_BLOCKS;
const MAX_HP = 1000;
const noSleep = async () => {};

type Sent = { taps: number; skill: boolean; readBlock: number };

type ChainOpts = {
  startAt: number;
  side?: 1 | 2;
  hpAt?: (block: number) => { myHp: number; oppHp: number };
  staleLastBlock?: boolean;
  nullReads?: number;
  stateErrors?: number;
  sendFailures?: number;
  skillUsed?: boolean;
  initialLastBlock?: number;
};

/** Fake chain: every state() read advances the head by one block. */
function makeChain(o: ChainOpts) {
  let head = o.startAt;
  let lastBlock = o.initialLastBlock ?? START_BLOCK;
  let readBlock = head;
  let nullsLeft = o.nullReads ?? 0;
  let stateErrorsLeft = o.stateErrors ?? 0;
  let failuresLeft = o.sendFailures ?? 0;
  const sent: Sent[] = [];
  const hpAt = o.hpAt ?? (() => ({ myHp: MAX_HP, oppHp: MAX_HP }));

  const state = async (): Promise<SideState | null> => {
    if (stateErrorsLeft > 0) {
      stateErrorsLeft -= 1;
      throw new Error('rpc state down');
    }
    if (nullsLeft > 0) {
      nullsLeft -= 1;
      return null;
    }
    readBlock = head;
    const { myHp, oppHp } = hpAt(head);
    const s: SideState = {
      myHp,
      myMaxHp: MAX_HP,
      oppHp,
      atk: 12,
      mult: 100,
      skillUsed: o.skillUsed ?? false,
      block: head,
      endBlock: END_BLOCK,
      lastBlock,
    };
    head += 1;
    return s;
  };

  const send = async (data: Hex): Promise<TransactionReceipt> => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('rpc down');
    }
    const decoded = decodeFunctionData({ abi: blitzArenaAbi, data });
    if (decoded.functionName !== 'attack') throw new Error(`unexpected call ${decoded.functionName}`);
    const [, taps, skill] = decoded.args as readonly [bigint, number, boolean];
    sent.push({ taps, skill, readBlock });
    const landed = readBlock + 1;
    if (!o.staleLastBlock) lastBlock = landed;
    return { status: 'success', blockNumber: BigInt(landed), logs: [] } as unknown as TransactionReceipt;
  };

  return { state, send, sent };
}

const baseRun = (chain: ReturnType<typeof makeChain>, extra: Partial<Parameters<typeof runSide>[0]> = {}) =>
  runSide({
    send: chain.send,
    duelId: 7n,
    side: 1,
    state: chain.state,
    tapsPerSec: () => 7,
    batchBlocks: 3,
    useSkill: () => false,
    sleep: noSleep,
    ...extra,
  });

describe('runSide sending cadence', () => {
  it('sends attack with allowedTaps(round(rate x delta x 0.3), delta) every batchBlocks blocks', async () => {
    const chain = makeChain({ startAt: START_BLOCK });
    await baseRun(chain);

    expect(chain.sent.length).toBeGreaterThan(5);
    const expected = allowedTaps(Math.round(7 * 3 * 0.3), 3);
    expect(expected).toBe(6);
    // Each receipt lands one block after the read, so the cadence settles at delta = 3.
    for (const tx of chain.sent) {
      expect(tx.taps).toBeLessThanOrEqual(30);
      expect(tx.skill).toBe(false);
    }
    expect(chain.sent[0]!.taps).toBe(expected);
    expect(chain.sent[1]!.taps).toBe(expected);
    // Each receipt lands 1 block after the read, so sends are exactly batchBlocks + 1 reads apart,
    // except the final flush which may come sooner.
    const gaps = chain.sent.slice(1).map((tx, i) => tx.readBlock - chain.sent[i]!.readBlock);
    expect(gaps.slice(0, -1).every((gap) => gap === 4)).toBe(true);
    expect(gaps.at(-1)).toBeLessThanOrEqual(4);
  });

  it('does not send during countdown', async () => {
    const chain = makeChain({ startAt: START_BLOCK - 8 });
    await baseRun(chain, { batchBlocks: 1 });
    expect(chain.sent.length).toBeGreaterThan(0);
    for (const tx of chain.sent) expect(tx.readBlock).toBeGreaterThanOrEqual(START_BLOCK);
    // First possible send: startBlock reached with lastBlock == startBlock, so delta hits batchBlocks 1 block later.
    expect(chain.sent[0]!.readBlock).toBe(START_BLOCK + 1);
  });

  it('never sends at block >= endBlock - 2', async () => {
    const chain = makeChain({ startAt: START_BLOCK });
    await baseRun(chain, { batchBlocks: 1 });
    expect(chain.sent.length).toBeGreaterThan(0);
    for (const tx of chain.sent) expect(tx.readBlock).toBeLessThan(END_BLOCK - 2);
  });

  it('flushes once at endBlock - 3 even if fewer than batchBlocks blocks passed', async () => {
    const chain = makeChain({ startAt: END_BLOCK - 10, initialLastBlock: END_BLOCK - 10 });
    await baseRun(chain, { batchBlocks: 100 });
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.readBlock).toBe(END_BLOCK - 3);
    expect(chain.sent[0]!.taps).toBe(allowedTaps(Math.round(7 * 7 * 0.3), 7));
  });

  it('uses receipt block as base when state lastBlock is stale', async () => {
    const chain = makeChain({ startAt: START_BLOCK + 3, staleLastBlock: true });
    await baseRun(chain, { batchBlocks: 3 });
    // Stale lastBlock would give delta 7 (15 taps) on the second send; receipt base keeps it at 3.
    expect(chain.sent.length).toBeGreaterThan(3);
    expect(chain.sent[0]!.taps).toBe(6);
    expect(chain.sent[1]!.taps).toBe(6);
    expect(chain.sent[2]!.taps).toBe(6);
  });
});

describe('runSide skill', () => {
  it('fires skill immediately when useSkill returns true, only once, and records skillUsedAtHpPct', async () => {
    const chain = makeChain({
      startAt: START_BLOCK + 1,
      hpAt: (block) => ({ myHp: block >= 40 ? 280 : MAX_HP, oppHp: MAX_HP }),
    });
    let calls = 0;
    const { summary } = await baseRun(chain, {
      batchBlocks: 50,
      useSkill: (s) => {
        calls += 1;
        return s.myHp * 100 <= 30 * s.myMaxHp;
      },
    });

    const skillTxs = chain.sent.filter((tx) => tx.skill);
    expect(skillTxs).toHaveLength(1);
    expect(skillTxs[0]!.readBlock).toBe(40);
    expect(summary.skillUsedAtHpPct).toBe(28);
    // Evaluated once per block only while it can still fire; never after being sent.
    expect(calls).toBe(40 - (START_BLOCK + 1) + 1);
  });

  it('reports null skillUsedAtHpPct when the skill never fires', async () => {
    const chain = makeChain({ startAt: START_BLOCK });
    const { summary } = await baseRun(chain);
    expect(summary.skillUsedAtHpPct).toBeNull();
  });

  it('does not evaluate useSkill when the state says the skill is already used', async () => {
    const chain = makeChain({ startAt: START_BLOCK, skillUsed: true });
    let calls = 0;
    await baseRun(chain, { useSkill: () => ((calls += 1), true) });
    expect(calls).toBe(0);
    expect(chain.sent.every((tx) => !tx.skill)).toBe(true);
  });
});

describe('runSide result', () => {
  const finalRun = (side: 1 | 2, myHp: number, oppHp: number) =>
    baseRun(makeChain({ startAt: END_BLOCK - 2, hpAt: () => ({ myHp, oppHp }) }), {
      side,
      elements: { mine: 0, opp: 2 },
    });

  it('maps a side 1 win to P1Won and a side 1 loss to P2Won', async () => {
    const win = await finalRun(1, 500, 200);
    expect(win.status).toBe<DuelStatus>('P1Won');
    expect(win.summary.result).toBe('win');
    const loss = await finalRun(1, 200, 500);
    expect(loss.status).toBe<DuelStatus>('P2Won');
    expect(loss.summary.result).toBe('loss');
  });

  it('maps a side 2 win to P2Won and a side 2 loss to P1Won', async () => {
    const win = await finalRun(2, 500, 200);
    expect(win.status).toBe<DuelStatus>('P2Won');
    expect(win.summary.result).toBe('win');
    const loss = await finalRun(2, 200, 500);
    expect(loss.status).toBe<DuelStatus>('P1Won');
    expect(loss.summary.result).toBe('loss');
  });

  it('returns Draw on equal HP at the end', async () => {
    const draw = await finalRun(2, 300, 300);
    expect(draw.status).toBe<DuelStatus>('Draw');
    expect(draw.summary.result).toBe('draw');
  });

  it('ends early on a KO before endBlock', async () => {
    const chain = makeChain({ startAt: START_BLOCK, hpAt: (b) => ({ myHp: 500, oppHp: b >= 50 ? 0 : 500 }) });
    const { status, summary } = await baseRun(chain);
    expect(status).toBe('P1Won');
    expect(summary.result).toBe('win');
    expect(summary.hpTimeline.at(-1)).toEqual({ block: 50, myHp: 500, oppHp: 0 });
  });

  it('copies duel id, elements and a final timeline point into the summary', async () => {
    const out = await finalRun(1, 500, 200);
    expect(out.summary.duelId).toBe('7');
    expect(out.summary.myElement).toBe(0);
    expect(out.summary.oppElement).toBe(2);
    expect(out.summary.hpTimeline.at(-1)).toEqual({ block: END_BLOCK, myHp: 500, oppHp: 200 });
  });

  it('defaults elements to -1 when not given', async () => {
    const out = await baseRun(makeChain({ startAt: END_BLOCK }));
    expect(out.summary.myElement).toBe(-1);
    expect(out.summary.oppElement).toBe(-1);
  });
});

describe('runSide resilience', () => {
  it('retries when state() returns null', async () => {
    const chain = makeChain({ startAt: END_BLOCK - 4, nullReads: 5 });
    const out = await baseRun(chain);
    expect(out.status).toBe('Draw');
  });

  it('throws when state() stays null for too many reads', async () => {
    await expect(
      baseRun(makeChain({ startAt: START_BLOCK }), { state: async () => null }),
    ).rejects.toThrow(/duel 7 side 1/);
  });

  it('retries when send throws below the error cap', async () => {
    const chain = makeChain({ startAt: START_BLOCK, sendFailures: 3 });
    const out = await baseRun(chain, { batchBlocks: 1 });
    expect(chain.sent.length).toBeGreaterThan(0);
    expect(out.status).toBe('Draw');
  });

  it('throws after too many consecutive send errors', async () => {
    const chain = makeChain({ startAt: START_BLOCK, sendFailures: 1000 });
    await expect(baseRun(chain, { batchBlocks: 1, side: 2 })).rejects.toThrow(
      /runSide duel 7 side 2: .*rpc down/,
    );
  });

  it('treats a reverted receipt as an error that does not move the base block', async () => {
    // Stale lastBlock stays at START_BLOCK, so only receipts can move the base.
    const chain = makeChain({ startAt: START_BLOCK + 3, staleLastBlock: true });
    let reverts = 1;
    const send = async (data: Hex) => {
      const receipt = await chain.send(data);
      if (reverts > 0) {
        reverts -= 1;
        return { ...receipt, status: 'reverted' } as TransactionReceipt;
      }
      return receipt;
    };
    const out = await baseRun(chain, { send, batchBlocks: 3 });
    // 1st send (block 36, delta 3) reverts; had it moved the base to 37, the next send would wait until 40.
    // Instead block 37 sees delta 4 from the unchanged base and sends 8 taps at once.
    expect(chain.sent.slice(0, 3).map((tx) => [tx.readBlock, tx.taps])).toEqual([
      [START_BLOCK + 3, 6],
      [START_BLOCK + 4, 8],
      [START_BLOCK + 8, 6],
    ]);
    // Only the successful tx lands in the timeline.
    expect(out.summary.hpTimeline[0]!.block).toBe(START_BLOCK + 4);
  });

  it('retries when state() rejects below the cap and keeps playing', async () => {
    const chain = makeChain({ startAt: END_BLOCK - 4, stateErrors: 5 });
    const out = await baseRun(chain);
    expect(out.status).toBe('Draw');
  });

  it('throws with context and cause when state() keeps rejecting', async () => {
    const boom = new Error('rpc state down');
    const promise = baseRun(makeChain({ startAt: START_BLOCK }), {
      state: async () => {
        throw boom;
      },
      side: 2,
    });
    await expect(promise).rejects.toThrow(/runSide duel 7 side 2: state\(\) failing: rpc state down/);
    await expect(promise).rejects.toMatchObject({ cause: boom });
  });

  it('throws when the block never advances (stalled miner or poller)', async () => {
    const frozen: SideState = {
      myHp: 5, myMaxHp: 10, oppHp: 5, atk: 1, mult: 100, skillUsed: false, block: START_BLOCK + 1, endBlock: END_BLOCK, lastBlock: START_BLOCK,
    };
    let reads = 0;
    await expect(
      baseRun(makeChain({ startAt: START_BLOCK }), {
        state: async () => {
          reads += 1;
          return frozen;
        },
        pollMs: 150,
      }),
    ).rejects.toThrow(/runSide duel 7 side 1: block stuck at 34/);
    // ~60 s of polling at 150 ms.
    expect(reads).toBe(401);
  });

  it('exits at once when its stop flag is set', async () => {
    const chain = makeChain({ startAt: START_BLOCK });
    await expect(baseRun(chain, { stop: { stopped: true } })).rejects.toThrow(/stopped/);
    expect(chain.sent).toHaveLength(0);
  });

  it('polls with sleep when the block has not advanced', async () => {
    const states: SideState[] = [
      { myHp: 5, myMaxHp: 10, oppHp: 5, atk: 1, mult: 100, skillUsed: false, block: END_BLOCK - 5, endBlock: END_BLOCK, lastBlock: 0 },
      { myHp: 5, myMaxHp: 10, oppHp: 5, atk: 1, mult: 100, skillUsed: false, block: END_BLOCK - 5, endBlock: END_BLOCK, lastBlock: 0 },
      { myHp: 5, myMaxHp: 10, oppHp: 5, atk: 1, mult: 100, skillUsed: false, block: END_BLOCK, endBlock: END_BLOCK, lastBlock: 0 },
    ];
    const sleeps: number[] = [];
    let blocks = 0;
    const out = await runSide({
      send: async () => {
        throw new Error('should not send');
      },
      duelId: 1n,
      side: 1,
      state: async () => states.shift() ?? null,
      tapsPerSec: () => 7,
      batchBlocks: 100,
      useSkill: () => false,
      onBlock: () => {
        blocks += 1;
      },
      pollMs: 42,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([42]);
    expect(blocks).toBe(2);
    expect(out.status).toBe('Draw');
  });
});

const DUEL: DuelView = {
  id: '3',
  p1: '0x0000000000000000000000000000000000000001',
  p2: '0x0000000000000000000000000000000000000002',
  hp1: 111,
  hp2: 222,
  atk1: 11,
  atk2: 12,
  mult1: 150,
  mult2: 75,
  lastBlock1: 41,
  lastBlock2: 42,
  skill1: false,
  skill2: true,
  status: 'Active',
  startBlock: 40,
  endBlock: 107,
  card1: 5,
  card2: 6,
  maxHp1: 1500,
  maxHp2: 1600,
  settled: false,
};

describe('sideStateFromDuel', () => {
  it('maps side 1 fields', () => {
    expect(sideStateFromDuel(DUEL, 1, 55)).toEqual({
      myHp: 111, myMaxHp: 1500, oppHp: 222, atk: 11, mult: 150, skillUsed: false, block: 55, endBlock: 107, lastBlock: 41,
    });
  });

  it('maps side 2 fields', () => {
    expect(sideStateFromDuel(DUEL, 2, 55)).toEqual({
      myHp: 222, myMaxHp: 1600, oppHp: 111, atk: 12, mult: 75, skillUsed: true, block: 55, endBlock: 107, lastBlock: 42,
    });
  });
});

describe('runDuelPair', () => {
  const P1 = '0x00000000000000000000000000000000000000a1' as Hex;
  const DUEL_ID = 9n;

  const createdLog = () => ({
    address: '0x00000000000000000000000000000000000000bb' as Hex,
    topics: encodeEventTopics({ abi: blitzArenaAbi, eventName: 'DuelCreated', args: { id: DUEL_ID, p1: P1 } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [11n]),
  });

  function makePair() {
    const calls: { who: 'p1' | 'p2'; name: string; args: readonly unknown[] }[] = [];
    let head = 0;
    const receipt = (extra: object = {}) =>
      ({ status: 'success', blockNumber: BigInt(head + 1), logs: [], ...extra }) as unknown as TransactionReceipt;
    const sender = (who: 'p1' | 'p2', cardId: bigint): PairSide => ({
      cardId,
      tapsPerSec: () => 7,
      useSkill: () => false,
      element: who === 'p1' ? 0 : 1,
      send: async (data) => {
        const decoded = decodeFunctionData({ abi: blitzArenaAbi, data });
        calls.push({ who, name: decoded.functionName, args: decoded.args ?? [] });
        if (decoded.functionName === 'createDuel') return receipt({ logs: [createdLog()] });
        return receipt();
      },
    });
    const readBlock = async () => ++head;
    const peekBlock = async () => head;
    const readDuel = async (id: bigint): Promise<DuelView | null> => {
      if (head < 5) return { ...DUEL, id: id.toString(), status: 'Open' };
      return { ...DUEL, id: id.toString(), startBlock: 20, endBlock: 20 + DUEL_BLOCKS, hp1: 900, hp2: 400, maxHp1: 1000, maxHp2: 1000 };
    };
    return { calls, sender, readBlock, peekBlock, readDuel };
  }

  it('creates, joins with the DuelCreated id, and runs both sides', async () => {
    const pair = makePair();
    const result = await runDuelPair({
      p1: pair.sender('p1', 11n),
      p2: pair.sender('p2', 12n),
      readDuel: pair.readDuel,
      readBlock: pair.readBlock,
      batchBlocks: 3,
      sleep: noSleep,
    });

    expect(pair.calls[0]).toMatchObject({ who: 'p1', name: 'createDuel', args: [11n] });
    expect(pair.calls[1]).toMatchObject({ who: 'p2', name: 'joinDuel', args: [DUEL_ID, 12n] });
    expect(result.duelId).toBe(DUEL_ID);
    expect(result.status).toBe('P1Won');
    expect(result.p1.result).toBe('win');
    expect(result.p2.result).toBe('loss');
    expect(result.p1).toMatchObject({ duelId: '9', myElement: 0, oppElement: 1 });
    expect(result.p2).toMatchObject({ duelId: '9', myElement: 1, oppElement: 0 });
    const attacks = pair.calls.filter((c) => c.name === 'attack');
    expect(attacks.some((c) => c.who === 'p1')).toBe(true);
    expect(attacks.some((c) => c.who === 'p2')).toBe(true);
  });

  it('throws when the createDuel receipt carries no DuelCreated log', async () => {
    const pair = makePair();
    const p1 = { ...pair.sender('p1', 11n), send: async () => ({ status: 'success', blockNumber: 1n, logs: [] }) as unknown as TransactionReceipt };
    await expect(
      runDuelPair({ p1, p2: pair.sender('p2', 12n), readDuel: pair.readDuel, readBlock: pair.readBlock, batchBlocks: 3, sleep: noSleep }),
    ).rejects.toThrow(/DuelCreated/);
  });

  it('stops the other side promptly when one side fails', async () => {
    const pair = makePair();
    const failing: PairSide = {
      ...pair.sender('p1', 11n),
      send: async (data) => {
        const decoded = decodeFunctionData({ abi: blitzArenaAbi, data });
        if (decoded.functionName === 'createDuel') {
          return { status: 'success', blockNumber: 1n, logs: [createdLog()] } as unknown as TransactionReceipt;
        }
        throw new Error('p1 wallet broke');
      },
    };
    const p2Attacks = () => pair.calls.filter((c) => c.who === 'p2' && c.name === 'attack').length;
    await expect(
      runDuelPair({ p1: failing, p2: pair.sender('p2', 12n), readDuel: pair.readDuel, readBlock: pair.readBlock, batchBlocks: 3, sleep: noSleep }),
    ).rejects.toThrow(/runSide duel 9 side 1: p1 wallet broke/);

    // p2 was awaited and is idle: nothing more is sent or read, and it never ran to the end of the duel.
    const attacksAtReturn = p2Attacks();
    const headAtReturn = await pair.readBlock();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(p2Attacks()).toBe(attacksAtReturn);
    expect(await pair.readBlock()).toBe(headAtReturn + 1);
    expect(headAtReturn).toBeLessThan(20 + DUEL_BLOCKS);
  });

  it('throws when the two sides end with different outcomes', async () => {
    const pair = makePair();
    let endReads = 0;
    const readDuel = async (id: bigint): Promise<DuelView | null> => {
      const d = await pair.readDuel(id);
      if (d === null || d.status === 'Open') return d;
      // Past the window the first reader sees p1 ahead, every later reader sees p2 ahead.
      if ((await pair.peekBlock()) >= d.endBlock) {
        endReads += 1;
        if (endReads > 1) return { ...d, hp1: 400, hp2: 900 };
      }
      return d;
    };
    await expect(
      runDuelPair({ p1: pair.sender('p1', 11n), p2: pair.sender('p2', 12n), readDuel, readBlock: pair.readBlock, batchBlocks: 3, sleep: noSleep }),
    ).rejects.toThrow(/duel 9: sides disagree \(P1Won vs P2Won\)/);
  });

  it('throws when joinDuel reverts', async () => {
    const pair = makePair();
    const p2 = { ...pair.sender('p2', 12n), send: async () => ({ status: 'reverted', blockNumber: 1n, logs: [] }) as unknown as TransactionReceipt };
    await expect(
      runDuelPair({ p1: pair.sender('p1', 11n), p2, readDuel: pair.readDuel, readBlock: pair.readBlock, batchBlocks: 3, sleep: noSleep }),
    ).rejects.toThrow(/joinDuel/);
  });
});
