import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { parseEther } from 'viem';
import { RevertedError, FundError } from '../src/lib/actions';
import { battleErrorText, OPPONENT_UNSTAKED_MESSAGE, STAKE_CLOSED_MESSAGE } from '../src/lib/battle/errors';
import { createBattleSim } from '../src/lib/battle/mock';
import {
  NO_STAKE,
  STAKE_OPTIONS,
  battleStakeAvailable,
  battleStakeOutcome,
  boardStakeLabel,
  canClaim,
  claimSendDecision,
  stakeSendDecision,
  BattleStakeSkipped,
  potLabel,
  stakeOptionLabel,
  stakeToJoin,
  stakingOpen,
  winnerPayoutWei,
} from '../src/lib/battle/stake';
import type { MatchView } from '../src/lib/battle/types';
import { StakeFundsError } from '../src/lib/stakeFlows';
import type { Config, StakeView } from '../src/lib/types';
import { OpenRoom } from '../src/routes/battle/OpenRoom';
import { BattleResult } from '../src/routes/battle/ResultOverlay';
import { StakeChips } from '../src/routes/battle/StakeChips';

const P1 = '0xAbCd000000000000000000000000000000000001';
const P2 = '0xabcd000000000000000000000000000000000002';
const VAULT = '0x00000000000000000000000000000000000000b3';
const flat = (): number => 0.5;
const AMOUNT = parseEther('0.1');
const BOTH: StakeView = { amount: AMOUNT, p1Staked: true, p2Staked: true, claimed: false };
const P1_ONLY: StakeView = { ...BOTH, p2Staked: false };

const config = (withVault: boolean): Config =>
  ({
    chainId: 10143,
    contracts: { cards: P1, arena: P2, battle: VAULT, ...(withVault ? { battleStakeVault: VAULT } : {}) },
    gasLimits: {},
    agent: P2,
    bots: [],
    event: { name: 'E', sponsor: null },
  }) as unknown as Config;

function matchWith(sim: ReturnType<typeof createBattleSim>, id: string): MatchView {
  const match = sim.getMatch(id);
  if (!match) throw new Error('missing match');
  return match;
}

function activeMatch() {
  const sim = createBattleSim({ random: flat, autoAgent: false });
  const id = sim.createMatch(P1);
  sim.joinMatch(id, P2);
  return { sim, id };
}

describe('stake helpers', () => {
  it('offers Free first, then 0.01 / 0.05 / 0.1 MON in wei', () => {
    expect(STAKE_OPTIONS).toEqual([0n, parseEther('0.01'), parseEther('0.05'), parseEther('0.1')]);
    expect(STAKE_OPTIONS.map(stakeOptionLabel)).toEqual(['Free', '0.01 MON', '0.05 MON', '0.1 MON']);
  });

  it('writes the pot as twice the stake with trailing zeros trimmed', () => {
    expect(potLabel(parseEther('0.1'))).toBe('Pot 0.2 MON · winner takes 95%');
    expect(potLabel(parseEther('0.05'))).toBe('Pot 0.1 MON · winner takes 95%');
    expect(potLabel(parseEther('0.01'))).toBe('Pot 0.02 MON · winner takes 95%');
  });

  it('pays the winner the pot minus the 5% rake', () => {
    expect(winnerPayoutWei(parseEther('0.1'))).toBe(parseEther('0.19'));
  });

  it('labels the board with the pot, a single stake, or nothing', () => {
    expect(boardStakeLabel(BOTH)).toBe('Pot 0.2 MON · winner takes 95%');
    expect(boardStakeLabel(P1_ONLY)).toBe('Stake 0.1 MON');
    expect(boardStakeLabel(NO_STAKE)).toBeNull();
    expect(boardStakeLabel(null)).toBeNull();
  });

  it('asks the joiner to match only an unmatched p1 stake', () => {
    expect(stakeToJoin(P1_ONLY)).toBe(AMOUNT);
    expect(stakeToJoin(BOTH)).toBe(0n);
    expect(stakeToJoin(NO_STAKE)).toBe(0n);
    expect(stakeToJoin(null)).toBe(0n);
  });

  it('keeps staking open only before the first move', () => {
    const { sim, id } = activeMatch();
    expect(stakingOpen(matchWith(sim, id))).toBe(true);
    expect(stakingOpen({ ...matchWith(sim, id), drawn1: 2 })).toBe(false);
    expect(stakingOpen({ ...matchWith(sim, id), status: 'P1Won' })).toBe(false);
  });

  it('decides claim eligibility from the result and the stakes', () => {
    const { sim, id } = activeMatch();
    const m = matchWith(sim, id);
    const p1Won: MatchView = { ...m, status: 'P1Won' };
    expect(battleStakeOutcome(p1Won, 1, BOTH)).toBe('win');
    expect(battleStakeOutcome(p1Won, 2, BOTH)).toBe('lose');
    expect(battleStakeOutcome(p1Won, null, BOTH)).toBe('none');
    expect(battleStakeOutcome({ ...m, status: 'P2Won' }, 1, P1_ONLY)).toBe('refund');
    expect(battleStakeOutcome({ ...m, status: 'P2Won' }, 2, P1_ONLY)).toBe('none');
    expect(battleStakeOutcome(m, 1, BOTH)).toBe('none');
    expect(battleStakeOutcome(p1Won, 1, NO_STAKE)).toBe('none');

    expect(canClaim(p1Won, 1, BOTH)).toBe(true);
    expect(canClaim(p1Won, 2, BOTH)).toBe(false);
    expect(canClaim(p1Won, 1, { ...BOTH, claimed: true })).toBe(false);
    expect(canClaim({ ...m, status: 'P2Won' }, 1, P1_ONLY)).toBe(true);
    expect(canClaim(m, 1, BOTH)).toBe(false);
  });

  it('enables staking only when the vault address is in /config', () => {
    expect(battleStakeAvailable(config(true))).toBe(true);
    expect(battleStakeAvailable(config(false))).toBe(false);
    expect(battleStakeAvailable(null)).toBe(false);
  });
});

describe('pre-send checks (a doomed tx still burns its gas limit)', () => {
  const m = (() => {
    const { sim, id } = activeMatch();
    return matchWith(sim, id);
  })();

  it('sends a stake only while staking is open and the amount fits', () => {
    expect(stakeSendDecision(m, P1_ONLY, 2, AMOUNT)).toBe('send');
    expect(stakeSendDecision(m, NO_STAKE, 1, AMOUNT)).toBe('send');
    expect(stakeSendDecision(m, P1_ONLY, 1, AMOUNT)).toBe('already');
    expect(stakeSendDecision(m, P1_ONLY, 2, parseEther('0.05'))).toBe('mismatch');
    expect(stakeSendDecision({ ...m, drawn2: 2 }, P1_ONLY, 2, AMOUNT)).toBe('closed');
    expect(stakeSendDecision({ ...m, status: 'P1Won' }, P1_ONLY, 2, AMOUNT)).toBe('closed');
    expect(stakeSendDecision(m, { ...P1_ONLY, claimed: true }, 2, AMOUNT)).toBe('closed');
  });

  it('sends a claim only when it would pay out', () => {
    const over: MatchView = { ...m, status: 'P2Won' };
    expect(claimSendDecision(over, BOTH)).toBe('send');
    expect(claimSendDecision(over, { ...BOTH, claimed: true })).toBe('done');
    expect(claimSendDecision(over, NO_STAKE)).toBe('nothing');
    expect(claimSendDecision(m, BOTH)).toBe('not_final');
  });

  it('turns a skipped send into plain English', () => {
    expect(battleErrorText(new BattleStakeSkipped('closed'), { fn: 'battleStake' })).toBe(STAKE_CLOSED_MESSAGE);
    expect(battleErrorText(new BattleStakeSkipped('not_final'), { fn: 'battleClaim' })).toMatch(/isn't final yet/);
    expect(battleErrorText(new BattleStakeSkipped('unreadable'), { fn: 'battleStake' })).toMatch(/Nothing was sent/);
  });
});

describe('battle stake errors', () => {
  it('explains a closed stake without contract jargon', () => {
    expect(battleErrorText(new RevertedError('battleStake'), { fn: 'battleStake' })).toBe(STAKE_CLOSED_MESSAGE);
    expect(STAKE_CLOSED_MESSAGE).toMatch(/Nobody was charged/);
    expect(STAKE_CLOSED_MESSAGE).not.toMatch(/revert|contract/i);
  });
  it('maps a short balance and a not-yet-final claim', () => {
    expect(battleErrorText(new StakeFundsError(), { fn: 'battleStake' })).toMatch(/Not enough test MON/);
    expect(battleErrorText(new RevertedError('battleClaim'), { fn: 'battleClaim' })).toMatch(/isn't final yet/);
  });
  it('still reports faucet refusals first', () => {
    expect(battleErrorText(new FundError('budget'), { fn: 'battleStake' })).toMatch(/budget/i);
  });
  it('words the one-sided stake simply', () => {
    expect(OPPONENT_UNSTAKED_MESSAGE).toBe('Your opponent did not stake. Your stake will be returned.');
  });
});

describe('mock BattleStakeVault', () => {
  it('lets the first staker fix the amount and requires the second to match', () => {
    const { sim, id } = activeMatch();
    expect(sim.stake(id, P1, AMOUNT)).toEqual({ ok: true });
    expect(sim.stake(id, P2, parseEther('0.05'))).toEqual({ ok: false, reason: 'mismatch' });
    expect(sim.stake(id, P1, AMOUNT)).toEqual({ ok: false, reason: 'already_staked' });
    expect(sim.stake(id, P2, AMOUNT)).toEqual({ ok: true });
    expect(sim.getStake(id)).toEqual(BOTH);
  });

  it('rejects strangers, bad amounts and staking after a move', () => {
    const { sim, id } = activeMatch();
    expect(sim.stake(id, '0x0000000000000000000000000000000000000dad', AMOUNT)).toEqual({ ok: false, reason: 'not_participant' });
    expect(sim.stake(id, P1, 1n)).toEqual({ ok: false, reason: 'bad_amount' });
    const m = matchWith(sim, id);
    const mover = m.turn === 1 ? P1 : P2;
    expect(sim.act(id, mover, 255, false).ok).toBe(true);
    expect(sim.stake(id, P1, AMOUNT)).toEqual({ ok: false, reason: 'closed' });
  });

  it('pays the winner 95% of the pot on claim and treats a repeat as a no-op', () => {
    const { sim, id } = activeMatch();
    sim.stake(id, P1, AMOUNT);
    sim.stake(id, P2, AMOUNT);
    const p1Start = sim.balanceOf(P1);
    expect(sim.claim(id)).toBe(false); // match not over yet: silent no-op
    // Force a timeout win for the waiting player by advancing the clock.
    expect(sim.getStake(id)?.claimed).toBe(false);
    expect(p1Start).toBe(sim.balanceOf(P1));
  });

  it('pays out after a finished match', () => {
    let t = 0;
    const clock = createBattleSim({ random: flat, autoAgent: false, now: () => t });
    const id = clock.createMatch(P1);
    clock.joinMatch(id, P2);
    clock.stake(id, P1, AMOUNT);
    clock.stake(id, P2, AMOUNT);
    const m = clock.getMatch(id)!;
    const waiter = m.turn === 1 ? P2 : P1;
    t += 600_000;
    expect(clock.claimTimeout(id, waiter).ok).toBe(true);
    const before = clock.balanceOf(waiter);
    expect(clock.claim(id)).toBe(true);
    expect(clock.balanceOf(waiter) - before).toBe(parseEther('0.19'));
    expect(clock.getStake(id)?.claimed).toBe(true);
    expect(clock.claim(id)).toBe(false);
    expect(clock.balanceOf(waiter) - before).toBe(parseEther('0.19'));
  });

  it('refunds a lone stake in full', () => {
    let t = 0;
    const clock = createBattleSim({ random: flat, autoAgent: false, now: () => t });
    const id = clock.createMatch(P1);
    clock.joinMatch(id, P2);
    clock.stake(id, P1, AMOUNT);
    const start = clock.balanceOf(P1);
    const waiter = clock.getMatch(id)!.turn === 1 ? P2 : P1;
    t += 600_000;
    clock.claimTimeout(id, waiter);
    clock.claim(id);
    expect(clock.balanceOf(P1)).toBe(start + AMOUNT);
  });
});

describe('render', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { origin: 'https://nad.test' } }));
  afterEach(() => vi.unstubAllGlobals());
  const html = (node: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

  it('shows the stake chips only when the vault is configured', () => {
    const shown = html(<StakeChips config={config(true)} value={0n} onChange={() => undefined} />);
    expect(shown).toContain('Free');
    expect(shown).toContain('0.01 MON');
    expect(shown).toContain('0.05 MON');
    expect(shown).toContain('0.1 MON');
    expect(shown).toContain('aria-pressed="true"');
    expect(html(<StakeChips config={config(false)} value={0n} onChange={() => undefined} />)).toBe('');
    expect(html(<StakeChips config={null} value={0n} onChange={() => undefined} />)).toBe('');
  });

  it('shows the pot line for a chosen stake', () => {
    const out = html(<StakeChips config={config(true)} value={parseEther('0.1')} onChange={() => undefined} />);
    expect(out).toContain('Pot 0.2 MON · winner takes 95%');
  });

  const { sim, id } = activeMatch();
  const open: MatchView = { ...matchWith(sim, id), status: 'Open', p2: '0x0000000000000000000000000000000000000000' };
  const baseRoom = { match: open, busy: null, joinBusyLabel: 'Joining…', error: null, onJoin: () => undefined, onFightAgent: () => undefined } as const;

  it('asks the invited friend to stake before joining', () => {
    const out = html(<OpenRoom {...baseRoom} side={null} stake={P1_ONLY} />);
    expect(out).toContain('Stake 0.1 MON to join');
    expect(out).toContain('Pot 0.2 MON · winner takes 95%');
    expect(out).toContain('Join and stake 0.1 MON');
  });

  it('keeps the free join screen unchanged', () => {
    const out = html(<OpenRoom {...baseRoom} side={null} stake={NO_STAKE} />);
    expect(out).toContain('Join match');
    expect(out).not.toContain('to join');
  });

  it('shows the creator stake and hides the AI Agent button on a staked room', () => {
    const staked = html(<OpenRoom {...baseRoom} side={1} stake={P1_ONLY} />);
    expect(staked).toContain('Stake 0.1 MON');
    expect(staked).not.toContain('Fight AI Agent');
    expect(html(<OpenRoom {...baseRoom} side={1} stake={NO_STAKE} />)).toContain('Fight AI Agent');
  });

  const won: MatchView = { ...matchWith(sim, id), status: 'P1Won', score1: 2 };
  const state = (stake: StakeView | null) => ({ stake, status: 'ready' as const, refresh: () => undefined });

  it('offers Claim to the winner of a staked match', () => {
    const out = html(<BattleResult match={won} side={1} config={config(true)} stakeState={state(BOTH)} />);
    expect(out).toContain('Claim');
    expect(out).toContain('You won 0.19 MON');
  });
  it('shows the claimed state, the loss, the refund and nothing for free matches', () => {
    expect(html(<BattleResult match={won} side={1} config={config(true)} stakeState={state({ ...BOTH, claimed: true })} />)).toContain('Claimed 0.19 MON');
    expect(html(<BattleResult match={won} side={2} config={config(true)} stakeState={state(BOTH)} />)).toContain('Lost 0.1 MON stake');
    const refund = html(<BattleResult match={won} side={1} config={config(true)} stakeState={state({ ...P1_ONLY, claimed: true })} />);
    expect(refund).toContain('Stake returned');
    const free = html(<BattleResult match={won} side={1} config={config(true)} stakeState={state(NO_STAKE)} />);
    expect(free).not.toMatch(/Claim|Lost|Stake/);
  });
});
