import { encodeFunctionData, type TransactionReceipt } from 'viem';
import { battleAction, decodeMatches, isFinishedMatch, timeoutDue, type BattleMatch } from '../battle';
import { battleAbi } from '../battleAbi';
import type { ChainLike } from '../chainTypes';
import type { ReceiptHub } from '../receiptHub';
import type { WalletQueue } from '../walletQueue';
import { DEFAULT_POLICY, type AgentData, type Policy } from './policy';

/** The structural slice of the poller cache the battle runner reads. */
export type BattlePollerLike = {
  battleMatch(id: string): BattleMatch | undefined;
  latestBlock(): number;
};

export type BattleRunnerDeps = {
  queue: Pick<WalletQueue, 'address' | 'send'>;
  hub: Pick<ReceiptHub, 'wait'>;
  chain: ChainLike;
  poller: BattlePollerLike;
  store?: { get(): AgentData };
  contracts: { battle: `0x${string}` };
  gasLimits: { joinMatch: number; act: number; claimTimeout: number };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, err?: unknown) => void;
};

export type BattleResult = 'ok' | 'busy' | 'not_open' | 'send_failed';

export type BattleRunner = {
  /** Joins an Open match as p2, then plays it in the background until it ends or the time cap. */
  battle(matchId: bigint): Promise<BattleResult>;
  busy(): boolean;
};

const JOIN_TIMEOUT_MS = 10_000;
const ACT_TIMEOUT_MS = 10_000;
/** Hard cap for one match; a stuck opponent must not pin the runner forever. */
export const BATTLE_RUN_MS = 120_000;
/** One wallet can carry this many matches; the queue serializes their transactions. */
export const MAX_ACTIVE_MATCHES = 3;
/** Poll interval while waiting for the opponent's move. */
const WAIT_MS = 300;
/** Chain re-read while idle even when the poller cache has not moved (~3 s). */
const CACHE_REFRESH_EVERY = 10;
/** A just-created match (or a fresh act) can need a few blocks before getMatch catches up. */
const MATCH_LOOKUP_ATTEMPTS = 8;
const MATCH_LOOKUP_MS = 300;
/** A reverted claimTimeout is retried at most this often; the next fresh read decides. */
const MAX_CLAIM_ATTEMPTS = 3;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const defaultLog = (msg: string, err?: unknown): void => console.error(msg, err);
const lower = (address: string): string => address.toLowerCase();

export function createBattleRunner(deps: BattleRunnerDeps): BattleRunner {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? defaultLog;
  const { queue, hub, chain, poller, contracts, gasLimits } = deps;

  let activeMatches = 0;

  const readMatch = async (id: bigint, quiet = false): Promise<BattleMatch | null> => {
    try {
      const raw = await chain.call((client) =>
        client.readContract({ address: contracts.battle, abi: battleAbi, functionName: 'getMatch', args: [id] }),
      );
      return decodeMatches([raw], id)[0] ?? null;
    } catch (err) {
      if (!quiet) log(`battle: getMatch(${id}) failed`, err);
      return null;
    }
  };

  /** Poller cache first, then a short chain retry: the frontend calls this right after createMatch. */
  async function findMatch(id: bigint): Promise<BattleMatch | null> {
    const cached = poller.battleMatch(id.toString());
    if (cached !== undefined) return cached;
    for (let attempt = 0; attempt < MATCH_LOOKUP_ATTEMPTS; attempt += 1) {
      const found = await readMatch(id, true);
      if (found !== null) return found;
      await sleep(MATCH_LOOKUP_MS);
    }
    const late = poller.battleMatch(id.toString());
    if (late !== undefined) return late;
    log(`battle: match ${id} not found after ${MATCH_LOOKUP_ATTEMPTS} chain reads`);
    return null;
  }

  /**
   * Read the match until the chain state reflects a tx mined at `minBlock`.
   * Monad's `eth_call` can still return the pre-tx state for a block or two after
   * the receipt, and acting on that stale view is what makes a runner re-place a
   * card and revert. `lastMoveBlock` is written by join/act, so it is the ceiling.
   */
  async function readConfirmed(id: bigint, minBlock: number): Promise<BattleMatch | null> {
    for (let attempt = 0; attempt < MATCH_LOOKUP_ATTEMPTS; attempt += 1) {
      const match = await readMatch(id, true);
      if (match !== null && match.lastMoveBlock >= minBlock) return match;
      await sleep(MATCH_LOOKUP_MS);
    }
    return null;
  }

  async function sendAndWait(
    to: `0x${string}`,
    data: `0x${string}`,
    gas: number,
    timeoutMs: number,
  ): Promise<TransactionReceipt | null> {
    try {
      const hash = await queue.send({ to, data, gas: BigInt(gas) });
      return await hub.wait(hash, timeoutMs);
    } catch (err) {
      log('battle: tx failed', err);
      return null;
    }
  }

  const join = (id: bigint): Promise<TransactionReceipt | null> =>
    sendAndWait(
      contracts.battle,
      encodeFunctionData({ abi: battleAbi, functionName: 'joinMatch', args: [id] }),
      gasLimits.joinMatch,
      JOIN_TIMEOUT_MS,
    );

  const act = (id: bigint, handIdx: number, special: boolean): Promise<TransactionReceipt | null> =>
    sendAndWait(
      contracts.battle,
      encodeFunctionData({ abi: battleAbi, functionName: 'act', args: [id, handIdx, special] }),
      gasLimits.act,
      ACT_TIMEOUT_MS,
    );

  const claimTimeout = (id: bigint): Promise<TransactionReceipt | null> =>
    sendAndWait(
      contracts.battle,
      encodeFunctionData({ abi: battleAbi, functionName: 'claimTimeout', args: [id] }),
      gasLimits.claimTimeout,
      ACT_TIMEOUT_MS,
    );

  /**
   * Play as p2 until the match ends or the time cap. Every action waits for a
   * chain read that has caught up to the last receipt; the poller cache only
   * wakes the wait loop early and never decides an action on its own.
   */
  async function play(id: bigint, policy: Policy, joinedAtBlock: number): Promise<BattleResult> {
    const deadline = now() + BATTLE_RUN_MS;
    let blockReadFailed = false;
    /** Live block for the turn clock; the poller cache may be empty or behind. */
    const readBlock = async (): Promise<number> => {
      try {
        return Number(await chain.call((client) => client.getBlockNumber()));
      } catch (err) {
        if (!blockReadFailed) {
          blockReadFailed = true;
          log(`battle: getBlockNumber failed for match ${id}`, err);
        }
        return poller.latestBlock();
      }
    };

    let confirmedBlock = joinedAtBlock;
    let latestBlock = await readBlock();
    let match = await readConfirmed(id, confirmedBlock);
    let idle = 0;
    let claimAttempts = 0;

    while (now() < deadline) {
      if (match === null || match.lastMoveBlock < confirmedBlock) {
        await sleep(WAIT_MS);
        match = await readConfirmed(id, confirmedBlock);
        continue;
      }
      if (isFinishedMatch(match)) return 'ok';
      if (match.status !== 'Active') return 'not_open';

      if (match.turn === 2) {
        const { handIdx, special } = battleAction(match, policy, 2);
        const receipt = await act(id, handIdx, special);
        if (receipt === null || receipt.status !== 'success') return 'send_failed';
        confirmedBlock = Number(receipt.blockNumber);
        match = await readConfirmed(id, confirmedBlock);
        idle = 0;
        claimAttempts = 0;
        continue;
      }

      if (timeoutDue(match, latestBlock)) {
        if (claimAttempts >= MAX_CLAIM_ATTEMPTS) {
          log(`battle: claimTimeout(${id}) still reverting after ${MAX_CLAIM_ATTEMPTS} attempts`);
          return 'send_failed';
        }
        claimAttempts += 1;
        const receipt = await claimTimeout(id);
        if (receipt === null) return 'send_failed';
        // A successful claim is final. A revert means p1 moved inside the stale window:
        // re-read and let the loop act or wait instead of abandoning a joined match.
        if (receipt.status === 'success') return 'ok';
        match = await readConfirmed(id, confirmedBlock);
        idle = 0;
        continue;
      }

      await sleep(WAIT_MS);
      idle += 1;
      const cached = poller.battleMatch(id.toString());
      const moved = cached !== undefined && cached.lastMoveBlock > match.lastMoveBlock;
      if (moved || idle >= CACHE_REFRESH_EVERY) {
        match = await readConfirmed(id, confirmedBlock);
        latestBlock = await readBlock();
        idle = 0;
      }
    }
    log(`battle: match ${id} hit the ${BATTLE_RUN_MS} ms cap, stopping`);
    return 'ok';
  }

  /** Starts the background loop and hands its match slot to it. */
  function startPlay(id: bigint, fromBlock: number, policy: Policy): void {
    void play(id, policy, fromBlock)
      .catch((err: unknown) => log(`battle: match ${id} play failed`, err))
      .finally(() => {
        activeMatches -= 1;
      });
  }

  async function battle(matchId: bigint): Promise<BattleResult> {
    if (activeMatches >= MAX_ACTIVE_MATCHES) return 'busy';
    activeMatches += 1;

    let handedOff = false;
    try {
      const match = await findMatch(matchId);
      if (match === null) return 'not_open';
      if (lower(match.p1) === lower(queue.address)) return 'not_open';

      // Resume an Active match where this wallet is p2: a lost join receipt or a
      // server restart must not leave the human facing a dead opponent.
      if (match.status === 'Active') {
        if (lower(match.p2) !== lower(queue.address)) return 'not_open';
        const policy = deps.store?.get().policy ?? DEFAULT_POLICY;
        handedOff = true;
        startPlay(matchId, match.lastMoveBlock, policy);
        return 'ok';
      }
      if (match.status !== 'Open') return 'not_open';

      const joinReceipt = await join(matchId);
      if (joinReceipt === null || joinReceipt.status !== 'success') {
        // The node may have accepted the join even though the receipt wait failed.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const after = await readMatch(matchId, true);
          if (after !== null && after.status === 'Active' && lower(after.p2) === lower(queue.address)) {
            const policy = deps.store?.get().policy ?? DEFAULT_POLICY;
            handedOff = true;
            startPlay(matchId, after.lastMoveBlock, policy);
            return 'ok';
          }
          await sleep(MATCH_LOOKUP_MS);
        }
        return 'send_failed';
      }

      const policy = deps.store?.get().policy ?? DEFAULT_POLICY;
      handedOff = true;
      startPlay(matchId, Number(joinReceipt.blockNumber), policy);
      return 'ok';
    } catch (err) {
      log(`battle: match ${matchId} failed`, err);
      return 'send_failed';
    } finally {
      if (!handedOff) activeMatches -= 1;
    }
  }

  return { battle, busy: () => activeMatches >= MAX_ACTIVE_MATCHES };
}
