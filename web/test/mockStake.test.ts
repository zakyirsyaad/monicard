import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseEther } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { stakeVaultAbi } from '../src/lib/abi';
import { COUNTDOWN_BLOCKS } from '../src/lib/game';
import { signCall } from '../src/lib/sign';
import { createMockChain } from '../src/mock/chain';
import type { MockChain } from '../src/mock/chain';

const ALICE = '0x00000000000000000000000000000000000a11ce' as const;
const BOB = '0x0000000000000000000000000000000000000b0b' as const;
const CAROL = '0x00000000000000000000000000000000000ca401' as const;
const AMOUNT = parseEther('0.05');

let chain: MockChain;

function ticks(n: number) {
  for (let i = 0; i < n; i++) chain.tick();
}

/** Alice (p1) opens a duel; Bob can join. Returns the duel id. */
function openDuel(): string {
  const a = Number(chain.freePull(ALICE).events.tokenId);
  chain.freePull(BOB);
  chain.credit(ALICE, parseEther('1'));
  chain.credit(BOB, parseEther('1'));
  return chain.createDuel(ALICE, a).events.duelId!;
}

function joined(): string {
  const id = openDuel();
  expect(chain.joinDuel(BOB, id, chain.cardOf(BOB)).status).toBe('success');
  return id;
}

/** Plays the duel to its end block and lets the mock settle it. */
function finish(id: string) {
  const end = chain.duel(id)!.endBlock;
  while (chain.block() < end) chain.tick();
  ticks(3);
}

beforeEach(() => {
  vi.useFakeTimers();
  chain = createMockChain({ blockMs: 0, rng: () => 0.5, now: () => Date.now() });
  chain.disableAutoFriend();
});

afterEach(() => {
  chain.dispose();
  vi.useRealTimers();
});

describe('config', () => {
  it('exposes the vault and stake gas limits so the UI is enabled in mock mode', () => {
    expect(chain.config.contracts.stakeVault).toBeDefined();
    expect(chain.config.gasLimits.stake).toBeGreaterThan(0);
    expect(chain.config.gasLimits.claim).toBeGreaterThan(0);
  });
});

describe('stake', () => {
  it('lets p1 stake on an open duel and takes the value from the wallet', () => {
    const id = openDuel();
    expect(chain.stake(ALICE, id, AMOUNT).status).toBe('success');
    expect(chain.getStake(id)).toEqual({ amount: AMOUNT, p1Staked: true, p2Staked: false, claimed: false });
    expect(chain.balanceOf(ALICE)).toBe(parseEther('1') - AMOUNT);
  });

  it('reverts a stake from a non-participant, p2 on an open duel, a twice-staker and a bad amount', () => {
    const id = openDuel();
    expect(chain.stake(CAROL, id, AMOUNT).status).toBe('reverted');
    expect(chain.stake(BOB, id, AMOUNT).status).toBe('reverted');
    expect(chain.stake(ALICE, id, parseEther('0.0005')).status).toBe('reverted');
    expect(chain.stake(ALICE, id, parseEther('1.5')).status).toBe('reverted');
    expect(chain.getStake(id).p1Staked).toBe(false);
    expect(chain.stake(ALICE, id, AMOUNT).status).toBe('success');
    expect(chain.stake(ALICE, id, AMOUNT).status).toBe('reverted');
    expect(chain.balanceOf(ALICE)).toBe(parseEther('1') - AMOUNT);
  });

  it('makes p2 match exactly, during the countdown', () => {
    const id = openDuel();
    chain.stake(ALICE, id, AMOUNT);
    chain.joinDuel(BOB, id, chain.cardOf(BOB));
    expect(chain.stake(BOB, id, AMOUNT + 1n).status).toBe('reverted');
    expect(chain.stake(BOB, id, AMOUNT).status).toBe('success');
    expect(chain.getStake(id)).toMatchObject({ p1Staked: true, p2Staked: true });
  });

  it('closes staking when the countdown ends', () => {
    const id = joined();
    ticks(COUNTDOWN_BLOCKS);
    expect(chain.stake(ALICE, id, AMOUNT).status).toBe('reverted');
    expect(chain.stake(BOB, id, AMOUNT).status).toBe('reverted');
  });

  it('reverts on an unknown duel and without enough balance', () => {
    expect(chain.stake(ALICE, '99', AMOUNT).status).toBe('reverted');
    const id = openDuel();
    chain.setBalance(ALICE, 0n);
    expect(chain.stake(ALICE, id, AMOUNT).status).toBe('reverted');
  });

  it('has the friend bot match p1 stake when it joins', () => {
    const chain2 = createMockChain({ blockMs: 0, rng: () => 0.5, now: () => Date.now() });
    try {
      chain2.freePull(ALICE);
      chain2.credit(ALICE, parseEther('1'));
      const id = chain2.createDuel(ALICE, chain2.cardOf(ALICE)).events.duelId!;
      chain2.stake(ALICE, id, AMOUNT);
      vi.advanceTimersByTime(6100);
      expect(chain2.duel(id)!.status).toBe('Active');
      expect(chain2.getStake(id)).toMatchObject({ amount: AMOUNT, p1Staked: true, p2Staked: true });
    } finally {
      chain2.dispose();
    }
  });
});

describe('claim', () => {
  it('reverts while the duel is not settled', () => {
    const id = joined();
    chain.stake(ALICE, id, AMOUNT);
    expect(chain.claim(ALICE, id).status).toBe('reverted');
  });

  it('pays the winner the pot minus 5% and marks the stake claimed', () => {
    const id = openDuel();
    chain.stake(ALICE, id, AMOUNT);
    chain.joinDuel(BOB, id, chain.cardOf(BOB));
    chain.stake(BOB, id, AMOUNT);
    // Alice taps through the duel so she wins on hp.
    ticks(COUNTDOWN_BLOCKS + 3);
    chain.attack(ALICE, id, 5, false);
    finish(id);
    const d = chain.duel(id)!;
    expect(d.settled).toBe(true);
    const winner = d.status === 'P1Won' ? ALICE : BOB;
    const before = chain.balanceOf(winner);
    expect(chain.claim(CAROL, id).status).toBe('success');
    expect(chain.balanceOf(winner)).toBe(before + parseEther('0.095'));
    expect(chain.getStake(id).claimed).toBe(true);
  });

  it('refunds a lone staker in full', () => {
    const id = joined();
    chain.stake(ALICE, id, AMOUNT);
    finish(id);
    const before = chain.balanceOf(ALICE);
    expect(chain.claim(ALICE, id).status).toBe('success');
    expect(chain.balanceOf(ALICE)).toBe(before + AMOUNT);
  });

  it('refunds both sides on a draw', () => {
    const id = openDuel();
    chain.stake(ALICE, id, AMOUNT);
    chain.joinDuel(BOB, id, chain.cardOf(BOB));
    chain.stake(BOB, id, AMOUNT);
    // equal cards and no taps end in a draw at the end block
    finish(id);
    expect(chain.duel(id)!.status).toBe('Draw');
    const [a, b] = [chain.balanceOf(ALICE), chain.balanceOf(BOB)];
    expect(chain.claim(ALICE, id).status).toBe('success');
    expect(chain.balanceOf(ALICE)).toBe(a + AMOUNT);
    expect(chain.balanceOf(BOB)).toBe(b + AMOUNT);
  });

  it('is a silent no-op the second time and when nobody staked', () => {
    const id = joined();
    chain.stake(ALICE, id, AMOUNT);
    finish(id);
    chain.claim(ALICE, id);
    const after = chain.balanceOf(ALICE);
    expect(chain.claim(ALICE, id).status).toBe('success');
    expect(chain.balanceOf(ALICE)).toBe(after);

    const plain = joined2();
    finish(plain);
    expect(chain.claim(ALICE, plain).status).toBe('success');
  });
});

function joined2(): string {
  const id = chain.createDuel(ALICE, chain.cardOf(ALICE)).events.duelId!;
  chain.joinDuel(BOB, id, chain.cardOf(BOB));
  return id;
}

describe('relay path', () => {
  const owner = privateKeyToAccount(generatePrivateKey());

  async function relayCall(data: Hex, value: bigint, nonce: number, to = chain.config.contracts.stakeVault!) {
    const raw = await signCall(owner, chain.config, { to, data, nonce, gas: 150_000, value });
    const pending = chain.relay(raw);
    await vi.advanceTimersByTimeAsync(1000);
    return pending;
  }

  it('accepts stake with value and claim without, and rejects value on claim', async () => {
    chain.freePull(owner.address);
    chain.credit(owner.address, parseEther('1'));
    const id = chain.createDuel(owner.address, chain.cardOf(owner.address)).events.duelId!;

    const stakeData = encodeFunctionData({ abi: stakeVaultAbi, functionName: 'stake', args: [BigInt(id)] });
    const claimData = encodeFunctionData({ abi: stakeVaultAbi, functionName: 'claim', args: [BigInt(id)] });

    const withValue = await signCall(owner, chain.config, {
      to: chain.config.contracts.stakeVault!,
      data: claimData,
      nonce: 0,
      gas: 150_000,
      value: 1n,
    });
    await expect(chain.relay(withValue)).rejects.toMatchObject({ reason: 'value' });
    const staked = await relayCall(stakeData, AMOUNT, 0);
    expect(staked.status).toBe('success');
    expect(chain.getStake(id)).toMatchObject({ amount: AMOUNT, p1Staked: true });
    const claimed = await relayCall(claimData, 0n, 1);
    expect(claimed.status).toBe('reverted');
  });
});
