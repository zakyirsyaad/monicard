import {
  decodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
} from 'viem';
import type { Hex, TransactionSerialized } from 'viem';
import { blitzArenaAbi, nadCardsAbi, stakeVaultAbi } from '../lib/abi';
import { ApiError } from '../lib/api';
import {
  COUNTDOWN_BLOCKS,
  DUEL_BLOCKS,
  allowedTaps,
  elementMult,
  nadmonFor,
  skillDamage,
  tapDamage,
} from '../lib/game';
import type {
  Account,
  AgentChallengeResult,
  AgentLesson,
  AgentMsg,
  CardMeta,
  Config,
  DuelView,
  DuelsMsg,
  FundResult,
  RelayResult,
  StakeView,
  StatsMsg,
} from '../lib/types';
import { AGENT_LESSON_TEXT, cardText } from './lore';

export const MOCK_START_BLOCK = 73_562_000;
export const MOCK_BLOCK_MS = 300;

const CHAIN_ID = 10143;
const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';
const PULL_PRICE = 50_000_000_000_000_000n;
const FUND_AMOUNT = 300_000_000_000_000_000n;
const FUND_MIN_BALANCE = 100_000_000_000_000_000n;
const FUND_MAX_PER_ADDRESS = 3;

const RELAY_LATENCY_MIN_MS = 180;
const RELAY_LATENCY_SPAN_MS = 471; // 180..650 inclusive
const AGENT_JOIN_DELAY_MS = 1500;
const FRIEND_WAIT_MS = 6000;
const FORGE_BARE_MS = 1000; // bare `{status:'forging'}` until here
const FORGE_MS = 2000; // full metadata with status 'forging' until here
const STATS_WINDOW_MS = 5000;
const LATENCY_SAMPLES = 50;
const SETTLE_DELAY_BLOCKS = 2;
const NO_SEND_MARGIN = 2;
const BOT_INTERVAL_BLOCKS = 3;
const SNAPSHOT_DUELS = 64;
const MAX_LESSONS = 20;

const MIN_STAKE = 1_000_000_000_000_000n; // 0.001 MON
const MAX_STAKE = 1_000_000_000_000_000_000n; // 1 MON
const RAKE_BPS = 500n;
const BPS = 10_000n;
const OPEN_REFUND_BLOCKS = 1200;

const AGENT_START_THRESHOLD = 30;
const AGENT_THRESHOLD_STEP = 10;
const AGENT_THRESHOLD_MIN = 20;
const AGENT_THRESHOLD_MAX = 60;
const AGENT_BASE_TAPS = 7;
const FRIEND_SKILL_THRESHOLD = 40;
const FRIEND_MIN_RATE = 5;
const FRIEND_RATE_SPAN = 5; // 5..9 taps per second
const TAPS_PER_SECOND_BLOCKS = 0.9; // seconds covered by one bot interval (3 blocks)
const SHOWCASE_LANE_STAGGER_BLOCKS = 4; // lane i starts i * 4 blocks after the showcase starts
const SHOWCASE_PAUSE_BLOCKS = 20; // a settled showcase duel stays on screen ~6 s before its lane restarts
const SHOWCASE_LATENCY_STEP = 37;

const CONFIG: Config = {
  chainId: CHAIN_ID,
  contracts: {
    cards: '0x00000000000000000000000000000000000000c1',
    arena: '0x00000000000000000000000000000000000000a1',
    stakeVault: '0x00000000000000000000000000000000000000d1',
  },
  gasLimits: {
    freePull: 400000,
    paidPull: 400000,
    createDuel: 300000,
    joinDuel: 300000,
    attack: 120000,
    settle: 200000,
    stake: 131000,
    claim: 154000,
  },
  gasPrice: '100000000000',
  batchMs: 1000,
  pullPrice: PULL_PRICE.toString(),
  event: { name: 'Monad Blitz Jogja Vol. 2', sponsor: null },
  agent: '0x00000000000000000000000000000000000000a9',
  // bots[0] is the "friend" that joins open duels; the rest play the projector showcase.
  bots: [
    '0x00000000000000000000000000000000000000b1',
    '0x00000000000000000000000000000000000000b2',
    '0x00000000000000000000000000000000000000b3',
    '0x00000000000000000000000000000000000000b4',
    '0x00000000000000000000000000000000000000b5',
    '0x00000000000000000000000000000000000000b6',
    '0x00000000000000000000000000000000000000b7',
  ],
};
const SHOWCASE_BOT_PAIRS = [
  [1, 2],
  [3, 4],
  [5, 6],
] as const; // indexes into CONFIG.bots
const SHOWCASE_GUEST: Hex = '0x00000000000000000000000000000000000ca401'; // not a bot: the featured human

const AGENT_CARD = { element: 1, rarity: 1, atk: 13, hp: 1750 } as const; // Water Rare
const FRIEND_CARD = { element: 2, rarity: 1, atk: 12, hp: 1700 } as const; // Lightning Rare

type CardStats = { element: number; rarity: number; atk: number; hp: number };
type Outcome = { status: 'success' | 'reverted'; events: RelayResult['events'] };
type Id = number | bigint | string;
type Controller = 'agent' | 'friend' | 'showcase';

type CardRecord = {
  id: number;
  atk: number;
  hp: number;
  element: number;
  rarity: number;
  wins: number;
  losses: number;
  mintedAt: number;
  mintedAtMs: number;
  owner: Hex;
};

type Wallet = { nonce: number; balance: bigint; fundCount: number };

type StakeRecord = StakeView & { openedBlock: number };

type DuelRuntime = {
  view: DuelView;
  finishedBlock: number | null;
  controller: Controller | null;
  nextActionBlock: number;
  /** Projector showcase duel: its bots report a synthetic latency. */
  showcase: boolean;
  /** The human-like opponent the agent also taps for in the showcase's AI Agent duel. */
  guest: Hex | null;
};

/** One looping duel slot of the projector showcase. */
type ShowcaseLane = {
  p1: Hex;
  p2: Hex;
  stats: readonly [CardStats, CardStats];
  controller: Controller;
  guest: Hex | null;
  duelId: string | null;
  /** First block at which the lane may (re)start a duel. */
  startAt: number;
};

// Varied cards so the projector shows all elements and several rarities.
const SHOWCASE_GUEST_CARD: CardStats = { element: 2, rarity: 1, atk: 12, hp: 1700 };
const SHOWCASE_BOT_CARDS: readonly CardStats[] = [
  { element: 0, rarity: 0, atk: 11, hp: 1550 },
  { element: 1, rarity: 1, atk: 13, hp: 1650 },
  { element: 2, rarity: 2, atk: 14, hp: 1800 },
  { element: 0, rarity: 0, atk: 12, hp: 1500 },
  { element: 1, rarity: 3, atk: 15, hp: 1900 },
  { element: 2, rarity: 1, atk: 12, hp: 1600 },
];

export type MockChainOptions = {
  /** Block interval; 0 disables the timer so tests drive blocks with `tick()`. */
  blockMs?: number;
  /** Uniform [0, 1). Draw order of a card roll: rarity roll, atk bonus, hp bonus, element. */
  rng?: () => number;
  now?: () => number;
};

export type MockChain = {
  readonly config: Config;
  block(): number;
  /** Advance one block (the interval calls this). */
  tick(): void;
  subscribe(fn: (block: number) => void): () => void;
  subscribeAgent(fn: () => void): () => void;
  /** Stop the block interval and cancel every pending timer. */
  dispose(): void;
  disableAutoFriend(): void;
  /**
   * Projector showcase: three bot-vs-bot duel loops plus a looping AI Agent vs guest duel
   * (the guest is not in `config.bots`, so it is the featured duel). Reference counted; returns stop.
   */
  startShowcase(): () => void;

  /** Dev/test helpers. */
  credit(address: Hex, wei: bigint): void;
  setBalance(address: Hex, wei: bigint): void;
  balanceOf(address: Hex): bigint;

  /** Contract calls (the relay executes these at the block current when its delay ends). */
  freePull(sender: Hex): Outcome;
  paidPull(sender: Hex, value: bigint): Outcome;
  createDuel(sender: Hex, cardId: Id): Outcome;
  joinDuel(sender: Hex, id: Id, cardId: Id): Outcome;
  attack(sender: Hex, id: Id, taps: number, useSkill: boolean): Outcome;
  settle(sender: Hex, id: Id): Outcome;
  /** StakeVault: `stake` needs the exact `value`; `claim` is a no-op once paid. */
  stake(sender: Hex, id: Id, value: bigint): Outcome;
  claim(sender: Hex, id: Id): Outcome;

  /** Contract views. */
  cardOf(address: Hex): number;
  card(id: Id): CardRecord | null;
  duel(id: Id): DuelView | null;
  duels(): DuelView[];

  /** Server-like endpoints. */
  getAccount(address: Hex): Account;
  fund(address: Hex): FundResult;
  relay(rawTx: Hex): Promise<RelayResult>;
  getCard(id: string): CardMeta | null;
  challengeAgent(duelId: string): AgentChallengeResult;
  /** `StakeVault.stakes(duelId)`; an all-zero view when nobody staked. */
  getStake(duelId: string): StakeView;

  /** WebSocket payloads. `scope` is `all` or `duel:<id>`. */
  duelsMsg(scope: string): DuelsMsg;
  statsMsg(): StatsMsg;
  agentMsg(): AgentMsg;
};

const keyOf = (a: Hex): string => a.toLowerCase();
const sameAddress = (a: Hex, b: Hex): boolean => keyOf(a) === keyOf(b);
const isFinished = (d: DuelView): boolean =>
  d.status === 'P1Won' || d.status === 'P2Won' || d.status === 'Draw';
const emptyStake = (): StakeRecord => ({ amount: 0n, p1Staked: false, p2Staked: false, claimed: false, openedBlock: 0 });
const reverted = (): Outcome => ({ status: 'reverted', events: {} });
const ok = (events: Outcome['events'] = {}): Outcome => ({ status: 'success', events });

export function createMockChain(opts: MockChainOptions = {}): MockChain {
  const blockMs = opts.blockMs ?? MOCK_BLOCK_MS;
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? (() => Date.now());

  let block = MOCK_START_BLOCK;
  let nextTokenId = 1;
  let treasury = 0n;
  let autoFriend = true;
  let agentPendingDuel: string | null = null;
  let agentThreshold = AGENT_START_THRESHOLD;
  let agentLevel = 1;
  const sim = { duels: 0, wins: 0 };
  const testnet = { duels: 0, wins: 0 };
  let lessons: AgentLesson[] = [];
  let txTotal = 0;
  let lastTxHash: Hex | null = null;
  let showcaseRefs = 0;
  let lanes: ShowcaseLane[] = [];
  const txTimes: number[] = [];
  const latencies: number[] = [];

  const wallets = new Map<string, Wallet>();
  const cards = new Map<number, CardRecord>();
  const cardOfMap = new Map<string, number>();
  const duelList: DuelRuntime[] = [];
  const stakes = new Map<string, StakeRecord>();
  const relayed = new Map<Hex, Promise<RelayResult>>();
  const blockSubs = new Set<(block: number) => void>();
  const agentSubs = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let interval: ReturnType<typeof setInterval> | null = null;

  const botKeys = new Set([keyOf(CONFIG.agent), ...CONFIG.bots.map(keyOf)]);
  const botOnlyKeys = new Set(CONFIG.bots.map(keyOf));
  /** Bots on both sides: never featured on the projector. */
  const isBotOnly = (d: DuelView): boolean => botOnlyKeys.has(keyOf(d.p1)) && botOnlyKeys.has(keyOf(d.p2));
  const friendAddress = CONFIG.bots[0] as Hex;

  function later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  }

  const walletOf = (address: Hex): Wallet => {
    const k = keyOf(address);
    const existing = wallets.get(k);
    if (existing) return existing;
    const created: Wallet = { nonce: 0, balance: 0n, fundCount: 0 };
    wallets.set(k, created);
    return created;
  };

  const rollInt = (span: number): number => Math.floor(rng() * span);

  function mint(owner: Hex, stats?: CardStats) {
    let rolled = stats;
    if (!rolled) {
      const roll = rollInt(100);
      const rarity = roll < 60 ? 0 : roll < 88 ? 1 : roll < 98 ? 2 : 3;
      const atk = 10 + rollInt(5) + rarity;
      const hp = 1500 + rollInt(301) + 100 * rarity;
      rolled = { rarity, atk, hp, element: rollInt(3) };
    }
    const record: CardRecord = {
      id: nextTokenId++,
      ...rolled,
      wins: 0,
      losses: 0,
      mintedAt: block,
      mintedAtMs: now(),
      owner,
    };
    cards.set(record.id, record);
    cardOfMap.set(keyOf(owner), record.id);
    return record;
  }

  /** Bot cards are minted on first use so player token ids still start at 1. */
  function botCard(address: Hex, stats: CardStats): CardRecord {
    const existing = cardOfMap.get(keyOf(address));
    const found = existing === undefined ? undefined : cards.get(existing);
    return found ?? mint(address, stats);
  }

  const runtime = (id: Id): DuelRuntime | null => duelList[Number(id)] ?? null;

  function countTx(latencyMs?: number, hash?: Hex): void {
    txTotal += 1;
    lastTxHash = hash ?? keccak256(stringToHex(`mock-tx:${txTotal}`));
    txTimes.push(now());
    if (latencyMs !== undefined) {
      latencies.push(latencyMs);
      if (latencies.length > LATENCY_SAMPLES) latencies.shift();
    }
  }

  // ---- contract: NadCards ----

  function freePull(sender: Hex): Outcome {
    if (cardOfMap.has(keyOf(sender))) return reverted();
    return ok({ tokenId: String(mint(sender).id) });
  }

  function paidPull(sender: Hex, value: bigint): Outcome {
    const wallet = walletOf(sender);
    if (value !== PULL_PRICE || wallet.balance < value) return reverted();
    wallet.balance -= value;
    treasury += value;
    return ok({ tokenId: String(mint(sender).id) });
  }

  // ---- contract: BlitzArena ----

  function finish(rt: DuelRuntime, status: DuelView['status']): void {
    rt.view.status = status;
    rt.finishedBlock = block;
  }

  function closeByHp(rt: DuelRuntime): void {
    const { hp1, hp2 } = rt.view;
    finish(rt, hp1 > hp2 ? 'P1Won' : hp2 > hp1 ? 'P2Won' : 'Draw');
  }

  function scheduleFriend(duelId: string): void {
    later(() => {
      const rt = runtime(duelId);
      if (!autoFriend || !rt || rt.view.status !== 'Open' || agentPendingDuel === duelId) return;
      const card = botCard(friendAddress, FRIEND_CARD);
      if (joinDuel(friendAddress, duelId, card.id).status === 'success') {
        rt.controller = 'friend';
        countTx();
        const placed = stakes.get(duelId);
        if (placed?.p1Staked) stake(friendAddress, duelId, placed.amount); // the friend matches the stake
      }
    }, FRIEND_WAIT_MS);
  }

  function createDuel(sender: Hex, cardId: Id): Outcome {
    const card = cards.get(Number(cardId));
    if (!card || !sameAddress(card.owner, sender)) return reverted();
    const id = String(duelList.length);
    duelList.push({
      view: {
        id,
        p1: sender,
        p2: ZERO_ADDRESS,
        hp1: card.hp,
        hp2: 0,
        atk1: card.atk,
        atk2: 0,
        mult1: 0,
        mult2: 0,
        lastBlock1: 0,
        lastBlock2: 0,
        skill1: false,
        skill2: false,
        status: 'Open',
        startBlock: 0,
        endBlock: 0,
        card1: card.id,
        card2: 0,
        maxHp1: card.hp,
        maxHp2: 0,
        settled: false,
      },
      finishedBlock: null,
      controller: null,
      nextActionBlock: 0,
      showcase: false,
      guest: null,
    });
    if (!botKeys.has(keyOf(sender))) scheduleFriend(id);
    return ok({ duelId: id });
  }

  function joinDuel(sender: Hex, id: Id, cardId: Id): Outcome {
    const rt = runtime(id);
    const card = cards.get(Number(cardId));
    const first = rt ? cards.get(rt.view.card1) : undefined;
    if (!rt || !card || !first || rt.view.status !== 'Open') return reverted();
    if (sameAddress(sender, rt.view.p1) || !sameAddress(card.owner, sender)) return reverted();
    const d = rt.view;
    const start = block + COUNTDOWN_BLOCKS;
    Object.assign(d, {
      p2: sender,
      card2: card.id,
      atk2: card.atk,
      hp2: card.hp,
      maxHp2: card.hp,
      mult1: elementMult(first.element, card.element),
      mult2: elementMult(card.element, first.element),
      startBlock: start,
      endBlock: start + DUEL_BLOCKS,
      lastBlock1: start,
      lastBlock2: start,
      status: 'Active',
    } satisfies Partial<DuelView>);
    rt.nextActionBlock = start + BOT_INTERVAL_BLOCKS;
    return ok();
  }

  function attack(sender: Hex, id: Id, taps: number, useSkill: boolean): Outcome {
    const rt = runtime(id);
    if (!rt) return reverted();
    const d = rt.view;
    const side = sameAddress(sender, d.p1) ? 1 : sameAddress(sender, d.p2) ? 2 : 0;
    if (side === 0 || d.status === 'Open') return reverted();
    if (isFinished(d)) return ok();
    if (block >= d.endBlock) {
      closeByHp(rt);
      return ok();
    }
    if (block < d.startBlock) return ok();

    const own =
      side === 1
        ? { atk: d.atk1, mult: d.mult1, hp: d.hp1, maxHp: d.maxHp1, skill: d.skill1, last: d.lastBlock1 }
        : { atk: d.atk2, mult: d.mult2, hp: d.hp2, maxHp: d.maxHp2, skill: d.skill2, last: d.lastBlock2 };
    const allowed = allowedTaps(taps, block - own.last);
    const skillFires = !own.skill && useSkill;
    const damage =
      tapDamage(allowed, own.atk, own.mult) +
      (skillFires ? skillDamage(own.atk, own.mult, own.hp, own.maxHp) : 0);

    if (side === 1) {
      d.lastBlock1 = block;
      d.skill1 = d.skill1 || skillFires;
      d.hp2 = Math.max(0, d.hp2 - damage);
      if (d.hp2 === 0) finish(rt, 'P1Won');
    } else {
      d.lastBlock2 = block;
      d.skill2 = d.skill2 || skillFires;
      d.hp1 = Math.max(0, d.hp1 - damage);
      if (d.hp1 === 0) finish(rt, 'P2Won');
    }
    return ok();
  }

  /** The mock poller settles automatically; a manual settle is a no-op on known duels. */
  function settleCall(_sender: Hex, id: Id): Outcome {
    return runtime(id) ? ok() : reverted();
  }

  // ---- contract: StakeVault ----

  const stakeOf = (id: Id): StakeView => {
    const s = stakes.get(String(id));
    return s ? { amount: s.amount, p1Staked: s.p1Staked, p2Staked: s.p2Staked, claimed: s.claimed } : emptyStake();
  };

  function stake(sender: Hex, id: Id, value: bigint): Outcome {
    const rt = runtime(id);
    if (!rt) return reverted();
    const d = rt.view;
    const isP1 = sameAddress(sender, d.p1);
    if (!isP1 && !sameAddress(sender, d.p2)) return reverted();
    const counting = d.status === 'Active' && block < d.startBlock;
    const s = stakes.get(d.id) ?? { ...emptyStake(), openedBlock: block };
    if (s.claimed || !(d.status === 'Open' || counting)) return reverted();
    if (isP1 ? s.p1Staked : s.p2Staked) return reverted();
    if (value < MIN_STAKE || value > MAX_STAKE) return reverted();
    if ((s.p1Staked || s.p2Staked) && value !== s.amount) return reverted();
    const wallet = walletOf(sender);
    const bot = botKeys.has(keyOf(sender));
    if (!bot && wallet.balance < value) return reverted();
    if (!bot) wallet.balance -= value;

    const next: StakeRecord = s.p1Staked || s.p2Staked ? s : { ...s, amount: value, openedBlock: block };
    stakes.set(d.id, { ...next, p1Staked: next.p1Staked || isP1, p2Staked: next.p2Staked || !isP1 });
    return ok();
  }

  function pay(to: Hex, wei: bigint): void {
    walletOf(to).balance += wei;
  }

  function claim(_sender: Hex, id: Id): Outcome {
    const rt = runtime(id);
    if (!rt) return reverted();
    const d = rt.view;
    const s = stakes.get(d.id);
    if (!s || s.claimed || (!s.p1Staked && !s.p2Staked)) return ok();
    if (d.settled) {
      const decisive = d.status === 'P1Won' || d.status === 'P2Won';
      if (s.p1Staked && s.p2Staked && decisive) {
        const pot = 2n * s.amount;
        pay(d.status === 'P1Won' ? d.p1 : d.p2, pot - (pot * RAKE_BPS) / BPS);
      } else {
        if (s.p1Staked) pay(d.p1, s.amount);
        if (s.p2Staked) pay(d.p2, s.amount);
      }
    } else if (d.status === 'Open' && block >= s.openedBlock + OPEN_REFUND_BLOCKS) {
      pay(d.p1, s.amount);
    } else {
      return reverted();
    }
    stakes.set(d.id, { ...s, claimed: true });
    return ok();
  }

  // ---- settlement and the AI Agent's learning ----

  function recordResult(d: DuelView): void {
    const winner = d.status === 'P1Won' ? d.card1 : d.status === 'P2Won' ? d.card2 : 0;
    const loser = d.status === 'P1Won' ? d.card2 : d.status === 'P2Won' ? d.card1 : 0;
    const w = cards.get(winner);
    const l = cards.get(loser);
    if (w) w.wins += 1;
    if (l) l.losses += 1;
  }

  function learnFrom(rt: DuelRuntime): void {
    const d = rt.view;
    const agentSide = sameAddress(d.p2, CONFIG.agent) ? 2 : 1;
    const won = d.status === (agentSide === 2 ? 'P2Won' : 'P1Won');
    const lost = d.status === (agentSide === 2 ? 'P1Won' : 'P2Won');
    testnet.duels += 1;
    if (won) testnet.wins += 1;

    const from = agentThreshold;
    const to = lost
      ? Math.min(AGENT_THRESHOLD_MAX, from + AGENT_THRESHOLD_STEP)
      : Math.max(AGENT_THRESHOLD_MIN, from - AGENT_THRESHOLD_STEP);
    agentThreshold = to;
    agentLevel = Math.min(6, 1 + Math.floor((sim.wins + testnet.wins) / 10));
    const lesson: AgentLesson = {
      at: now(),
      duelId: d.id,
      text: lost ? AGENT_LESSON_TEXT.loss : AGENT_LESSON_TEXT.win,
      thresholdFrom: from,
      thresholdTo: to,
    };
    lessons = [lesson, ...lessons].slice(0, MAX_LESSONS);
    agentSubs.forEach((fn) => fn());
  }

  function settleSweep(): void {
    for (const rt of duelList) {
      const d = rt.view;
      if (!isFinished(d) || d.settled || rt.finishedBlock === null) continue;
      if (block < rt.finishedBlock + SETTLE_DELAY_BLOCKS) continue;
      d.settled = true;
      recordResult(d);
      if (rt.controller === 'agent') learnFrom(rt);
    }
  }

  // ---- bots ----

  const agentBusy = (): boolean =>
    agentPendingDuel !== null ||
    duelList.some((rt) => rt.controller === 'agent' && rt.view.status === 'Active');

  function joinAgent(duelId: string): void {
    agentPendingDuel = null;
    const rt = runtime(duelId);
    if (!rt || rt.view.status !== 'Open') return;
    const card = botCard(CONFIG.agent, AGENT_CARD);
    if (joinDuel(CONFIG.agent, duelId, card.id).status === 'success') {
      rt.controller = 'agent';
      countTx();
    }
  }

  function actorsOf(rt: DuelRuntime): Hex[] {
    if (rt.controller === 'agent') return rt.guest ? [CONFIG.agent, rt.guest] : [CONFIG.agent];
    if (rt.controller === 'friend') return [friendAddress];
    return [rt.view.p1, rt.view.p2];
  }

  /** Deterministic stand-in for the relay latency so the showcase fills the latency stat. */
  const syntheticLatency = (): number =>
    RELAY_LATENCY_MIN_MS + ((txTotal * SHOWCASE_LATENCY_STEP) % RELAY_LATENCY_SPAN_MS);

  function botTurn(rt: DuelRuntime): void {
    const d = rt.view;
    if (!rt.controller || d.status !== 'Active') return;
    if (block < Math.max(d.startBlock, rt.nextActionBlock)) return;
    if (block >= d.endBlock - NO_SEND_MARGIN) return;
    rt.nextActionBlock = block + BOT_INTERVAL_BLOCKS;

    for (const sender of actorsOf(rt)) {
      if (isFinished(d)) break;
      const isAgent = sameAddress(sender, CONFIG.agent);
      const taps = isAgent
        ? AGENT_BASE_TAPS + rollInt(2)
        : Math.round((FRIEND_MIN_RATE + rollInt(FRIEND_RATE_SPAN)) * TAPS_PER_SECOND_BLOCKS);
      const hp = sameAddress(sender, d.p1) ? d.hp1 : d.hp2;
      const maxHp = sameAddress(sender, d.p1) ? d.maxHp1 : d.maxHp2;
      const threshold = isAgent ? agentThreshold : FRIEND_SKILL_THRESHOLD;
      attack(sender, d.id, taps, hp * 100 <= threshold * maxHp);
      countTx(rt.showcase ? syntheticLatency() : undefined);
    }
  }

  // ---- projector showcase ----

  function buildLanes(): ShowcaseLane[] {
    const agentLane: ShowcaseLane = {
      p1: SHOWCASE_GUEST,
      p2: CONFIG.agent,
      stats: [SHOWCASE_GUEST_CARD, AGENT_CARD],
      controller: 'agent',
      guest: SHOWCASE_GUEST,
      duelId: null,
      startAt: block,
    };
    const botLanes = SHOWCASE_BOT_PAIRS.map(([a, b], i): ShowcaseLane => ({
      p1: CONFIG.bots[a] as Hex,
      p2: CONFIG.bots[b] as Hex,
      stats: [SHOWCASE_BOT_CARDS[a - 1] as CardStats, SHOWCASE_BOT_CARDS[b - 1] as CardStats],
      controller: 'showcase',
      guest: null,
      duelId: null,
      startAt: block + (i + 1) * SHOWCASE_LANE_STAGGER_BLOCKS,
    }));
    return [agentLane, ...botLanes];
  }

  function launchLane(lane: ShowcaseLane): void {
    const first = botCard(lane.p1, lane.stats[0]);
    const second = botCard(lane.p2, lane.stats[1]);
    const created = createDuel(lane.p1, first.id);
    const duelId = created.events.duelId;
    if (duelId === undefined) return;
    countTx();
    if (joinDuel(lane.p2, duelId, second.id).status !== 'success') return;
    countTx();
    const rt = runtime(duelId);
    if (!rt) return;
    rt.controller = lane.controller;
    rt.showcase = true;
    rt.guest = lane.guest;
    lane.duelId = duelId;
  }

  function showcaseSweep(): void {
    if (showcaseRefs === 0) return;
    for (const lane of lanes) {
      if (lane.duelId !== null) {
        if (!runtime(lane.duelId)?.view.settled) continue;
        lane.duelId = null;
        lane.startAt = block + SHOWCASE_PAUSE_BLOCKS;
      }
      if (block < lane.startAt) continue;
      if (lane.controller === 'agent' && agentBusy()) continue; // a real challenge has the agent
      launchLane(lane);
    }
  }

  function startShowcase(): () => void {
    showcaseRefs += 1;
    if (lanes.length === 0) lanes = buildLanes();
    showcaseSweep();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      showcaseRefs -= 1;
    };
  }

  // ---- clock ----

  function tick(): void {
    block += 1;
    for (const rt of duelList) {
      if (rt.view.status === 'Active' && block >= rt.view.endBlock) closeByHp(rt);
    }
    duelList.forEach(botTurn);
    settleSweep();
    showcaseSweep();
    blockSubs.forEach((fn) => fn(block));
  }

  if (blockMs > 0) interval = setInterval(tick, blockMs);

  // ---- relay ----

  async function validate(rawTx: Hex): Promise<{
    sender: Hex;
    wallet: Wallet;
    run: () => Outcome;
  }> {
    let tx: ReturnType<typeof parseTransaction>;
    let sender: Hex;
    try {
      tx = parseTransaction(rawTx as TransactionSerialized);
      sender = await recoverTransactionAddress({ serializedTransaction: rawTx as TransactionSerialized });
    } catch {
      throw new ApiError(400, 'bad_tx');
    }
    if (tx.chainId !== CHAIN_ID) throw new ApiError(400, 'chain');

    const to = tx.to ? keyOf(tx.to) : '';
    const abi =
      to === keyOf(CONFIG.contracts.cards)
        ? nadCardsAbi
        : to === keyOf(CONFIG.contracts.arena)
          ? blitzArenaAbi
          : to === keyOf(CONFIG.contracts.stakeVault as Hex)
            ? stakeVaultAbi
            : null;
    if (!abi) throw new ApiError(400, 'to');

    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi, data: tx.data ?? '0x' });
    } catch {
      throw new ApiError(400, 'selector');
    }
    const value = tx.value ?? 0n;
    if (value !== 0n && decoded.functionName !== 'paidPull' && decoded.functionName !== 'stake') throw new ApiError(400, 'value');

    const wallet = walletOf(sender);
    const nonce = tx.nonce ?? 0;
    if (nonce < wallet.nonce) throw new ApiError(400, 'nonce too low');
    if (nonce > wallet.nonce) throw new ApiError(400, 'nonce too high');
    if (value > wallet.balance) throw new ApiError(400, 'balance');

    const args = decoded.args ?? [];
    const runners: Record<string, () => Outcome> = {
      freePull: () => freePull(sender),
      paidPull: () => paidPull(sender, value),
      createDuel: () => createDuel(sender, args[0] as bigint),
      joinDuel: () => joinDuel(sender, args[0] as bigint, args[1] as bigint),
      attack: () => attack(sender, args[0] as bigint, Number(args[1]), Boolean(args[2])),
      settle: () => settleCall(sender, args[0] as bigint),
      stake: () => stake(sender, args[0] as bigint, value),
      claim: () => claim(sender, args[0] as bigint),
    };
    const run = runners[decoded.functionName];
    if (!run) throw new ApiError(400, 'selector');
    return { sender, wallet, run };
  }

  async function relay(rawTx: Hex): Promise<RelayResult> {
    const known = relayed.get(rawTx);
    if (known) return known;
    const checked = await validate(rawTx);
    // A concurrent identical resend that validated at the same time shares the first result.
    const raced = relayed.get(rawTx);
    if (raced) return raced;

    checked.wallet.nonce += 1;
    const latencyMs = RELAY_LATENCY_MIN_MS + rollInt(RELAY_LATENCY_SPAN_MS);
    const result = new Promise<RelayResult>((resolve) => {
      later(() => {
        const outcome = checked.run();
        const hash = keccak256(rawTx);
        countTx(latencyMs, hash);
        resolve({
          hash,
          status: outcome.status,
          latencyMs,
          blockNumber: String(block),
          events: outcome.events,
        });
      }, latencyMs);
    });
    relayed.set(rawTx, result);
    return result;
  }

  // ---- server-like endpoints ----

  function fund(address: Hex): FundResult {
    const wallet = walletOf(address);
    if (wallet.balance >= FUND_MIN_BALANCE) return { funded: false, reason: 'balance_ok' };
    if (wallet.fundCount >= FUND_MAX_PER_ADDRESS) return { funded: false, reason: 'limit_address' };
    wallet.fundCount += 1;
    wallet.balance += FUND_AMOUNT;
    return {
      funded: true,
      txHash: keccak256(stringToHex(`fund:${keyOf(address)}:${wallet.fundCount}`)),
    };
  }

  function getAccount(address: Hex): Account {
    const wallet = wallets.get(keyOf(address));
    const cardId = cardOfMap.get(keyOf(address));
    return {
      nonce: wallet?.nonce ?? 0,
      balance: (wallet?.balance ?? 0n).toString(),
      cardId: cardId === undefined ? null : String(cardId),
      hasPulled: cardId !== undefined,
    };
  }

  function getCard(id: string): CardMeta | null {
    const card = /^\d+$/.test(id) ? cards.get(Number(id)) : undefined;
    if (!card) return null;
    const age = now() - card.mintedAtMs;
    if (age < FORGE_BARE_MS) return { status: 'forging' };
    const nadmon = nadmonFor(card.element, card.rarity);
    const ready = age >= FORGE_MS;
    const text = ready
      ? cardText(nadmon.name, card.element, card.rarity, card.mintedAt)
      : { title: nadmon.name, lore: '' };
    return {
      name: `${nadmon.name} #${card.id}`,
      description: text.lore,
      image: '/mock/card.svg',
      attributes: [],
      nadgacha: {
        id: card.id,
        atk: card.atk,
        hp: card.hp,
        element: card.element,
        rarity: card.rarity,
        wins: card.wins,
        losses: card.losses,
        mintedAt: card.mintedAt,
        nadmon: { id: nadmon.id, name: nadmon.name, stage: nadmon.stage },
        title: text.title,
        lore: text.lore,
        status: ready ? 'ready' : 'forging',
      },
    };
  }

  function challengeAgent(duelId: string): AgentChallengeResult {
    const rt = /^\d+$/.test(duelId) ? runtime(duelId) : null;
    if (!rt || rt.view.status !== 'Open') return { ok: false, reason: 'not_open' };
    if (agentBusy()) return { ok: false, reason: 'busy' };
    agentPendingDuel = duelId;
    later(() => joinAgent(duelId), AGENT_JOIN_DELAY_MS);
    return { ok: true };
  }

  // ---- WebSocket payloads ----

  const snapshot = (rt: DuelRuntime): DuelView => ({ ...rt.view });

  function duelsMsg(scope: string): DuelsMsg {
    const wanted = scope.startsWith('duel:') ? runtime(scope.slice('duel:'.length)) : null;
    const picked = scope.startsWith('duel:')
      ? wanted
        ? [wanted]
        : []
      : duelList.slice(-SNAPSHOT_DUELS);
    const active = [...picked]
      .reverse()
      .find((rt) => rt.view.status === 'Active' && !isBotOnly(rt.view));
    return {
      type: 'duels',
      block: String(block),
      duels: picked.map(snapshot),
      featuredId: active ? active.view.id : null,
    };
  }

  function statsMsg(): StatsMsg {
    const cutoff = now() - STATS_WINDOW_MS;
    while (txTimes.length > 0 && (txTimes[0] ?? 0) < cutoff) txTimes.shift();
    const avg =
      latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length;
    return {
      type: 'stats',
      block: String(block),
      txTotal,
      txPerSec: Math.round((txTimes.length / (STATS_WINDOW_MS / 1000)) * 10) / 10,
      avgLatencyMs: Math.round(avg),
      uniquePlayers: 0,
      totalDuels: 0,
      treasury: treasury.toString(),
      ...(lastTxHash === null ? {} : { lastTxHash }),
    };
  }

  function agentMsg(): AgentMsg {
    return {
      type: 'agent',
      level: agentLevel,
      threshold: agentThreshold,
      finisher: false,
      sim: { ...sim },
      testnet: { ...testnet },
      lessons: lessons.map((l) => ({ ...l })),
    };
  }

  return {
    config: CONFIG,
    block: () => block,
    tick,
    subscribe(fn) {
      blockSubs.add(fn);
      return () => void blockSubs.delete(fn);
    },
    subscribeAgent(fn) {
      agentSubs.add(fn);
      return () => void agentSubs.delete(fn);
    },
    dispose() {
      if (interval !== null) clearInterval(interval);
      interval = null;
      timers.forEach(clearTimeout);
      timers.clear();
      blockSubs.clear();
      agentSubs.clear();
      lanes = [];
      showcaseRefs = 0;
    },
    startShowcase,
    disableAutoFriend() {
      autoFriend = false;
    },
    credit(address, wei) {
      const wallet = walletOf(address);
      wallet.balance += wei;
    },
    setBalance(address, wei) {
      walletOf(address).balance = wei;
    },
    balanceOf: (address) => wallets.get(keyOf(address))?.balance ?? 0n,
    freePull,
    paidPull,
    createDuel,
    joinDuel,
    attack,
    settle: settleCall,
    stake,
    claim,
    cardOf: (address) => cardOfMap.get(keyOf(address)) ?? 0,
    card: (id) => {
      const c = cards.get(Number(id));
      return c ? { ...c } : null;
    },
    duel: (id) => {
      const rt = runtime(id);
      return rt ? snapshot(rt) : null;
    },
    duels: () => duelList.map(snapshot),
    getAccount,
    fund,
    relay,
    getCard,
    challengeAgent,
    getStake: (duelId) => stakeOf(duelId),
    duelsMsg,
    statsMsg,
    agentMsg,
  };
}

let instance: MockChain | null = null;

/** Lazily created singleton: the block timer starts on first use. */
export function getMockChain(): MockChain {
  instance ??= createMockChain();
  return instance;
}
