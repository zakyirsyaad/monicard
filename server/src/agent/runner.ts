import {
  blitzArenaAbi,
  COUNTDOWN_BLOCKS,
  decodeDuels,
  nadCardsAbi,
  type DuelView,
  type Hex,
} from '@nad/shared';
import { encodeFunctionData, type TransactionReceipt } from 'viem';
import type { ChainLike } from '../chainTypes';
import type { ReceiptHub } from '../receiptHub';
import { sideStateFromDuel, runSide } from '../sim/duelLoop';
import type { DuelSummary, SideState } from '../sim/types';
import type { WalletQueue } from '../walletQueue';
import type { AgentMsg } from '../ws';
import { onDuelSettled, ruleCoach, type CoachContext } from './coach';
import { agentTapRate, decideSkill, levelFromWins, rollDiscipline, type Policy } from './policy';
import { agentMessage, type AgentStore } from './store';

export type ChallengeResult = 'ok' | 'busy' | 'reserved' | 'not_open' | 'stale';

/** The agent wallet: just the address and the send method this runner needs. */
export type WalletQueueLike = Pick<WalletQueue, 'address' | 'send'>;

/** The structural slice of the poller cache the runner reads. */
export type PollerLike = {
  getDuel(id: string): DuelView | undefined;
  createdBlock(id: string): number | undefined;
  latestBlock(): number;
};

export type AgentRunnerDeps = {
  queue: WalletQueueLike;
  hub: Pick<ReceiptHub, 'wait'>;
  chain: ChainLike;
  poller: PollerLike;
  store: AgentStore;
  broadcast: (msg: AgentMsg) => void;
  contracts: { cards: Hex; arena: Hex };
  gasLimits: { joinDuel: number; attack: number };
  rng?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, err?: unknown) => void;
};

export type AgentRunner = {
  challenge(duelId: bigint): Promise<ChallengeResult>;
  busy(): boolean;
  reserveFor(p1: Hex | null): void;
};

const JOIN_TIMEOUT_MS = 10_000;
const ATTACK_TIMEOUT_MS = 10_000;
/** ≈ 1 s at Monad's 0.3 s blocks. */
const AGENT_BATCH_BLOCKS = 3;
/** An Open duel older than this can no longer be joined sensibly. */
const STALE_BLOCKS = 200;
/** Head advances to wait for a just-created duel to show up in a chain read. */
const CHAIN_FALLBACK_BLOCKS = 3;
const FALLBACK_POLL_MS = 150;
/** Bounded safety net in case the poller head never moves. */
const MAX_FALLBACK_READS = 40;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const defaultLog = (msg: string, err?: unknown): void => console.error(msg, err);

const lower = (address: Hex): string => address.toLowerCase();

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const rng = deps.rng ?? Math.random;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? defaultLog;
  const { queue, hub, chain, poller, store, contracts, gasLimits } = deps;

  let busyFlag = false;
  let reserved: string | null = null;
  let agentCardId: bigint | null = null;

  async function readDuel(duelId: bigint): Promise<DuelView | null> {
    const raw = await chain.call((client) =>
      client.readContract({
        address: contracts.arena,
        abi: blitzArenaAbi,
        functionName: 'getDuels',
        args: [duelId, 1n],
      }),
    );
    return decodeDuels(raw, duelId)[0] ?? null;
  }

  /**
   * The poller cache first; a challenge can arrive before the next poll has seen
   * the freshly created duel, so read it from the chain and give the head three
   * blocks to advance before concluding that it does not exist.
   */
  async function findDuel(duelId: bigint): Promise<DuelView | null> {
    const cached = poller.getDuel(duelId.toString());
    if (cached !== undefined) return cached;

    const startHead = poller.latestBlock();
    for (let attempt = 0; attempt < MAX_FALLBACK_READS; attempt += 1) {
      const found = await readDuel(duelId);
      if (found !== null) return found;
      if (poller.latestBlock() - startHead >= CHAIN_FALLBACK_BLOCKS) return null;
      await sleep(FALLBACK_POLL_MS);
    }
    return null;
  }

  /**
   * Creation block for the staleness check. `poller.createdBlock` is undefined for
   * duels created before the server started; an Active view still carries its start
   * block. An Open duel has startBlock 0 (the contract sets it on join), so its age
   * is unknown and it is not treated as stale.
   */
  function createdBlockOf(duel: DuelView, id: string): number | undefined {
    const recorded = poller.createdBlock(id);
    if (recorded !== undefined) return recorded;
    return duel.startBlock >= COUNTDOWN_BLOCKS ? duel.startBlock - COUNTDOWN_BLOCKS : undefined;
  }

  /** Ordered guard checks; null means the challenge may proceed. */
  function rejectReason(duel: DuelView, id: string): ChallengeResult | null {
    if (duel.status !== 'Open') return 'not_open';
    if (lower(duel.p1) === lower(queue.address)) return 'not_open';

    const created = createdBlockOf(duel, id);
    if (created !== undefined && poller.latestBlock() - created > STALE_BLOCKS) return 'stale';

    if (reserved !== null && lower(duel.p1) !== reserved) return 'reserved';
    return null;
  }

  /** The wallet's last-pulled card, cached after the first successful read. */
  async function agentCard(): Promise<bigint> {
    if (agentCardId !== null) return agentCardId;
    const id = await chain.call((client) =>
      client.readContract({
        address: contracts.cards,
        abi: nadCardsAbi,
        functionName: 'cardOf',
        args: [queue.address],
      }),
    );
    agentCardId = id;
    return id;
  }

  async function readElement(cardId: number | bigint): Promise<number | null> {
    try {
      const card = await chain.call((client) =>
        client.readContract({
          address: contracts.cards,
          abi: nadCardsAbi,
          functionName: 'cards',
          args: [BigInt(cardId)],
        }),
      );
      return typeof card.element === 'number' ? card.element : null;
    } catch (error) {
      log(`agent: card ${cardId} element read failed`, error);
      return null;
    }
  }

  /** The summary's elements; omitted when either card could not be read. */
  async function readElements(cardId: bigint, opponentCardId: number): Promise<{ mine: number; opp: number } | undefined> {
    const [mine, opp] = await Promise.all([readElement(cardId), readElement(opponentCardId)]);
    return mine !== null && opp !== null ? { mine, opp } : undefined;
  }

  /** Sends joinDuel and waits for its receipt; any failure means "could not join". */
  async function join(duelId: bigint, cardId: bigint): Promise<TransactionReceipt | null> {
    const data = encodeFunctionData({ abi: blitzArenaAbi, functionName: 'joinDuel', args: [duelId, cardId] });
    try {
      const hash = await queue.send({ to: contracts.arena, data, gas: BigInt(gasLimits.joinDuel) });
      return await hub.wait(hash, JOIN_TIMEOUT_MS);
    } catch (error) {
      log(`agent: joinDuel(${duelId}) failed`, error);
      return null;
    }
  }

  /** Folds one finished duel into the store, broadcasts it, and coaches when the policy was followed. */
  function recordDuel(
    duel: DuelView,
    side: Omit<DuelSummary, 'mode' | 'opponent' | 'followedPolicy'>,
    followPolicy: boolean,
    policy: Policy,
    last: SideState | null,
  ): void {
    const summary: DuelSummary = {
      ...side,
      mode: 'testnet',
      opponent: duel.p1,
      followedPolicy: followPolicy,
    };
    const ctx: CoachContext | undefined =
      last === null ? undefined : { atk: last.atk, mult: last.mult, myMaxHp: last.myMaxHp };
    const out = followPolicy ? ruleCoach(summary, policy, rng, ctx) : null;
    const next = store.update((current) => onDuelSettled(current, summary, out, now()));
    deps.broadcast(agentMessage(next));
  }

  /**
   * One background duel for side 2. Everything it needs was drawn at the start:
   * discipline once per duel, one r for the random skill point, one tap rate.
   */
  async function playDuel(duel: DuelView, duelId: bigint, elements?: { mine: number; opp: number }): Promise<void> {
    const id = duelId.toString();
    try {
      const data = store.get();
      const policy = data.policy;
      const level = levelFromWins(data.sim.wins + data.testnet.wins);
      const followPolicy = rollDiscipline(level, rng);
      const r = rng();
      const rate = agentTapRate(rng);
      // A holder, not a plain local: the assignment happens inside onBlock.
      const trace: { last: SideState | null } = { last: null };

      const result = await runSide({
        side: 2,
        duelId,
        batchBlocks: AGENT_BATCH_BLOCKS,
        tapsPerSec: () => rate,
        useSkill: (s) => decideSkill(s, policy, followPolicy, () => r),
        onBlock: (s) => {
          trace.last = s;
        },
        elements,
        send: (data) =>
          queue
            .send({ to: contracts.arena, data, gas: BigInt(gasLimits.attack) })
            .then((hash) => hub.wait(hash, ATTACK_TIMEOUT_MS)),
        state: async () => {
          // Read the block first: the duel snapshot must not be newer than it.
          const block = poller.latestBlock();
          const current = poller.getDuel(id);
          return current !== undefined && current.status !== 'Open' ? sideStateFromDuel(current, 2, block) : null;
        },
      });

      recordDuel(duel, result.summary, followPolicy, policy, trace.last);
    } catch (error) {
      log(`agent duel ${id} failed`, error);
    } finally {
      busyFlag = false;
    }
  }

  async function challenge(duelId: bigint): Promise<ChallengeResult> {
    if (busyFlag) return 'busy';
    busyFlag = true;

    let handedOff = false;
    try {
      const duel = await findDuel(duelId);
      if (duel === null) return 'not_open';

      const rejected = rejectReason(duel, duelId.toString());
      if (rejected !== null) return rejected;

      const cardId = await agentCard();
      if (cardId === 0n) {
        log('agent has no card');
        return 'not_open';
      }

      const elements = await readElements(cardId, duel.card1);
      const receipt = await join(duelId, cardId);
      if (receipt === null || receipt.status !== 'success') {
        log(`agent: joinDuel(${duelId}) did not succeed`);
        return 'not_open';
      }

      handedOff = true;
      // The HTTP response must not wait ~20 s for the duel; the finally above would
      // release busy, so playDuel owns the flag from here and always clears it.
      void playDuel(duel, duelId, elements).catch(() => undefined);
      return 'ok';
    } finally {
      if (!handedOff) busyFlag = false;
    }
  }

  return {
    challenge,
    busy: () => busyFlag,
    reserveFor(p1) {
      reserved = p1 === null ? null : lower(p1);
    },
  };
}