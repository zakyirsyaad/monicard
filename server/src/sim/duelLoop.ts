import {
  allowedTaps,
  blitzArenaAbi,
  DUEL_BLOCKS,
  type DuelStatus,
  type DuelView,
  type Hex,
} from '@nad/shared';
import { encodeFunctionData, parseEventLogs, type TransactionReceipt } from 'viem';
import type { DuelSummary, SideState } from './types';

type TxReceipt = TransactionReceipt;
type SideSummary = Omit<DuelSummary, 'mode' | 'opponent' | 'followedPolicy'>;
type Side = 1 | 2;

const SECONDS_PER_BLOCK = 0.3;
const DEFAULT_POLL_MS = 150;
const MAX_NULL_READS = 400;
const MAX_CONSECUTIVE_ERRORS = 5;
const FLUSH_BEFORE_END = 3;
const STOP_BEFORE_END = 2;
const UNKNOWN_ELEMENT = -1;
const PERCENT = 100;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type RunSideOpts = {
  send: (data: Hex) => Promise<TxReceipt>;
  duelId: bigint;
  side: Side;
  state: () => Promise<SideState | null>;
  tapsPerSec: () => number;
  batchBlocks: number;
  useSkill: (s: SideState) => boolean;
  onBlock?: (s: SideState) => void;
  elements?: { mine: number; opp: number };
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type RunSideResult = { status: DuelStatus; summary: SideSummary };

type LoopMemory = {
  lastBlockSeen: number;
  lastReceiptBlock: number;
  skillSent: boolean;
  skillUsedAtHpPct: number | null;
  sentLate: boolean;
  consecutiveErrors: number;
  consecutiveNulls: number;
  hpTimeline: SideSummary['hpTimeline'];
};

type Attack = { taps: number; skill: boolean };

const isEnded = (s: SideState): boolean => s.myHp === 0 || s.oppHp === 0 || s.block >= s.endBlock;

/** Mirrors the contract: KO wins outright, otherwise close by remaining HP. */
function resultFromHp(s: SideState): SideSummary['result'] {
  if (s.oppHp === 0) return 'win';
  if (s.myHp === 0) return 'loss';
  if (s.myHp > s.oppHp) return 'win';
  if (s.myHp < s.oppHp) return 'loss';
  return 'draw';
}

function statusFor(result: SideSummary['result'], side: Side): DuelStatus {
  if (result === 'draw') return 'Draw';
  const sideWon = result === 'win' ? side : side === 1 ? 2 : 1;
  return sideWon === 1 ? 'P1Won' : 'P2Won';
}

/** Decide whether to send this block, and with what; null = stay quiet. */
function decideAttack(s: SideState, mem: LoopMemory, opts: RunSideOpts): Attack | null {
  const startBlock = s.endBlock - DUEL_BLOCKS;
  if (s.block < startBlock || s.block >= s.endBlock - STOP_BEFORE_END) return null;

  const delta = s.block - Math.max(s.lastBlock, mem.lastReceiptBlock);
  const skill = !s.skillUsed && !mem.skillSent && opts.useSkill(s);
  const finalFlush = s.block >= s.endBlock - FLUSH_BEFORE_END && delta > 0 && !mem.sentLate;
  if (!skill && delta < opts.batchBlocks && !finalFlush) return null;

  const requested = Math.round(opts.tapsPerSec() * delta * SECONDS_PER_BLOCK);
  const taps = allowedTaps(requested, delta);
  if (taps === 0 && !skill) return null;
  return { taps, skill };
}

/** Send one attack and fold the receipt into memory. Throws on send failure or revert. */
async function sendAttack(s: SideState, attack: Attack, mem: LoopMemory, opts: RunSideOpts): Promise<void> {
  const data = encodeFunctionData({
    abi: blitzArenaAbi,
    functionName: 'attack',
    args: [opts.duelId, attack.taps, attack.skill],
  });
  const receipt = await opts.send(data);
  if (receipt.status !== 'success') throw new Error(`attack tx reverted (${receipt.transactionHash ?? 'no hash'})`);

  mem.lastReceiptBlock = Number(receipt.blockNumber);
  if (s.block >= s.endBlock - FLUSH_BEFORE_END) mem.sentLate = true;
  if (attack.skill) {
    mem.skillSent = true;
    mem.skillUsedAtHpPct = Math.round((s.myHp * PERCENT) / s.myMaxHp);
  }
  mem.hpTimeline.push({ block: s.block, myHp: s.myHp, oppHp: s.oppHp });
}

/** Count a failed send; rethrow with context once the cap is reached. */
function recordSendError(error: unknown, mem: LoopMemory, opts: RunSideOpts): void {
  mem.consecutiveErrors += 1;
  if (mem.consecutiveErrors < MAX_CONSECUTIVE_ERRORS) return;
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(`runSide duel ${opts.duelId} side ${opts.side}: ${reason}`, { cause: error });
}

/** Read the next state; null means "nothing new, sleep and retry". */
async function readState(mem: LoopMemory, opts: RunSideOpts, sleep: (ms: number) => Promise<void>, pollMs: number) {
  const s = await opts.state();
  if (s === null) {
    mem.consecutiveNulls += 1;
    if (mem.consecutiveNulls >= MAX_NULL_READS) {
      throw new Error(`runSide duel ${opts.duelId} side ${opts.side}: no state after ${MAX_NULL_READS} reads`);
    }
    await sleep(pollMs);
    return null;
  }
  mem.consecutiveNulls = 0;
  if (s.block === mem.lastBlockSeen) {
    await sleep(pollMs);
    return null;
  }
  mem.lastBlockSeen = s.block;
  return s;
}

/** Block-based tap loop for one side of a duel. Returns once the duel window is over. */
export async function runSide(opts: RunSideOpts): Promise<RunSideResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const mem: LoopMemory = {
    lastBlockSeen: -1,
    lastReceiptBlock: 0,
    skillSent: false,
    skillUsedAtHpPct: null,
    sentLate: false,
    consecutiveErrors: 0,
    consecutiveNulls: 0,
    hpTimeline: [],
  };

  for (;;) {
    const s = await readState(mem, opts, sleep, pollMs);
    if (s === null) continue;
    opts.onBlock?.(s);

    if (isEnded(s)) {
      mem.hpTimeline.push({ block: s.block, myHp: s.myHp, oppHp: s.oppHp });
      const result = resultFromHp(s);
      return {
        status: statusFor(result, opts.side),
        summary: {
          duelId: opts.duelId.toString(),
          myElement: opts.elements?.mine ?? UNKNOWN_ELEMENT,
          oppElement: opts.elements?.opp ?? UNKNOWN_ELEMENT,
          result,
          skillUsedAtHpPct: mem.skillUsedAtHpPct,
          hpTimeline: mem.hpTimeline,
        },
      };
    }

    const attack = decideAttack(s, mem, opts);
    if (attack === null) continue;
    try {
      await sendAttack(s, attack, mem, opts);
      mem.consecutiveErrors = 0;
    } catch (error) {
      recordSendError(error, mem, opts);
    }
  }
}

/** Pure mapping from an onchain duel to one side's view at `block`. */
export function sideStateFromDuel(d: DuelView, side: Side, block: number): SideState {
  if (side === 1) {
    return {
      myHp: d.hp1, myMaxHp: d.maxHp1, oppHp: d.hp2, atk: d.atk1, mult: d.mult1,
      skillUsed: d.skill1, block, endBlock: d.endBlock, lastBlock: d.lastBlock1,
    };
  }
  return {
    myHp: d.hp2, myMaxHp: d.maxHp2, oppHp: d.hp1, atk: d.atk2, mult: d.mult2,
    skillUsed: d.skill2, block, endBlock: d.endBlock, lastBlock: d.lastBlock2,
  };
}

export type PairSide = {
  send: (data: Hex) => Promise<TxReceipt>;
  cardId: bigint;
  tapsPerSec: () => number;
  useSkill: (s: SideState) => boolean;
  onBlock?: (s: SideState) => void;
  element?: number;
};

export type RunDuelPairOpts = {
  p1: PairSide;
  p2: PairSide;
  readDuel: (id: bigint) => Promise<DuelView | null>;
  readBlock: () => Promise<number>;
  batchBlocks: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type RunDuelPairResult = {
  duelId: bigint;
  status: DuelStatus;
  p1: SideSummary;
  p2: SideSummary;
};

async function sendChecked(side: PairSide, data: Hex, label: string): Promise<TxReceipt> {
  const receipt = await side.send(data);
  if (receipt.status !== 'success') throw new Error(`runDuelPair: ${label} tx did not succeed (${receipt.status})`);
  return receipt;
}

function duelIdFromReceipt(receipt: TxReceipt): bigint {
  const [created] = parseEventLogs({ abi: blitzArenaAbi, logs: receipt.logs, eventName: 'DuelCreated' });
  if (created === undefined) throw new Error('runDuelPair: createDuel receipt has no DuelCreated log');
  return created.args.id;
}

/** Create + join a duel, then run both sides concurrently. Settling is the caller's job. */
export async function runDuelPair(opts: RunDuelPairOpts): Promise<RunDuelPairResult> {
  const { p1, p2 } = opts;
  const createReceipt = await sendChecked(
    p1,
    encodeFunctionData({ abi: blitzArenaAbi, functionName: 'createDuel', args: [p1.cardId] }),
    'createDuel',
  );
  const duelId = duelIdFromReceipt(createReceipt);
  await sendChecked(
    p2,
    encodeFunctionData({ abi: blitzArenaAbi, functionName: 'joinDuel', args: [duelId, p2.cardId] }),
    'joinDuel',
  );

  // Block first, duel second: the duel is then at least as fresh as the block we judge "ended" by.
  const stateFor = (side: Side) => async (): Promise<SideState | null> => {
    const block = await opts.readBlock();
    const d = await opts.readDuel(duelId);
    return d !== null && d.status !== 'Open' ? sideStateFromDuel(d, side, block) : null;
  };
  const common = { duelId, batchBlocks: opts.batchBlocks, pollMs: opts.pollMs, sleep: opts.sleep };
  const known = p1.element !== undefined && p2.element !== undefined;
  const run = (side: Side, me: PairSide, other: PairSide) =>
    runSide({
      ...common,
      side,
      send: me.send,
      state: stateFor(side),
      tapsPerSec: me.tapsPerSec,
      useSkill: me.useSkill,
      onBlock: me.onBlock,
      elements: known ? { mine: me.element!, opp: other.element! } : undefined,
    });

  const [r1, r2] = await Promise.all([run(1, p1, p2), run(2, p2, p1)]);
  if (r1.status !== r2.status) {
    throw new Error(`runDuelPair duel ${duelId}: sides disagree (${r1.status} vs ${r2.status})`);
  }
  return { duelId, status: r1.status, p1: r1.summary, p2: r2.summary };
}
