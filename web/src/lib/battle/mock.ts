import {
  EMPTY_SLOT,
  MAX_DRAWS,
  NO_PLACE,
  TURN_TIMEOUT_BLOCKS,
  boardDamage,
  boardSize,
  emptyBoardSlot,
  frontCard,
  handCards,
  isExhausted,
  otherSide,
  sameAddress,
  sideData,
  strikeDamage,
} from './rules';
import type { StakeView } from '../types';
import type { BattleSide, MatchView } from './types';

/**
 * In-browser CardBattle simulator for `VITE_USE_MOCK=1` and for tests.
 * Mirrors CardBattle v4: ten random draws per player, a three-slot board, one action
 * per turn, Special once per match, two KOs to win, and the next player's draw at
 * the end of an action so the card is already in hand when their turn starts.
 */

export const MOCK_BLOCK_MS = 300;
const DEFAULT_BLOCK_BASE = 73_910_000;
const AGENT_MOVE_MS = 1400;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const MOCK_AGENT_ADDRESS = '0x00000000000000000000000000000000000000a1';

type Random = () => number;

export type ActReason =
  | 'not_found'
  | 'not_active'
  | 'not_your_turn'
  | 'special_used'
  | 'card_not_in_hand'
  | 'board_full';

export type ActResult = { ok: true } | { ok: false; reason: ActReason };

export type ClaimResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_active' | 'not_your_turn' | 'too_early' };

export type StakeReason = 'not_found' | 'not_participant' | 'closed' | 'already_staked' | 'bad_amount' | 'mismatch' | 'funds';
export type StakeResult = { ok: true } | { ok: false; reason: StakeReason };

const MIN_STAKE = 1_000_000_000_000_000n;
const MAX_STAKE = 1_000_000_000_000_000_000n;
const RAKE_BPS = 500n;
/** Mock burners start with this much, so staking works without a server. */
const MOCK_START_BALANCE = 5_000_000_000_000_000_000n;

export type SimOptions = {
  now?: () => number;
  random?: Random;
  blockBase?: number;
  /** False in tests: the agent then only moves when `act` is called explicitly. */
  autoAgent?: boolean;
};

type DeckFields = {
  el: number[];
  rar: number[];
  atk: number[];
  maxHp: number[];
};

/** Rarity roll 0-99 and the stat ranges from BATTLE-SPEC v3. */
export function rollCard(random: Random): { element: number; rarity: number; atk: number; maxHp: number } {
  const roll = Math.floor(random() * 100);
  const rarity = roll < 60 ? 0 : roll < 88 ? 1 : roll < 98 ? 2 : 3;
  const atk = 10 + Math.floor(random() * 5) + rarity;
  const maxHp = 1500 + Math.floor(random() * 301) + 100 * rarity;
  const element = Math.floor(random() * 3);
  return { element, rarity, atk, maxHp };
}

export function generateDeck(random: Random): DeckFields {
  const cards = Array.from({ length: MAX_DRAWS }, () => rollCard(random));
  return {
    el: cards.map((c) => c.element),
    rar: cards.map((c) => c.rarity),
    atk: cards.map((c) => c.atk),
    maxHp: cards.map((c) => c.maxHp),
  };
}

const emptyArray = (length: number, value: number): number[] => Array.from({ length }, () => value);

type Listener = () => void;

export type BattleSim = ReturnType<typeof createBattleSim>;

export function createBattleSim(options: SimOptions = {}) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const autoAgent = options.autoAgent ?? true;
  const startedAt = now();
  const blockBase = options.blockBase ?? DEFAULT_BLOCK_BASE;

  const matches = new Map<string, MatchView>();
  const agentMatches = new Set<string>();
  const listeners = new Set<Listener>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stakes = new Map<string, StakeView>();
  const balances = new Map<string, bigint>();
  let nextId = 1;

  const block = (): number => blockBase + Math.floor((now() - startedAt) / MOCK_BLOCK_MS);

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
  }

  type SidePatch = {
    drawn?: number;
    placed?: number;
    special?: boolean;
    score?: number;
    hp?: number[];
    board?: number[];
  };

  function patchSide(match: MatchView, side: BattleSide, patch: SidePatch): MatchView {
    if (side === 1) {
      return {
        ...match,
        drawn1: patch.drawn ?? match.drawn1,
        placed1: patch.placed ?? match.placed1,
        special1: patch.special ?? match.special1,
        score1: patch.score ?? match.score1,
        hp1: patch.hp ?? match.hp1,
        board1: patch.board ?? match.board1,
      };
    }
    return {
      ...match,
      drawn2: patch.drawn ?? match.drawn2,
      placed2: patch.placed ?? match.placed2,
      special2: patch.special ?? match.special2,
      score2: patch.score ?? match.score2,
      hp2: patch.hp ?? match.hp2,
      board2: patch.board ?? match.board2,
    };
  }

  function sideArrays(match: MatchView, side: BattleSide): DeckFields & { hp: number[] } {
    return side === 1
      ? { el: match.el1, rar: match.rar1, atk: match.atk1, maxHp: match.maxHp1, hp: match.hp1 }
      : { el: match.el2, rar: match.rar2, atk: match.atk2, maxHp: match.maxHp2, hp: match.hp2 };
  }

  function installDeck(match: MatchView, side: BattleSide, deck: DeckFields): MatchView {
    if (side === 1) {
      return {
        ...match,
        el1: deck.el,
        rar1: deck.rar,
        atk1: deck.atk,
        maxHp1: deck.maxHp,
        hp1: [...deck.maxHp],
        drawn1: 1,
        board1: emptyArray(3, EMPTY_SLOT),
      };
    }
    return {
      ...match,
      el2: deck.el,
      rar2: deck.rar,
      atk2: deck.atk,
      maxHp2: deck.maxHp,
      hp2: [...deck.maxHp],
      drawn2: 1,
      board2: emptyArray(3, EMPTY_SLOT),
    };
  }

  function createMatch(address: string): string {
    const id = String(nextId++);
    const open: MatchView = {
      id,
      p1: address,
      p2: ZERO_ADDRESS,
      status: 'Open',
      turn: 0,
      score1: 0,
      score2: 0,
      lastMoveBlock: block(),
      special1: false,
      special2: false,
      drawn1: 0,
      drawn2: 0,
      placed1: 0,
      placed2: 0,
      el1: emptyArray(MAX_DRAWS, 0),
      el2: emptyArray(MAX_DRAWS, 0),
      rar1: emptyArray(MAX_DRAWS, 0),
      rar2: emptyArray(MAX_DRAWS, 0),
      atk1: emptyArray(MAX_DRAWS, 0),
      atk2: emptyArray(MAX_DRAWS, 0),
      maxHp1: emptyArray(MAX_DRAWS, 0),
      maxHp2: emptyArray(MAX_DRAWS, 0),
      hp1: emptyArray(MAX_DRAWS, 0),
      hp2: emptyArray(MAX_DRAWS, 0),
      board1: emptyArray(3, EMPTY_SLOT),
      board2: emptyArray(3, EMPTY_SLOT),
    };
    matches.set(id, installDeck(open, 1, generateDeck(random)));
    emit();
    return id;
  }

  function joinMatch(id: string, address: string): boolean {
    const match = matches.get(id);
    if (!match || match.status !== 'Open' || sameAddress(match.p1, address)) return false;
    const joined: MatchView = {
      ...installDeck({ ...match, p2: address }, 2, generateDeck(random)),
      status: 'Active',
      turn: random() < 0.5 ? 1 : 2,
      lastMoveBlock: block(),
    };
    matches.set(id, joined);
    emit();
    return true;
  }

  function joinAgent(id: string): boolean {
    if (!joinMatch(id, MOCK_AGENT_ADDRESS)) return false;
    agentMatches.add(id);
    scheduleAgent(id);
    return true;
  }

  function win(match: MatchView, side: BattleSide): MatchView {
    clearTimer(match.id);
    return { ...match, turn: 0, status: side === 1 ? 'P1Won' : 'P2Won' };
  }

  function act(id: string, address: string, handIdx: number, special: boolean): ActResult {
    const match = matches.get(id);
    if (!match) return { ok: false, reason: 'not_found' };
    if (match.status !== 'Active') return { ok: false, reason: 'not_active' };
    const side: BattleSide | null = sameAddress(match.p1, address) ? 1 : sameAddress(match.p2, address) ? 2 : null;
    if (side === null || match.turn !== side) return { ok: false, reason: 'not_your_turn' };
    const used = side === 1 ? match.special1 : match.special2;
    if (special && used) return { ok: false, reason: 'special_used' };

    let next = match;

    if (handIdx !== NO_PLACE) {
      const hand = handCards(sideData(next, side)).map((card) => card.drawNo);
      if (!hand.includes(handIdx)) return { ok: false, reason: 'card_not_in_hand' };
      const slot = emptyBoardSlot(sideData(next, side));
      if (slot === -1) return { ok: false, reason: 'board_full' };
      const board = [...(side === 1 ? next.board1 : next.board2)];
      board[slot] = handIdx;
      const placed = (side === 1 ? next.placed1 : next.placed2) | (1 << handIdx);
      next = patchSide(next, side, { board, placed });
    }

    const defender = otherSide(side);
    const target = frontCard(sideData(next, defender));
    let ko = false;
    if (target !== null && boardSize(sideData(next, side)) > 0) {
      const attacker = sideData(next, side);
      const base = boardDamage(attacker, target.element);
      const damage = special ? base * 2 : base;
      const defenderData = sideData(next, defender);
      const frontIndex = defenderData.board.findIndex((n) => n !== EMPTY_SLOT);
      const hp = [...defenderData.hp];
      hp[target.drawNo] = Math.max(0, (hp[target.drawNo] ?? 0) - damage);
      if (hp[target.drawNo] === 0) {
        const board = [...defenderData.board];
        board[frontIndex] = EMPTY_SLOT;
        const score = (side === 1 ? next.score1 : next.score2) + 1;
        next = patchSide(next, defender, { hp, board });
        next = patchSide(next, side, { score });
        ko = true;
        if (score >= 2) {
          next = win(next, side);
          matches.set(id, next);
          emit();
          return { ok: true };
        }
      } else {
        next = patchSide(next, defender, { hp });
      }
    }
    if (special && target !== null && boardSize(sideData(next, side)) > 0) {
      next = patchSide(next, side, { special: true });
    }

    // The opponent is out of everything: no board card, no hand, no pile.
    if (ko && isExhausted(sideData(next, defender))) {
      next = win(next, side);
      matches.set(id, next);
      emit();
      return { ok: true };
    }

    // CardBattle draws for the next player before the turn passes (BATTLE-SPEC v4):
    // the new card is already in hand when that player starts.
    const nextDrawn = defender === 1 ? next.drawn1 : next.drawn2;
    if (nextDrawn < MAX_DRAWS) next = patchSide(next, defender, { drawn: nextDrawn + 1 });
    next = { ...next, turn: defender, lastMoveBlock: block() };

    matches.set(id, next);
    emit();
    scheduleAgent(id);
    return { ok: true };
  }

  function claimTimeout(id: string, address: string): ClaimResult {
    const match = matches.get(id);
    if (!match) return { ok: false, reason: 'not_found' };
    if (match.status !== 'Active') return { ok: false, reason: 'not_active' };
    const side: BattleSide | null = sameAddress(match.p1, address) ? 1 : sameAddress(match.p2, address) ? 2 : null;
    if (side === null || match.turn === 0 || side === match.turn) return { ok: false, reason: 'not_your_turn' };
    if (block() < match.lastMoveBlock + TURN_TIMEOUT_BLOCKS) return { ok: false, reason: 'too_early' };
    matches.set(id, win(match, side));
    emit();
    return { ok: true };
  }

  const key = (address: string): string => address.toLowerCase();
  const balanceOf = (address: string): bigint => balances.get(key(address)) ?? MOCK_START_BALANCE;

  /** Mirrors BattleStakeVault.stake: participants only, Open or before any move, once each, equal amounts. */
  function stake(id: string, address: string, amount: bigint): StakeResult {
    const match = matches.get(id);
    if (!match) return { ok: false, reason: 'not_found' };
    const isP1 = sameAddress(match.p1, address);
    if (!isP1 && !sameAddress(match.p2, address)) return { ok: false, reason: 'not_participant' };
    const current = stakes.get(id) ?? { amount: 0n, p1Staked: false, p2Staked: false, claimed: false };
    const open = match.status === 'Open' || (match.status === 'Active' && match.drawn1 <= 1 && match.drawn2 <= 1);
    if (current.claimed || !open) return { ok: false, reason: 'closed' };
    if (isP1 ? current.p1Staked : current.p2Staked) return { ok: false, reason: 'already_staked' };
    if (amount < MIN_STAKE || amount > MAX_STAKE) return { ok: false, reason: 'bad_amount' };
    const someone = current.p1Staked || current.p2Staked;
    if (someone && amount !== current.amount) return { ok: false, reason: 'mismatch' };
    if (balanceOf(address) < amount) return { ok: false, reason: 'funds' };
    balances.set(key(address), balanceOf(address) - amount);
    stakes.set(id, {
      amount: someone ? current.amount : amount,
      p1Staked: current.p1Staked || isP1,
      p2Staked: current.p2Staked || !isP1,
      claimed: false,
    });
    emit();
    return { ok: true };
  }

  /** Mirrors BattleStakeVault.claim: a silent no-op unless the match is over. Returns whether state changed. */
  function claim(id: string): boolean {
    const match = matches.get(id);
    const current = stakes.get(id);
    if (!match || !current || current.claimed || (!current.p1Staked && !current.p2Staked)) return false;
    if (match.status !== 'P1Won' && match.status !== 'P2Won') return false;
    if (current.p1Staked && current.p2Staked) {
      const pot = 2n * current.amount;
      const winner = match.status === 'P1Won' ? match.p1 : match.p2;
      balances.set(key(winner), balanceOf(winner) + pot - (pot * RAKE_BPS) / 10_000n);
    } else {
      const staker = current.p1Staked ? match.p1 : match.p2;
      balances.set(key(staker), balanceOf(staker) + current.amount);
    }
    stakes.set(id, { ...current, claimed: true });
    emit();
    return true;
  }

  function agentMove(match: MatchView): { handIdx: number; special: boolean } {
    const self = sideData(match, 2);
    const foe = sideData(match, 1);
    const hand = handCards(self);
    const target = frontCard(foe);
    const slot = emptyBoardSlot(self);
    const chosen = hand.reduce<(typeof hand)[number] | null>(
      (best, card) => (best === null || card.atk > best.atk ? card : best),
      null,
    );
    const handIdx = slot !== -1 && chosen !== null ? chosen.drawNo : NO_PLACE;

    const boardAtk =
      boardDamage(self, target?.element ?? 0) +
      (handIdx !== NO_PLACE && chosen !== null && target !== null
        ? strikeDamage(chosen.atk, chosen.element, target.element)
        : 0);
    const ownFront = frontCard(self);
    const lowHp = ownFront !== null && ownFront.maxHp > 0 && ownFront.hp <= ownFront.maxHp * 0.35;
    const canFinish = target !== null && !self.specialUsed && boardAtk * 2 >= target.hp;
    const special = target !== null && !self.specialUsed && boardAtk > 0 && (canFinish || lowHp);
    return { handIdx, special };
  }

  function scheduleAgent(id: string): void {
    if (!autoAgent || !agentMatches.has(id)) return;
    clearTimer(id);
    const match = matches.get(id);
    if (!match || match.status !== 'Active' || match.turn !== 2) return;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        const current = matches.get(id);
        if (!current || current.status !== 'Active' || current.turn !== 2) return;
        const move = agentMove(current);
        act(id, MOCK_AGENT_ADDRESS, move.handIdx, move.special);
      }, AGENT_MOVE_MS),
    );
  }

  return {
    block,
    createMatch,
    joinMatch,
    joinAgent,
    act,
    claimTimeout,
    stake,
    claim,
    balanceOf,
    getStake: (id: string): StakeView | null => stakes.get(id) ?? null,
    getMatch: (id: string): MatchView | null => matches.get(id) ?? null,
    listMatches: (): MatchView[] => [...matches.values()].reverse(),
    isAgentMatch: (id: string): boolean => agentMatches.has(id),
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reset(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      matches.clear();
      agentMatches.clear();
      stakes.clear();
      balances.clear();
      nextId = 1;
      emit();
    },
  };
}

/** Module singleton: one simulated chain per tab, so navigating between routes keeps the match. */
export const battleMock = createBattleSim();

export { ZERO_ADDRESS, AGENT_MOVE_MS };
