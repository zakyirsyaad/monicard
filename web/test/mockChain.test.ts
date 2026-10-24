import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseEther } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { blitzArenaAbi, nadCardsAbi } from '../src/lib/abi';
import { ApiError } from '../src/lib/api';
import {
  COUNTDOWN_BLOCKS,
  DUEL_BLOCKS,
  allowedTaps,
  elementMult,
  skillDamage,
  tapDamage,
} from '../src/lib/game';
import { signCall } from '../src/lib/sign';
import { createMockChain } from '../src/mock/chain';
import type { MockChain } from '../src/mock/chain';

const ALICE = '0x00000000000000000000000000000000000a11ce' as const;
const BOB = '0x0000000000000000000000000000000000000b0b' as const;
const CAROL = '0x00000000000000000000000000000000000ca401' as const;
const START_BLOCK = 73_562_000;
const PRICE = parseEther('0.05');

type CardRoll = { roll?: number; atkBonus?: number; hpBonus?: number; element?: number };

let queue: number[] = [];
let chain: MockChain;

/** Draw order of a card roll: roll, atk bonus, hp bonus, element. */
function rollInputs({ roll = 50, atkBonus = 2, hpBonus = 150, element = 1 }: CardRoll): number[] {
  return [(roll + 0.5) / 100, (atkBonus + 0.5) / 5, (hpBonus + 0.5) / 301, (element + 0.5) / 3];
}

function pull(addr: Hex, roll: CardRoll = {}) {
  queue.push(...rollInputs(roll));
  const out = chain.freePull(addr);
  expect(out.status).toBe('success');
  return Number(out.events.tokenId);
}

function ticks(n: number) {
  for (let i = 0; i < n; i++) chain.tick();
}

/** Alice (p1) vs Bob (p2), both with fixed cards; returns duel id and card ids. */
function startDuel(e1 = 0, e2 = 2) {
  const c1 = pull(ALICE, { element: e1 });
  const c2 = pull(BOB, { element: e2 });
  const created = chain.createDuel(ALICE, c1);
  const duelId = created.events.duelId!;
  expect(chain.joinDuel(BOB, duelId, c2).status).toBe('success');
  return { duelId, c1, c2 };
}

beforeEach(() => {
  vi.useFakeTimers();
  queue = [];
  chain = createMockChain({ blockMs: 0, rng: () => queue.shift() ?? 0.5, now: () => Date.now() });
  chain.disableAutoFriend();
});

afterEach(() => {
  chain.dispose();
  vi.useRealTimers();
});

describe('blocks', () => {
  it('starts at the fixed block and tick() advances by one', () => {
    expect(chain.block()).toBe(START_BLOCK);
    const seen: number[] = [];
    const off = chain.subscribe((b) => seen.push(b));
    ticks(2);
    off();
    ticks(1);
    expect(seen).toEqual([START_BLOCK + 1, START_BLOCK + 2]);
  });

  it('advances on an interval when blockMs > 0 and stops after dispose()', () => {
    const timed = createMockChain({ blockMs: 300 });
    vi.advanceTimersByTime(900);
    expect(timed.block()).toBe(START_BLOCK + 3);
    timed.dispose();
    vi.advanceTimersByTime(900);
    expect(timed.block()).toBe(START_BLOCK + 3);
  });
});

describe('pulls', () => {
  it('freePull works once per address, then reverts', () => {
    const first = chain.freePull(ALICE);
    expect(first).toEqual({ status: 'success', events: { tokenId: '1' } });
    expect(chain.freePull(ALICE)).toEqual({ status: 'reverted', events: {} });
    expect(chain.freePull(BOB).events.tokenId).toBe('2');
    expect(chain.getAccount(ALICE)).toMatchObject({ cardId: '1', hasPulled: true });
  });

  it('rolls stats from the rng with the rarity thresholds', () => {
    const rarities = [59, 60, 87, 88, 97, 98].map((roll, i) => {
      const addr = `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex;
      const id = pull(addr, { roll, atkBonus: 4, hpBonus: 300, element: 2 });
      return chain.card(id)!;
    });
    expect(rarities.map((c) => c.rarity)).toEqual([0, 1, 1, 2, 2, 3]);
    expect(rarities[0]).toMatchObject({ atk: 14, hp: 1800, element: 2, mintedAt: START_BLOCK });
    expect(rarities[5]).toMatchObject({ atk: 17, hp: 2100 });
  });

  it('paidPull reverts on a wrong value and mints a new active card on the right one', () => {
    chain.credit(ALICE, parseEther('1'));
    const first = pull(ALICE);
    expect(chain.paidPull(ALICE, PRICE - 1n).status).toBe('reverted');
    expect(chain.paidPull(ALICE, 0n).status).toBe('reverted');
    expect(chain.balanceOf(ALICE)).toBe(parseEther('1'));

    const second = chain.paidPull(ALICE, PRICE);
    expect(second.status).toBe('success');
    expect(second.events.tokenId).toBe('2');
    expect(chain.cardOf(ALICE)).toBe(2);
    expect(chain.cardOf(ALICE)).not.toBe(first);
    expect(chain.balanceOf(ALICE)).toBe(parseEther('1') - PRICE);
    expect(chain.statsMsg().treasury).toBe(PRICE.toString());
  });
});

describe('duel lifecycle', () => {
  it('createDuel requires card ownership and opens a duel with p1 filled', () => {
    const c1 = pull(ALICE);
    expect(chain.createDuel(BOB, c1).status).toBe('reverted');
    const out = chain.createDuel(ALICE, c1);
    expect(out).toMatchObject({ status: 'success', events: { duelId: '0' } });
    const d = chain.duel('0')!;
    expect(d).toMatchObject({
      id: '0',
      status: 'Open',
      p1: ALICE,
      card1: c1,
      atk1: chain.card(c1)!.atk,
      hp1: chain.card(c1)!.hp,
      maxHp1: chain.card(c1)!.hp,
      p2: '0x0000000000000000000000000000000000000000',
      hp2: 0,
      startBlock: 0,
      endBlock: 0,
      settled: false,
    });
  });

  it('p1 cannot join their own duel; joining starts the countdown', () => {
    const c1 = pull(ALICE, { element: 0 });
    const c2 = pull(BOB, { element: 2 });
    const duelId = chain.createDuel(ALICE, c1).events.duelId!;
    expect(chain.joinDuel(ALICE, duelId, c1).status).toBe('reverted');
    expect(chain.joinDuel(BOB, duelId, c1).status).toBe('reverted'); // not Bob's card
    ticks(3);
    expect(chain.joinDuel(BOB, duelId, c2).status).toBe('success');

    const d = chain.duel(duelId)!;
    const start = START_BLOCK + 3 + COUNTDOWN_BLOCKS;
    expect(d).toMatchObject({
      status: 'Active',
      p2: BOB,
      card2: c2,
      startBlock: start,
      endBlock: start + DUEL_BLOCKS,
      lastBlock1: start,
      lastBlock2: start,
      mult1: elementMult(0, 2),
      mult2: elementMult(2, 0),
    });
    expect(chain.joinDuel(CAROL, duelId, pull(CAROL)).status).toBe('reverted'); // no longer Open
  });

  it('attack by a non-participant reverts', () => {
    const { duelId } = startDuel();
    expect(chain.attack(CAROL, duelId, 5, false).status).toBe('reverted');
  });

  it('attack before the start block has no effect', () => {
    const { duelId } = startDuel();
    ticks(COUNTDOWN_BLOCKS - 1);
    const before = { ...chain.duel(duelId)! };
    expect(chain.attack(ALICE, duelId, 9, true).status).toBe('success');
    expect(chain.duel(duelId)).toEqual(before);
  });

  it('clamps taps to 3 per elapsed block and applies tapDamage with the element multiplier', () => {
    const { duelId } = startDuel(0, 2);
    ticks(COUNTDOWN_BLOCKS + 3);
    const before = chain.duel(duelId)!;
    expect(allowedTaps(20, 3)).toBe(9);
    expect(chain.attack(ALICE, duelId, 20, false).status).toBe('success');
    const d = chain.duel(duelId)!;
    expect(d.hp2).toBe(before.hp2 - tapDamage(9, before.atk1, elementMult(0, 2)));
    expect(d.hp1).toBe(before.hp1);
    expect(d.lastBlock1).toBe(chain.block());
    expect(d.lastBlock2).toBe(before.lastBlock2);
    expect(d.skill1).toBe(false);

    // Same block again: zero blocks elapsed, zero taps.
    chain.attack(ALICE, duelId, 20, false);
    expect(chain.duel(duelId)!.hp2).toBe(d.hp2);
  });

  it('the skill adds skillDamage once and is then spent', () => {
    const { duelId } = startDuel(0, 2);
    ticks(COUNTDOWN_BLOCKS + 1);
    const before = chain.duel(duelId)!;
    chain.attack(ALICE, duelId, 3, true);
    const after = chain.duel(duelId)!;
    const expected =
      tapDamage(3, before.atk1, before.mult1) +
      skillDamage(before.atk1, before.mult1, before.hp1, before.maxHp1);
    expect(after.hp2).toBe(before.hp2 - expected);
    expect(after.skill1).toBe(true);

    ticks(3);
    const mid = chain.duel(duelId)!;
    chain.attack(ALICE, duelId, 9, true);
    expect(chain.duel(duelId)!.hp2).toBe(mid.hp2 - tapDamage(9, mid.atk1, mid.mult1));
  });

  it('a KO closes the duel with the winner and later attacks have no effect', () => {
    const { duelId } = startDuel(0, 2);
    ticks(COUNTDOWN_BLOCKS);
    for (let i = 0; i < 30 && chain.duel(duelId)!.status === 'Active'; i++) {
      ticks(3);
      chain.attack(ALICE, duelId, 9, false);
    }
    const d = chain.duel(duelId)!;
    expect(d.status).toBe('P1Won');
    expect(d.hp2).toBe(0);
    expect(chain.block()).toBeLessThan(d.endBlock);
    ticks(3);
    expect(chain.attack(BOB, duelId, 9, true).status).toBe('success');
    expect(chain.duel(duelId)).toEqual({ ...d, settled: true });
  });

  it('time-up closes by remaining HP and ignores the taps in that attack', () => {
    const { duelId } = startDuel(0, 2);
    ticks(COUNTDOWN_BLOCKS + 3);
    chain.attack(ALICE, duelId, 9, false);
    const hp2 = chain.duel(duelId)!.hp2;
    while (chain.block() < chain.duel(duelId)!.endBlock) chain.tick();
    expect(chain.duel(duelId)!.status).toBe('P1Won'); // auto-closed by the poller
    expect(chain.duel(duelId)!.hp2).toBe(hp2);
  });

  it('closes by HP in favour of the side that is ahead, and later attacks are no-ops', () => {
    const { duelId } = startDuel(0, 2);
    ticks(COUNTDOWN_BLOCKS + 3);
    chain.attack(BOB, duelId, 9, false);
    const end = chain.duel(duelId)!.endBlock;
    // The poller closes the duel at endBlock; a later attack tx is then a no-op.
    while (chain.block() < end) chain.tick();
    expect(chain.duel(duelId)!.status).toBe('P2Won');
    expect(chain.attack(ALICE, duelId, 9, false).status).toBe('success');
    expect(chain.duel(duelId)!.status).toBe('P2Won');
  });

  it('equal HP at time-up is a Draw and records nothing on settle', () => {
    const { duelId, c1, c2 } = startDuel();
    while (chain.duel(duelId)!.status === 'Active') chain.tick();
    expect(chain.duel(duelId)!.status).toBe('Draw');
    ticks(2);
    expect(chain.duel(duelId)!.settled).toBe(true);
    expect(chain.card(c1)).toMatchObject({ wins: 0, losses: 0 });
    expect(chain.card(c2)).toMatchObject({ wins: 0, losses: 0 });
  });

  it('settles 2 blocks after the finish and records wins and losses', () => {
    const { duelId, c1, c2 } = startDuel(0, 2);
    ticks(COUNTDOWN_BLOCKS);
    while (chain.duel(duelId)!.status === 'Active') {
      ticks(3);
      chain.attack(ALICE, duelId, 9, false);
    }
    expect(chain.duel(duelId)!.settled).toBe(false);
    ticks(1);
    expect(chain.duel(duelId)!.settled).toBe(false);
    ticks(1);
    expect(chain.duel(duelId)!.settled).toBe(true);
    expect(chain.card(c1)).toMatchObject({ wins: 1, losses: 0 });
    expect(chain.card(c2)).toMatchObject({ wins: 0, losses: 1 });
    ticks(5);
    expect(chain.card(c1)).toMatchObject({ wins: 1 });
  });
});

describe('relay', () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const callOf = (to: Hex, data: Hex, nonce: number, value = 0n) =>
    signCall(owner, chain.config, { to, data, nonce, gas: 400_000, value });
  const freePullData = encodeFunctionData({ abi: nadCardsAbi, functionName: 'freePull' });

  async function relayAndWait(raw: Hex) {
    const p = chain.relay(raw);
    await vi.advanceTimersByTimeAsync(700);
    return p;
  }

  it('executes a signed freePull after 180-650 ms and returns the tokenId', async () => {
    chain.credit(owner.address, parseEther('0.3'));
    const raw = await callOf(chain.config.contracts.cards, freePullData, 0);
    const res = await relayAndWait(raw);
    expect(res.status).toBe('success');
    expect(res.events).toEqual({ tokenId: '1' });
    expect(res.latencyMs).toBeGreaterThanOrEqual(180);
    expect(res.latencyMs).toBeLessThanOrEqual(650);
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.blockNumber).toBe(String(START_BLOCK));
    expect(chain.getAccount(owner.address)).toMatchObject({ nonce: 1, cardId: '1' });
    expect(chain.statsMsg().txTotal).toBe(1);
  });

  it('applies the effect at the block current when the delay ends', async () => {
    const raw = await callOf(chain.config.contracts.cards, freePullData, 0);
    const p = chain.relay(raw);
    ticks(2);
    await vi.advanceTimersByTimeAsync(700);
    expect((await p).blockNumber).toBe(String(START_BLOCK + 2));
  });

  it('answers an identical resend with the same result instead of a nonce error', async () => {
    const raw = await callOf(chain.config.contracts.cards, freePullData, 0);
    const first = await relayAndWait(raw);
    const again = await relayAndWait(raw);
    expect(again).toEqual(first);
    expect(chain.getAccount(owner.address).nonce).toBe(1);
  });

  it('reports reverted txs and still consumes the nonce', async () => {
    chain.freePull(owner.address);
    const raw = await callOf(chain.config.contracts.cards, freePullData, 0);
    const res = await relayAndWait(raw);
    expect(res.status).toBe('reverted');
    expect(res.events).toEqual({});
    expect(chain.getAccount(owner.address).nonce).toBe(1);
  });

  it('rejects a nonce mismatch with a reason containing "nonce"', async () => {
    const high = await callOf(chain.config.contracts.cards, freePullData, 5);
    const err = await chain.relay(high).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, reason: 'nonce too high' });

    await relayAndWait(await callOf(chain.config.contracts.cards, freePullData, 0));
    const settleData = encodeFunctionData({ abi: blitzArenaAbi, functionName: 'settle', args: [0n] });
    const low = await callOf(chain.config.contracts.arena, settleData, 0);
    const err2 = await chain.relay(low).catch((e: unknown) => e);
    expect(err2).toMatchObject({ status: 400, reason: 'nonce too low' });
  });

  it('rejects wrong chain, unknown target, stray value and insufficient balance', async () => {
    const wrongChain = await owner.signTransaction({
      type: 'eip1559',
      chainId: 1,
      to: chain.config.contracts.cards,
      data: freePullData,
      nonce: 0,
      gas: 400_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    });
    await expect(chain.relay(wrongChain)).rejects.toMatchObject({ status: 400, reason: 'chain' });

    const stranger = await callOf(BOB, freePullData, 0);
    await expect(chain.relay(stranger)).rejects.toMatchObject({ status: 400 });

    const stray = await callOf(chain.config.contracts.cards, freePullData, 0, 1n);
    await expect(chain.relay(stray)).rejects.toMatchObject({ status: 400 });

    const paidData = encodeFunctionData({ abi: nadCardsAbi, functionName: 'paidPull' });
    const poor = await callOf(chain.config.contracts.cards, paidData, 0, PRICE);
    await expect(chain.relay(poor)).rejects.toMatchObject({ status: 400, reason: 'balance' });
    expect(chain.getAccount(owner.address).nonce).toBe(0);
  });

  it('relays a paidPull with value and createDuel events', async () => {
    chain.credit(owner.address, parseEther('0.3'));
    const paid = await callOf(
      chain.config.contracts.cards,
      encodeFunctionData({ abi: nadCardsAbi, functionName: 'paidPull' }),
      0,
      PRICE,
    );
    expect((await relayAndWait(paid)).events.tokenId).toBe('1');
    expect(chain.balanceOf(owner.address)).toBe(parseEther('0.3') - PRICE);

    const create = await callOf(
      chain.config.contracts.arena,
      encodeFunctionData({ abi: blitzArenaAbi, functionName: 'createDuel', args: [1n] }),
      1,
    );
    expect((await relayAndWait(create)).events).toEqual({ duelId: '0' });
  });
});

describe('server-like reads', () => {
  it('fund: +0.3 MON once, balance_ok above 0.1, limit_address after 3', () => {
    const first = chain.fund(ALICE);
    expect(first.funded).toBe(true);
    expect(first.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.getAccount(ALICE).balance).toBe(parseEther('0.3').toString());
    expect(chain.fund(ALICE)).toEqual({ funded: false, reason: 'balance_ok' });

    for (let i = 0; i < 3; i++) {
      expect(chain.fund(BOB).funded).toBe(true);
      chain.setBalance(BOB, 0n);
    }
    expect(chain.fund(BOB)).toEqual({ funded: false, reason: 'limit_address' });
  });

  it('getAccount reports an empty account for an unknown address', () => {
    expect(chain.getAccount(CAROL)).toEqual({ nonce: 0, balance: '0', cardId: null, hasPulled: false });
  });

  it('getCard: null for unknown ids; bare forging, then full forging, then ready', () => {
    expect(chain.getCard('99')).toBeNull();
    const id = pull(ALICE, { element: 1, roll: 99 });
    expect(chain.getCard(String(id))).toEqual({ status: 'forging' });

    vi.advanceTimersByTime(1000);
    const forging = chain.getCard(String(id));
    expect(forging).toMatchObject({ image: '/mock/card.svg', attributes: [] });
    if (!forging || !('nadgacha' in forging)) throw new Error('expected full metadata');
    expect(forging.nadgacha.status).toBe('forging');
    expect(forging.nadgacha.nadmon).toEqual({ id: 'abyssnad', name: 'Abyssnad', stage: 3 });

    vi.advanceTimersByTime(1000);
    const ready = chain.getCard(String(id));
    if (!ready || !('nadgacha' in ready)) throw new Error('expected full metadata');
    expect(ready.nadgacha.status).toBe('ready');
    expect(ready.nadgacha.title.length).toBeGreaterThan(0);
    expect(ready.nadgacha.lore.length).toBeGreaterThan(0);
    expect(ready.nadgacha).toMatchObject({ id, rarity: 3, element: 1, wins: 0, losses: 0 });
  });

  it('never produces a leaderboard and reports zero unique players and total duels', () => {
    const stats = chain.statsMsg();
    expect(stats).toMatchObject({ type: 'stats', uniquePlayers: 0, totalDuels: 0, treasury: '0' });
  });
});

describe('AI Agent', () => {
  const agent = () => chain.config.agent;

  function openDuel(addr: Hex, element = 0) {
    const card = pull(addr, { element });
    return { card, duelId: chain.createDuel(addr, card).events.duelId! };
  }

  it('refuses a duel that is not open', () => {
    expect(chain.challengeAgent('42')).toEqual({ ok: false, reason: 'not_open' });
    const { duelId } = openDuel(ALICE);
    expect(chain.challengeAgent(duelId)).toEqual({ ok: true });
    vi.advanceTimersByTime(1500);
    expect(chain.challengeAgent(duelId)).toEqual({ ok: false, reason: 'not_open' });
  });

  it('joins about 1.5 s after the challenge with its Water Rare card', () => {
    const { duelId } = openDuel(ALICE, 0);
    expect(chain.challengeAgent(duelId)).toEqual({ ok: true });
    vi.advanceTimersByTime(1400);
    expect(chain.duel(duelId)!.status).toBe('Open');
    vi.advanceTimersByTime(200);
    const d = chain.duel(duelId)!;
    expect(d.status).toBe('Active');
    expect(d.p2).toBe(agent());
    expect(chain.card(d.card2)).toMatchObject({ element: 1, rarity: 1 });
    expect(d.mult2).toBe(150); // Water beats a Fire player
  });

  it('is busy while another duel is pending or active', () => {
    const a = openDuel(ALICE);
    const b = openDuel(BOB);
    expect(chain.challengeAgent(a.duelId)).toEqual({ ok: true });
    expect(chain.challengeAgent(b.duelId)).toEqual({ ok: false, reason: 'busy' });
    vi.advanceTimersByTime(1500);
    expect(chain.challengeAgent(b.duelId)).toEqual({ ok: false, reason: 'busy' });
  });

  it('becomes free again once its duel finishes', () => {
    const a = openDuel(ALICE);
    const b = openDuel(BOB);
    chain.challengeAgent(a.duelId);
    vi.advanceTimersByTime(1500);
    while (chain.duel(a.duelId)!.status === 'Active') chain.tick();
    expect(chain.challengeAgent(b.duelId)).toEqual({ ok: true });
  });

  it('plays the duel, then records a lesson and bumps its counters after settle', () => {
    const { duelId } = openDuel(ALICE);
    const seen: number[] = [];
    chain.subscribeAgent(() => seen.push(chain.agentMsg().lessons.length));
    chain.challengeAgent(duelId);
    vi.advanceTimersByTime(1500);

    ticks(COUNTDOWN_BLOCKS + 10);
    expect(chain.duel(duelId)!.hp1).toBeLessThan(chain.duel(duelId)!.maxHp1);

    for (let i = 0; i < 200 && chain.agentMsg().lessons.length === 0; i++) chain.tick();
    const d = chain.duel(duelId)!;
    expect(d.status).toBe('P2Won');
    expect(d.settled).toBe(true);

    const msg = chain.agentMsg();
    expect(msg).toMatchObject({ type: 'agent', level: 1, finisher: false });
    expect(msg.testnet).toEqual({ duels: 1, wins: 1 });
    expect(msg.lessons).toHaveLength(1);
    expect(msg.lessons[0]).toMatchObject({ duelId });
    expect(msg.lessons[0]!.text.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
  });

  it('fires its skill once its own HP drops to the threshold', () => {
    const card = pull(ALICE, { roll: 99, atkBonus: 4, hpBonus: 300, element: 0 });
    const duelId = chain.createDuel(ALICE, card).events.duelId!;
    chain.challengeAgent(duelId);
    vi.advanceTimersByTime(1500);
    ticks(COUNTDOWN_BLOCKS);
    // The player hammers the agent; it must use its skill before going down.
    for (let i = 0; i < 40 && chain.duel(duelId)!.status === 'Active'; i++) {
      ticks(3);
      chain.attack(ALICE, duelId, 9, false);
    }
    const d = chain.duel(duelId)!;
    expect(d.skill2).toBe(true);
  });
});

describe('mock friend', () => {
  it('joins a player-created duel still open after 6 s', () => {
    const friendChain = createMockChain({ blockMs: 0, rng: () => queue.shift() ?? 0.5 });
    queue = rollInputs({});
    const c = friendChain.freePull(ALICE).events.tokenId!;
    const duelId = friendChain.createDuel(ALICE, c).events.duelId!;
    vi.advanceTimersByTime(5900);
    expect(friendChain.duel(duelId)!.status).toBe('Open');
    vi.advanceTimersByTime(200);
    const d = friendChain.duel(duelId)!;
    expect(d.status).toBe('Active');
    expect(d.p2).toBe(friendChain.config.bots[0]);
    expect(d.p2).not.toBe(friendChain.config.agent);

    const hpBefore = d.hp1;
    for (let i = 0; i < COUNTDOWN_BLOCKS + 12; i++) friendChain.tick();
    expect(friendChain.duel(duelId)!.hp1).toBeLessThan(hpBefore);
    friendChain.dispose();
  });

  it('stays away when the agent was challenged, or when disabled', () => {
    const c = chain.freePull(ALICE).events.tokenId!;
    const duelId = chain.createDuel(ALICE, c).events.duelId!;
    vi.advanceTimersByTime(7000);
    expect(chain.duel(duelId)!.status).toBe('Open'); // autoFriend disabled in beforeEach

    const other = createMockChain({ blockMs: 0 });
    const c2 = other.freePull(BOB).events.tokenId!;
    const d2 = other.createDuel(BOB, c2).events.duelId!;
    other.challengeAgent(d2);
    vi.advanceTimersByTime(7000);
    expect(other.duel(d2)!.p2).toBe(other.config.agent);
    other.dispose();
  });
});
