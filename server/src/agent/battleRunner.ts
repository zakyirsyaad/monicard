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
export const BATTLE_RUN_MS = 180_000;
/** Poll interval while waiting for the opponent's move. */
const WAIT_MS = 300;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const defaultLog = (msg: string, err?: unknown): void => console.error(msg, err);
const lower = (address: string): string => address.toLowerCase();

export function createBattleRunner(deps: BattleRunnerDeps): BattleRunner {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? defaultLog;
  const { queue, hub, chain, poller, contracts, gasLimits } = deps;

  let busyFlag = false;

  const readMatch = async (id: bigint): Promise<BattleMatch | null> => {
    try {
      const raw = await chain.call((client) =>
        client.readContract({ address: contracts.battle, abi: battleAbi, functionName: 'getMatch', args: [id] }),
      );
      return decodeMatches([raw], id)[0] ?? null;
    } catch (err) {
      log(`battle: getMatch(${id}) failed`, err);
      return null;
    }
  };

  async function sendAndWait(to: `0x${string}`, data: `0x${string}`, gas: number, timeoutMs: number): Promise<boolean> {
    try {
      const hash = await queue.send({ to, data, gas: BigInt(gas) });
      const receipt: TransactionReceipt = await hub.wait(hash, timeoutMs);
      return receipt.status === 'success';
    } catch (err) {
      log('battle: tx failed', err);
      return false;
    }
  }

  const join = (id: bigint): Promise<boolean> =>
    sendAndWait(
      contracts.battle,
      encodeFunctionData({ abi: battleAbi, functionName: 'joinMatch', args: [id] }),
      gasLimits.joinMatch,
      JOIN_TIMEOUT_MS,
    );

  const act = (id: bigint, handIdx: number, special: boolean): Promise<boolean> =>
    sendAndWait(
      contracts.battle,
      encodeFunctionData({ abi: battleAbi, functionName: 'act', args: [id, handIdx, special] }),
      gasLimits.act,
      ACT_TIMEOUT_MS,
    );

  const claimTimeout = (id: bigint): Promise<boolean> =>
    sendAndWait(
      contracts.battle,
      encodeFunctionData({ abi: battleAbi, functionName: 'claimTimeout', args: [id] }),
      gasLimits.claimTimeout,
      ACT_TIMEOUT_MS,
    );

  /**
   * Play as p2 until the match ends or the time cap. A chain read follows every own
   * action (the poller cache is still one block behind); while waiting for p1 the
   * poller's `getMatch` cache is enough and the chain is only a fallback.
   */
  async function play(id: bigint, policy: Policy): Promise<BattleResult> {
    const deadline = now() + BATTLE_RUN_MS;
    let fresh = true;
    while (now() < deadline) {
      const cached = fresh ? undefined : poller.battleMatch(id.toString());
      const match = cached ?? (await readMatch(id));
      if (match === null) return 'send_failed';
      if (isFinishedMatch(match)) return 'ok';
      if (match.status !== 'Active') return 'not_open';

      if (match.turn === 2) {
        const { handIdx, special } = battleAction(match, policy, 2);
        if (!(await act(id, handIdx, special))) return 'send_failed';
        fresh = true;
        continue;
      }

      if (timeoutDue(match, poller.latestBlock())) {
        if (!(await claimTimeout(id))) return 'send_failed';
        fresh = true;
        continue;
      }

      fresh = false;
      await sleep(WAIT_MS);
    }
    log(`battle: match ${id} hit the ${BATTLE_RUN_MS} ms cap, stopping`);
    return 'ok';
  }

  async function battle(matchId: bigint): Promise<BattleResult> {
    if (busyFlag) return 'busy';
    busyFlag = true;

    let handedOff = false;
    try {
      const id = matchId.toString();
      const match = poller.battleMatch(id) ?? (await readMatch(matchId));
      if (match === null) return 'not_open';
      if (match.status !== 'Open') return 'not_open';
      if (lower(match.p1) === lower(queue.address)) return 'not_open';

      if (!(await join(matchId))) return 'send_failed';

      handedOff = true;
      const policy = deps.store?.get().policy ?? DEFAULT_POLICY;
      // The HTTP answer must not wait for the whole match; play() owns the busy flag from here.
      void play(matchId, policy)
        .catch((err: unknown) => log(`battle: match ${matchId} play failed`, err))
        .finally(() => {
          busyFlag = false;
        });
      return 'ok';
    } catch (err) {
      log(`battle: match ${matchId} failed`, err);
      return 'send_failed';
    } finally {
      if (!handedOff) busyFlag = false;
    }
  }

  return { battle, busy: () => busyFlag };
}