import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseEther } from 'viem';
import type { Hex } from 'viem';
import { COUNTDOWN_BLOCKS } from '../src/lib/game';
import { joinAndStake } from '../src/lib/stakeFlows';
import type { Config, DuelView, StakeView } from '../src/lib/types';
import { createMockApi } from '../src/mock/api';
import { createMockChain } from '../src/mock/chain';
import { FeaturedDuel } from '../src/routes/arena/FeaturedDuel';
import { JoinConfirm } from '../src/routes/duel/JoinConfirm';
import { StakeLine } from '../src/routes/duel/StakeLine';
import { StakePanel } from '../src/routes/duel/StakePanel';
import { StakeResult } from '../src/routes/duel/StakeResult';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const P1: Hex = '0xAbCd000000000000000000000000000000000001';
const P2: Hex = '0xabcd000000000000000000000000000000000002';
const AMOUNT = parseEther('0.05');
const BOTH: StakeView = { amount: AMOUNT, p1Staked: true, p2Staked: true, claimed: false };
const P1_ONLY: StakeView = { ...BOTH, p2Staked: false };
const NONE: StakeView = { amount: 0n, p1Staked: false, p2Staked: false, claimed: false };

const CONFIG = {
  contracts: { cards: P1, arena: P2, stakeVault: P1 },
  gasLimits: { stake: 1, claim: 1 },
  agent: '0x3333333333333333333333333333333333333333',
  bots: [],
  event: { name: 'E', sponsor: null },
} as unknown as Config;

const DUEL: DuelView = {
  id: '4', p1: P1, p2: P2, hp1: 1500, hp2: 1200, atk1: 12, atk2: 14, mult1: 100, mult2: 100,
  lastBlock1: 1, lastBlock2: 1, skill1: false, skill2: false, status: 'P1Won', startBlock: 110,
  endBlock: 177, card1: 7, card2: 9, maxHp1: 1600, maxHp2: 1700, settled: true,
};
const OPEN: DuelView = { ...DUEL, status: 'Open', p2: '0x0000000000000000000000000000000000000000', settled: false };

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const ctx = (stake: StakeView | null) => ({ config: CONFIG, stake, refresh: () => undefined });

describe('JoinConfirm', () => {
  it('offers join-and-stake plus join-without-stake when p1 staked', () => {
    const out = html(<JoinConfirm duel={OPEN} myCardId="9" config={CONFIG} stakeCtx={ctx(P1_ONLY)} />);
    expect(out).toContain('Stake to match: 0.05 MON');
    expect(out).toContain('Join and stake 0.05 MON');
    expect(out).toContain('Join without stake');
  });
  it('is the plain join screen without a stake or with the flag off', () => {
    for (const stakeCtx of [ctx(NONE), ctx(null), null]) {
      const out = html(<JoinConfirm duel={OPEN} myCardId="9" config={CONFIG} stakeCtx={stakeCtx} />);
      expect(out).toContain('Join duel');
      expect(out).not.toContain('stake');
    }
  });
});

describe('StakePanel', () => {
  it('offers the chips and the stake button before staking', () => {
    const out = html(<StakePanel duelId="4" ctx={ctx(NONE)} />);
    expect(out).toContain('Add a stake (optional)');
    expect(out).toContain('0.01 MON');
    expect(out).toContain('0.1 MON');
    expect(out).toContain('Stake 0.05 MON');
  });
  it('confirms once p1 staked, with no chips', () => {
    const out = html(<StakePanel duelId="4" ctx={ctx(P1_ONLY)} />);
    expect(out).toContain('You staked 0.05 MON. Your opponent must match it.');
    expect(out).not.toContain('Add a stake');
  });
});

describe('StakeLine', () => {
  const none = { staking: null, notice: null };
  it('shows the pot, an unmatched stake, progress and the closed notice', () => {
    expect(html(<StakeLine stake={BOTH} join={none} />)).toContain('Pot 0.1 MON');
    expect(html(<StakeLine stake={P1_ONLY} join={none} />)).toContain('Stake 0.05 MON · not matched');
    expect(html(<StakeLine stake={P1_ONLY} join={{ staking: AMOUNT, notice: null }} />)).toContain(
      'Staking 0.05 MON before the duel starts…',
    );
    expect(html(<StakeLine stake={null} join={{ staking: null, notice: 'Staking closed for this duel. It runs without a stake.' }} />)).toContain(
      'Staking closed for this duel. It runs without a stake.',
    );
    expect(html(<StakeLine stake={NONE} join={none} />)).toBe('');
  });
});

describe('StakeResult', () => {
  const render = (duel: DuelView, side: 1 | 2, stake: StakeView, claimTx: string | null = null) =>
    html(<StakeResult duel={duel} side={side} ctx={ctx(stake)} stake={stake} claimTx={claimTx} onClaimed={() => undefined} />);
  it('says what each side gets', () => {
    expect(render(DUEL, 1, BOTH)).toContain('You win 0.095 MON');
    expect(render(DUEL, 2, BOTH)).toContain('Your stake goes to the winner.');
    expect(render(DUEL, 1, P1_ONLY)).toContain('Stakes are refunded.');
    expect(render({ ...DUEL, status: 'Draw' }, 1, BOTH)).toContain('Stakes are refunded.');
  });
  it('enables Claim only once settled', () => {
    expect(render(DUEL, 1, BOTH)).not.toContain('disabled=""');
    expect(render({ ...DUEL, settled: false }, 1, BOTH)).toContain('disabled=""');
  });
  it('shows settled state with the claim link', () => {
    const out = render(DUEL, 1, { ...BOTH, claimed: true }, `0x${'ab'.repeat(32)}`);
    expect(out).toContain('Stake settled onchain');
    expect(out).toContain('https://testnet.monadscan.com/tx/0xabab');
    expect(out).not.toContain('>Claim<');
  });
});

describe('FeaturedDuel pot', () => {
  it('shows the pot only when both sides staked', () => {
    const withPot = html(<FeaturedDuel duel={DUEL} config={CONFIG} block={200} stake={BOTH} />);
    expect(withPot).toContain('Pot 0.1 MON');
    expect(html(<FeaturedDuel duel={DUEL} config={CONFIG} block={200} stake={P1_ONLY} />)).not.toContain('Pot');
    expect(html(<FeaturedDuel duel={DUEL} config={CONFIG} block={200} />)).not.toContain('Pot');
  });
});

describe('joinAndStake against the mock chain', () => {
  const setup = () => {
    const chain = createMockChain({ blockMs: 0, rng: () => 0.5 });
    chain.disableAutoFriend();
    const p1 = privateKeyToAccount(generatePrivateKey());
    const p2 = privateKeyToAccount(generatePrivateKey());
    chain.freePull(p1.address);
    chain.freePull(p2.address);
    chain.credit(p1.address, parseEther('1'));
    chain.credit(p2.address, parseEther('1'));
    const id = chain.createDuel(p1.address, chain.cardOf(p1.address)).events.duelId!;
    chain.stake(p1.address, id, AMOUNT);
    const api = createMockApi(() => chain);
    return { chain, p2, id, api };
  };

  it('joins and then matches the stake', async () => {
    const { chain, p2, id, api } = setup();
    try {
      const deps = { api, account: p2, config: chain.config, sleep: () => Promise.resolve() };
      const res = await joinAndStake(deps, id, String(chain.cardOf(p2.address)), AMOUNT);
      expect(res).toMatchObject({ joined: true, staked: true });
      expect(chain.getStake(id)).toMatchObject({ p1Staked: true, p2Staked: true });
      expect(chain.balanceOf(p2.address)).toBe(parseEther('1') - AMOUNT);
    } finally {
      chain.dispose();
    }
  });

  it('keeps the join but reports no stake when the countdown ends first', async () => {
    const { chain, p2, id, api } = setup();
    try {
      const closeWindow = vi.fn(() => {
        for (let i = 0; i < COUNTDOWN_BLOCKS; i++) chain.tick();
        return Promise.resolve();
      });
      // The join just stamped the last-tx time, so the full 1,500 ms gap is waited out (the mock ticks 10 blocks).
      vi.stubGlobal('localStorage', { getItem: () => '1000', setItem: () => undefined });
      const deps = { api, account: p2, config: chain.config, sleep: closeWindow, now: () => 1000 };
      const res = await joinAndStake(deps, id, String(chain.cardOf(p2.address)), AMOUNT);
      expect(res).toMatchObject({ joined: true, staked: false });
      expect(chain.duel(id)!.status).toBe('Active');
      expect(chain.getStake(id).p2Staked).toBe(false);
      expect(chain.balanceOf(p2.address)).toBe(parseEther('1'));
    } finally {
      vi.unstubAllGlobals();
      chain.dispose();
    }
  });
});
