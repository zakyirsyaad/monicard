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
// Budget of waiting (no state / failing state() / block not advancing) before giving up.
// At the default pollMs of 150 ms this is 400 reads.
const STALL_BUDGET_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 5;
const FLUSH_BEFORE_END = 3;
const STOP_BEFORE_END = 2;
const UNKNOWN_ELEMENT = -1;
const PERCENT = 100;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared flag: whoever sets `stopped` makes every runSide holding it exit at its next loop turn. */
export type StopFlag = { stopped: boolean };

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
  stop?: StopFlag;
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
  consecutiveStateErrors: number;
  consecutiveStalls: number;
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

const maxPolls = (pollMs: number): number => Math.ceil(STALL_BUDGET_MS / Math.max(pollMs, 1));

function failIfExhausted(count: number, limit: number, what: string, opts: RunSideOpts, cause?: unknown): void {
  if (count < limit) return;
  throw new Error(`runSide duel ${opts.duelId} side ${opts.side}: ${what} (${count} reads)`, { cause });
}

/** Call state(); null (no data) and rejections both count against the same bounded budget. */
async function fetchState(mem: LoopMemory, opts: RunSideOpts, limit: number): Promise<SideState | null> {
  let s: SideState | null;
  try {
    s = await opts.state();
  } catch (error) {
    mem.consecutiveStateErrors += 1;
    const reason = error instanceof Error ? error.message : String(error);
    failIfExhausted(mem.consecutiveStateErrors, limit, `state() failing: ${reason}`, opts, error);
    return null;
  }
  mem.consecutiveStateErrors = 0;
  mem.consecutiveNulls = s === null ? mem.consecutiveNulls + 1 : 0;
  failIfExhausted(mem.consecutiveNulls, limit, 'no state yet', opts);
  return s;
}

/** Read the next state; null means "nothing new" (caller loops again after the sleep done here). */
async function readState(mem: LoopMemory, opts: RunSideOpts, sleep: (ms: number) => Promise<void>, pollMs: number) {
  const limit = maxPolls(pollMs);
  const s = await fetchState(mem, opts, limit);
  if (s === null) {
    await sleep(pollMs);
    return null;
  }
  if (s.block === mem.lastBlockSeen) {
    mem.consecutiveStalls += 1;
    failIfExhausted(mem.consecutiveStalls, limit, `block stuck at ${s.block}`, opts);
    await sleep(pollMs);
    return null;
  }
  mem.consecutiveStalls = 0;
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
    consecutiveStateErrors: 0,
    consecutiveStalls: 0,
    hpTimeline: [],
  };

  for (;;) {
    if (opts.stop?.stopped) throw new Error(`runSide duel ${opts.duelId} side ${opts.side}: stopped`);
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

/**
 * Pure mapping from an onchain duel to one side's view at `block`.
 *
 * Read-order rule: `block` must not be newer than the duel snapshot `d` it is paired with
 * (read the block number FIRST, then the duel; with a poller cache, use the block the snapshot
 * was taken at). Otherwise a side can see `block >= endBlock` with HP that predates the last
 * landed attacks, end on stale HP, and disagree with the other side.
 */
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

/**
 * Run both sides concurrently. If one side fails, the other is stopped (shared flag) and awaited,
 * so no loop keeps sending after we return; the first failure is the one rethrown.
 */
async function runBothSides(
  opts: RunDuelPairOpts,
  duelId: bigint,
  stateFor: (side: Side) => () => Promise<SideState | null>,
): Promise<[RunSideResult, RunSideResult]> {
  const { p1, p2 } = opts;
  const stop: StopFlag = { stopped: false };
  const failures: unknown[] = [];
  const run = async (side: Side, me: PairSide, other: PairSide): Promise<RunSideResult> => {
    try {
      return await runSide({
        duelId,
        batchBlocks: opts.batchBlocks,
        pollMs: opts.pollMs,
        sleep: opts.sleep,
        stop,
        side,
        send: me.send,
        state: stateFor(side),
        tapsPerSec: me.tapsPerSec,
        useSkill: me.useSkill,
        onBlock: me.onBlock,
        elements: me.element !== undefined && other.element !== undefined
          ? { mine: me.element, opp: other.element }
          : undefined,
      });
    } catch (error) {
      // The first failure is the cause; later "stopped" errors from the sibling are fallout.
      failures.push(error);
      stop.stopped = true;
      throw error;
    }
  };
  const settled = await Promise.allSettled([run(1, p1, p2), run(2, p2, p1)]);
  if (failures.length > 0) throw failures[0];
  const [o1, o2] = settled;
  if (o1?.status !== 'fulfilled' || o2?.status !== 'fulfilled') throw new Error('runDuelPair: sides did not settle');
  return [o1.value, o2.value];
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
  const [r1, r2] = await runBothSides(opts, duelId, stateFor);
  if (r1.status !== r2.status) {
    throw new Error(`runDuelPair duel ${duelId}: sides disagree (${r1.status} vs ${r2.status})`);
  }
  return { duelId, status: r1.status, p1: r1.summary, p2: r2.summary };
}
