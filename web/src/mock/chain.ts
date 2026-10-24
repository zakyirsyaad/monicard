import {
  decodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
} from 'viem';
import type { Hex, TransactionSerialized } from 'viem';
import { blitzArenaAbi, nadCardsAbi } from '../lib/abi';
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
const FORGE_MS = 2000;
const STATS_WINDOW_MS = 5000;
const LATENCY_SAMPLES = 50;
const SETTLE_DELAY_BLOCKS = 2;
const NO_SEND_MARGIN = 2;
const BOT_INTERVAL_BLOCKS = 3;
const SNAPSHOT_DUELS = 64;
const MAX_LESSONS = 20;

const AGENT_START_THRESHOLD = 30;
const AGENT_THRESHOLD_STEP = 10;
const AGENT_THRESHOLD_MIN = 20;
const AGENT_THRESHOLD_MAX = 60;
const AGENT_BASE_TAPS = 7;
const FRIEND_SKILL_THRESHOLD = 40;
const FRIEND_MIN_RATE = 5;
const FRIEND_RATE_SPAN = 5; // 5..9 taps per second
const TAPS_PER_SECOND_BLOCKS = 0.9; // seconds covered by one bot interval (3 blocks)

const CONFIG: Config = {
  chainId: CHAIN_ID,
  contracts: {
    cards: '0x00000000000000000000000000000000000000c1',
    arena: '0x00000000000000000000000000000000000000a1',
  },
  gasLimits: {
    freePull: 400000,
    paidPull: 400000,
    createDuel: 300000,
    joinDuel: 300000,
    attack: 120000,
    settle: 200000,
  },
  gasPrice: '100000000000',
  batchMs: 1000,
  pullPrice: PULL_PRICE.toString(),
  event: { name: 'NadGacha BlitzArena', sponsor: 'Monad Blitz Jogja' },
  agent: '0x00000000000000000000000000000000000000a9',
  bots: ['0x00000000000000000000000000000000000000b1'],
};

const AGENT_CARD = { element: 1, rarity: 1, atk: 13, hp: 1750 } as const; // Water Rare
const FRIEND_CARD = { element: 2, rarity: 1, atk: 12, hp: 1700 } as const; // Lightning Rare

type Outcome = { status: 'success' | 'reverted'; events: RelayResult['events'] };
type Id = number | bigint | string;
type Controller = 'agent' | 'friend';

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

type DuelRuntime = {
  view: DuelView;
  finishedBlock: number | null;
  controller: Controller | null;
  nextActionBlock: number;
};

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

  /** WebSocket payloads. `scope` is `all` or `duel:<id>`. */
  duelsMsg(scope: string): DuelsMsg;
  statsMsg(): StatsMsg;
  agentMsg(): AgentMsg;
};

const keyOf = (a: Hex): string => a.toLowerCase();
const sameAddress = (a: Hex, b: Hex): boolean => keyOf(a) === keyOf(b);
const isFinished = (d: DuelView): boolean =>
  d.status === 'P1Won' || d.status === 'P2Won' || d.status === 'Draw';
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
  const txTimes: number[] = [];
  const latencies: number[] = [];

  const wallets = new Map<string, Wallet>();
  const cards = new Map<number, CardRecord>();
  const cardOfMap = new Map<string, number>();
  const duelList: DuelRuntime[] = [];
  const relayed = new Map<Hex, Promise<RelayResult>>();
  const blockSubs = new Set<(block: number) => void>();
  const agentSubs = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let interval: ReturnType<typeof setInterval> | null = null;

  const botKeys = new Set([keyOf(CONFIG.agent), ...CONFIG.bots.map(keyOf)]);
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

  function mint(owner: Hex, stats?: { element: number; rarity: number; atk: number; hp: number }) {
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
  function botCard(address: Hex, stats: typeof AGENT_CARD | typeof FRIEND_CARD): CardRecord {
    const existing = cardOfMap.get(keyOf(address));
    const found = existing === undefined ? undefined : cards.get(existing);
    return found ?? mint(address, stats);
  }

  const runtime = (id: Id): DuelRuntime | null => duelList[Number(id)] ?? null;

  function countTx(latencyMs?: number): void {
    txTotal += 1;
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

  function botTurn(rt: DuelRuntime): void {
    const d = rt.view;
    if (!rt.controller || d.status !== 'Active') return;
    if (block < Math.max(d.startBlock, rt.nextActionBlock)) return;
    if (block >= d.endBlock - NO_SEND_MARGIN) return;
    rt.nextActionBlock = block + BOT_INTERVAL_BLOCKS;

    const sender = rt.controller === 'agent' ? CONFIG.agent : friendAddress;
    const taps =
      rt.controller === 'agent'
        ? AGENT_BASE_TAPS + rollInt(2)
        : Math.round((FRIEND_MIN_RATE + rollInt(FRIEND_RATE_SPAN)) * TAPS_PER_SECOND_BLOCKS);
    const hp = sameAddress(sender, d.p1) ? d.hp1 : d.hp2;
    const maxHp = sameAddress(sender, d.p1) ? d.maxHp1 : d.maxHp2;
    const threshold = rt.controller === 'agent' ? agentThreshold : FRIEND_SKILL_THRESHOLD;
    attack(sender, d.id, taps, hp * 100 <= threshold * maxHp);
    countTx();
  }

  // ---- clock ----

  function tick(): void {
    block += 1;
    for (const rt of duelList) {
      if (rt.view.status === 'Active' && block >= rt.view.endBlock) closeByHp(rt);
    }
    duelList.forEach(botTurn);
    settleSweep();
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
    const abi = to === keyOf(CONFIG.contracts.cards) ? nadCardsAbi : to === keyOf(CONFIG.contracts.arena) ? blitzArenaAbi : null;
    if (!abi) throw new ApiError(400, 'to');

    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi, data: tx.data ?? '0x' });
    } catch {
      throw new ApiError(400, 'selector');
    }
    const value = tx.value ?? 0n;
    if (value !== 0n && decoded.functionName !== 'paidPull') throw new ApiError(400, 'value');

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
        countTx(latencyMs);
        resolve({
          hash: keccak256(rawTx),
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
    const nadmon = nadmonFor(card.element, card.rarity);
    const ready = now() - card.mintedAtMs >= FORGE_MS;
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
    const active = [...picked].reverse().find((rt) => rt.view.status === 'Active');
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
    },
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

/** Lazy handle to the singleton, safe to import from modules in an import cycle. */
export const mockChain: MockChain = new Proxy({} as MockChain, {
  get: (_target, prop) => Reflect.get(getMockChain(), prop),
});
