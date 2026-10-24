import { encodeFunctionData, formatEther } from 'viem';
import type { Hex } from 'viem';
import { FundError, MIN_FUND_WEI, defaultSleep, ensureFunds, mustSucceed, sendCall, waitForTxGap } from '../actions';
import type { ActionDeps } from '../actions';
import { battleStakeVaultAbi } from '../abi';
import { sameAddress } from './rules';
import { actionDeps } from '../player';
import { StakeFundsError } from '../stakeFlows';
import { parseStakeTuple } from '../stakeRead';
import type { Config, RelayResult, StakeView } from '../types';
import { battleAddress } from './actions';
import { battleClient, readMatch } from './chain';
import { battleMock } from './mock';
import { isBattleMock } from './useMatch';
import type { BattleSide, MatchView } from './types';

/** Gas fallback when `/config` omits the battle vault limits. */
const DEFAULT_GAS = 300_000;
const FAKE_VAULT: Hex = '0x00000000000000000000000000000000000000b3';
const RAKE_BPS = 500n;
const BPS = 10_000n;
const WINNER_SHARE_PERCENT = 95;

const MIN_STAKE_WEI = 1_000_000_000_000_000n; // 0.001 MON
const MAX_STAKE_WEI = 1_000_000_000_000_000_000n; // 1 MON

/** Chips in the Lobby: Free first (the default), then 0.01 / 0.05 / 0.1 MON, in wei. */
export const STAKE_OPTIONS: readonly bigint[] = [0n, 10_000_000_000_000_000n, 50_000_000_000_000_000n, 100_000_000_000_000_000n];

export const NO_STAKE: StakeView = { amount: 0n, p1Staked: false, p2Staked: false, claimed: false };

/** MON amount without trailing zeros: 200000000000000000n -> "0.2". Exact (no float rounding). */
export function monLabel(wei: bigint): string {
  return formatEther(wei);
}

/** Chip text: "Free" or "0.05 MON". */
export function stakeOptionLabel(wei: bigint): string {
  return wei === 0n ? 'Free' : `${monLabel(wei)} MON`;
}

/** "Pot 0.2 MON · winner takes 95%": the pot is twice the stake. */
export function potLabel(amount: bigint): string {
  return `Pot ${monLabel(2n * amount)} MON · winner takes ${WINNER_SHARE_PERCENT}%`;
}

/** What the winner receives: the pot minus the 5% rake, floored like the contract. */
export function winnerPayoutWei(amount: bigint): bigint {
  const pot = 2n * amount;
  return pot - (pot * RAKE_BPS) / BPS;
}

/** True when anyone put MON into the match. */
export function hasStake(stake: StakeView | null): stake is StakeView {
  return stake !== null && stake.amount > 0n && (stake.p1Staked || stake.p2Staked);
}

export const bothStaked = (stake: StakeView | null): boolean =>
  hasStake(stake) && stake.p1Staked && stake.p2Staked;

/** The joiner has to match the creator's stake: only p1 staked so far. */
export function stakeToJoin(stake: StakeView | null): bigint {
  return hasStake(stake) && stake.p1Staked && !stake.p2Staked && !stake.claimed ? stake.amount : 0n;
}

export const isStakeAmountValid = (wei: bigint): boolean => wei >= MIN_STAKE_WEI && wei <= MAX_STAKE_WEI;

const isFinal = (match: MatchView): boolean => match.status === 'P1Won' || match.status === 'P2Won';

/** Mirrors `BattleStakeVault._stakingOpen`: Open, or Active before anybody has moved. */
export function stakingOpen(match: MatchView): boolean {
  if (match.status === 'Open') return true;
  return match.status === 'Active' && match.drawn1 <= 1 && match.drawn2 <= 1;
}

export type BattleStakeOutcome = 'win' | 'lose' | 'refund' | 'none';

/** Where the viewer's stake goes once the match is over. `none` while running, unstaked, or for a spectator. */
export function battleStakeOutcome(match: MatchView, side: BattleSide | null, stake: StakeView | null): BattleStakeOutcome {
  if (!hasStake(stake) || side === null || !isFinal(match)) return 'none';
  if (stake.p1Staked && stake.p2Staked) {
    const winner: BattleSide = match.status === 'P1Won' ? 1 : 2;
    return winner === side ? 'win' : 'lose';
  }
  const staker: BattleSide = stake.p1Staked ? 1 : 2;
  return staker === side ? 'refund' : 'none';
}

/** The viewer has MON to collect: a win, or a stake that comes back; and it is not paid out yet. */
export function canClaim(match: MatchView, side: BattleSide | null, stake: StakeView | null): boolean {
  if (stake === null || stake.claimed) return false;
  const outcome = battleStakeOutcome(match, side, stake);
  return outcome === 'win' || outcome === 'refund';
}

/** Short line for the Board header: pot when both staked, else the single stake. Null when free. */
export function boardStakeLabel(stake: StakeView | null): string | null {
  if (!hasStake(stake)) return null;
  return bothStaked(stake) ? potLabel(stake.amount) : `Stake ${monLabel(stake.amount)} MON`;
}

// ------------------------------------------------- pre-send checks
// A stake after the first move (or a no-op claim) reverts and Monad still burns the whole gas limit,
// so the chain is re-read right before sending and the tx is skipped when it cannot succeed.

export type StakeSkipReason = 'closed' | 'mismatch' | 'not_final' | 'unreadable';

/** Thrown instead of sending a tx that would revert and burn gas. */
export class BattleStakeSkipped extends Error {
  constructor(readonly reason: StakeSkipReason) {
    super(`Battle stake skipped: ${reason}`);
    this.name = 'BattleStakeSkipped';
  }
}

export type StakeSendDecision = 'send' | 'already' | 'closed' | 'mismatch';

/** Decides from a fresh match + vault read whether `side` may still stake `amount`. */
export function stakeSendDecision(match: MatchView, stake: StakeView, side: BattleSide, amount: bigint): StakeSendDecision {
  if (stake.claimed || !stakingOpen(match)) return 'closed';
  if (side === 1 ? stake.p1Staked : stake.p2Staked) return 'already';
  if ((stake.p1Staked || stake.p2Staked) && stake.amount !== amount) return 'mismatch';
  return 'send';
}

export type ClaimSendDecision = 'send' | 'done' | 'not_final' | 'nothing';

/** Decides from a fresh read whether a claim would pay out; anything else would be a gas-burning no-op. */
export function claimSendDecision(match: MatchView, stake: StakeView): ClaimSendDecision {
  if (stake.claimed) return 'done';
  if (!stake.p1Staked && !stake.p2Staked) return 'nothing';
  return isFinal(match) ? 'send' : 'not_final';
}

const READ_TRIES = 3;
const READ_RETRY_MS = 400;

async function freshState(
  config: Config,
  id: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ match: MatchView; stake: StakeView }> {
  for (let attempt = 1; ; attempt++) {
    const [match, stake] = await Promise.all([
      readMatch(battleAddress(config), id),
      readBattleStake(config, id).catch(() => null),
    ]);
    if (match !== null && stake !== null) return { match, stake };
    if (attempt >= READ_TRIES) throw new BattleStakeSkipped('unreadable');
    await sleep(READ_RETRY_MS);
  }
}

// ---------------------------------------------------------------- config

export function battleStakeAvailable(config: Config | null): boolean {
  if (isBattleMock()) return true;
  return config !== null && config.contracts.battleStakeVault !== undefined;
}

export function battleVaultAddress(config: Config): Hex {
  if (isBattleMock()) return FAKE_VAULT;
  const vault = config.contracts.battleStakeVault;
  if (vault === undefined) throw new Error('Staking is not enabled');
  return vault;
}

// ---------------------------------------------------------------- reads

/** Reads `BattleStakeVault.stakes(id)`. Throws on a transient RPC error: callers retry on their next trigger. */
export async function readBattleStake(config: Config, id: string): Promise<StakeView> {
  if (isBattleMock()) return battleMock.getStake(id) ?? NO_STAKE;
  return parseStakeTuple(
    await battleClient.readContract({
      address: battleVaultAddress(config),
      abi: battleStakeVaultAbi,
      functionName: 'stakes',
      args: [BigInt(id)],
    }),
  );
}

// ---------------------------------------------------------------- actions

/**
 * The burner must hold the stake plus the 0.1 MON reserve. A refused top-up (limits, budget)
 * means it is short; a disabled faucet is reported as such.
 */
export async function ensureBattleStakeFunds(deps: ActionDeps, stakeWei: bigint): Promise<void> {
  const minWei = stakeWei + MIN_FUND_WEI;
  try {
    const account = await ensureFunds(deps, deps.account.address, minWei);
    if (BigInt(account.balance) < minWei) throw new StakeFundsError();
  } catch (err) {
    if (err instanceof FundError && err.reason !== 'disabled') throw new StakeFundsError();
    throw err;
  }
}

function mockResult(status: 'success' | 'reverted'): RelayResult {
  return {
    hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    status,
    latencyMs: 0,
    blockNumber: String(battleMock.block()),
    events: {},
  };
}

/** Tops the burner up for a stake before the create/join tx, so the later stake tx cannot run dry. */
export async function prepareBattleStake(config: Config, stakeWei: bigint, onStep?: (step: 'wallet' | 'send') => void): Promise<void> {
  if (isBattleMock()) return;
  onStep?.('wallet');
  await ensureBattleStakeFunds(actionDeps(config), stakeWei);
  onStep?.('send');
}

/** `BattleStakeVault.stake(id)` with `stakeWei`. Waits out the reserve-balance gap first. Re-reads the match first and throws `BattleStakeSkipped` instead of sending a doomed tx; null when this side already staked. */
export async function stakeBattle(config: Config, id: string, stakeWei: bigint): Promise<RelayResult | null> {
  if (isBattleMock()) {
    const { account } = actionDeps(config);
    const ok = battleMock.stake(id, account.address, stakeWei).ok;
    return mustSucceed(mockResult(ok ? 'success' : 'reverted'), 'battleStake');
  }
  const deps = actionDeps(config);
  await ensureBattleStakeFunds(deps, stakeWei);
  await waitForTxGap(deps);
  // Re-read right before sending: staking closes at the first move and a late stake burns its gas.
  const { match, stake } = await freshState(config, id, deps.sleep ?? defaultSleep);
  const side: BattleSide | null = sameAddress(match.p1, deps.account.address)
    ? 1
    : sameAddress(match.p2, deps.account.address)
      ? 2
      : null;
  if (side === null) throw new BattleStakeSkipped('closed');
  const decision = stakeSendDecision(match, stake, side, stakeWei);
  if (decision === 'already') return null;
  if (decision !== 'send') throw new BattleStakeSkipped(decision);
  const result = await sendCall(deps, {
    fn: 'battleStake',
    to: battleVaultAddress(config),
    data: encodeFunctionData({ abi: battleStakeVaultAbi, functionName: 'stake', args: [BigInt(id)] }),
    gas: config.gasLimits.battleStake ?? DEFAULT_GAS,
    value: stakeWei,
  });
  return mustSucceed(result, 'battleStake');
}

/** `BattleStakeVault.claim(id)`: pays the result out. Value 0. Returns null when there was nothing to send (already claimed). */
export async function claimBattleStake(config: Config, id: string): Promise<RelayResult | null> {
  if (isBattleMock()) {
    battleMock.claim(id); // idempotent like the contract: a repeat is a silent no-op
    return mockResult('success');
  }
  const deps = actionDeps(config);
  await ensureFunds(deps, deps.account.address);
  // A no-op claim still costs ~210k gas, so never send one: check the vault and the match first.
  const { match, stake } = await freshState(config, id, deps.sleep ?? defaultSleep);
  const decision = claimSendDecision(match, stake);
  if (decision === 'done' || decision === 'nothing') return null;
  if (decision === 'not_final') throw new BattleStakeSkipped('not_final');
  const result = await sendCall(deps, {
    fn: 'battleClaim',
    to: battleVaultAddress(config),
    data: encodeFunctionData({ abi: battleStakeVaultAbi, functionName: 'claim', args: [BigInt(id)] }),
    gas: config.gasLimits.battleClaim ?? DEFAULT_GAS,
  });
  return mustSucceed(result, 'battleClaim');
}
