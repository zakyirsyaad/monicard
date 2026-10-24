import type { Hex } from 'viem';
import type { DuelStatus, DuelView } from '@nad/shared';

// Frozen interface contract (HTTP API + WebSocket). Do not add fields.
// Approved additions: optional `StatsMsg.lastTxHash` (the server may never send it); optional StakeVault config (N15).

export type Config = {
  chainId: number;
  /** `stakeVault` is optional (N15): the stake UI renders only when it and both stake gas limits are present. */
  contracts: { cards: Hex; arena: Hex; stakeVault?: Hex; battleStakeVault?: Hex };
  gasLimits: {
    freePull: number;
    paidPull: number;
    createDuel: number;
    joinDuel: number;
    attack: number;
    settle: number;
    stake?: number;
    claim?: number;
    /** BattleStakeVault.stake / .claim (optional, fall back to 300,000). */
    battleStake?: number;
    battleClaim?: number;
  };
  /** wei */
  gasPrice: string;
  batchMs: number;
  /** wei */
  pullPrice: string;
  event: { name: string; sponsor: string | null };
  agent: Hex;
  bots: Hex[];
};

/** `StakeVault.stakes(duelId)`. `amount` is 0 while nobody has staked. wei. */
export type StakeView = { amount: bigint; p1Staked: boolean; p2Staked: boolean; claimed: boolean };

export type FundReason = 'disabled' | 'limit_address' | 'limit_ip' | 'budget' | 'balance_ok';

export type FundResult = {
  funded: boolean;
  txHash?: Hex;
  reason?: FundReason;
};

export type Account = {
  /** pending nonce */
  nonce: number;
  /** wei */
  balance: string;
  /** null when the address no longer owns its card */
  cardId: string | null;
  /** the free pull was used */
  hasPulled: boolean;
};

export type RelayResult = {
  hash: Hex;
  status: 'success' | 'reverted';
  latencyMs: number;
  blockNumber: string;
  events: { tokenId?: string; duelId?: string };
};

export type NadgachaCard = {
  id: number;
  atk: number;
  hp: number;
  element: number;
  rarity: number;
  wins: number;
  losses: number;
  mintedAt: number;
  nadmon: { id: string; name: string; stage: 1 | 2 | 3 };
  title: string;
  lore: string;
  status: 'ready' | 'forging';
};

/** ERC-721 metadata, or `{status:'forging'}` while the art is being generated. */
export type CardMeta =
  | {
      name: string;
      description: string;
      image: string;
      attributes: unknown[];
      nadgacha: NadgachaCard;
    }
  | { status: 'forging' };

export type AgentChallengeResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'reserved' | 'not_open' | 'stale' | 'limit_ip' };

// DuelView/DuelStatus are owned by @nad/shared (frozen contract shape).
export type { DuelStatus, DuelView };

export type LeaderboardEntry = {
  address: Hex;
  label: string | null;
  wins: number;
  losses: number;
  cardId: string;
};

export type DuelsMsg = { type: 'duels'; block: string; duels: DuelView[]; featuredId: string | null };

export type StatsMsg = {
  type: 'stats';
  block: string;
  txTotal: number;
  txPerSec: number;
  avgLatencyMs: number;
  uniquePlayers: number;
  totalDuels: number;
  /** wei */
  treasury: string;
  /** Most recent onchain tx the server relayed. Optional: render nothing when absent. */
  lastTxHash?: Hex;
};

export type LeaderboardMsg = { type: 'leaderboard'; entries: LeaderboardEntry[] };

export type AgentLesson = {
  at: number;
  duelId: string;
  text: string;
  thresholdFrom: number;
  thresholdTo: number;
};

export type AgentMsg = {
  type: 'agent';
  level: number;
  threshold: number;
  finisher: boolean;
  sim: { duels: number; wins: number };
  testnet: { duels: number; wins: number };
  lessons: AgentLesson[];
};

export type TauntMsg = { type: 'taunt'; duelId: string; text: string };

export type WsMessage = DuelsMsg | StatsMsg | LeaderboardMsg | AgentMsg | TauntMsg;

export interface Api {
  getConfig(): Promise<Config>;
  getAccount(address: Hex): Promise<Account>;
  fund(address: Hex): Promise<FundResult>;
  /** Throws TimeoutError after `timeoutMs` so the caller can resend the identical raw tx. */
  relay(rawTx: Hex, timeoutMs?: number): Promise<RelayResult>;
  /** `null` when the token does not exist (404). */
  getCard(id: string): Promise<CardMeta | null>;
  challengeAgent(duelId: string): Promise<AgentChallengeResult>;
  /** Stake state of a duel; `null` when the stake UI is disabled. Throws on transient errors (retry later). */
  getStake(duelId: string): Promise<StakeView | null>;
}
