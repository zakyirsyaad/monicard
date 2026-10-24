import { FundError, RevertedError } from '../actions';
import { NOT_FINAL, toFriendly } from '../errors';
import type { ErrorContext } from '../errors';
import { StakeFundsError } from '../stakeFlows';
import { BattleStakeSkipped } from './stake';
import type { FundReason } from '../types';

const FUND_MESSAGE: Record<Exclude<FundReason, 'balance_ok'>, string> = {
  disabled: 'Test MON is off right now. Ask the host to enable it.',
  limit_address: 'This wallet has used all its test MON top-ups. Try another wallet.',
  limit_ip: 'Too many test MON top-ups from this network. Try again in a few minutes.',
  budget: 'The event test MON budget is spent. Ask the host to top it up.',
};

export const STAKE_CLOSED_MESSAGE =
  "Your stake didn't go through. Staking closes once the match has started or if the amounts differ. Nobody was charged.";
export const STAKE_FUNDS_MESSAGE = 'Not enough test MON to cover this stake.';
export const OPPONENT_UNSTAKED_MESSAGE = 'Your opponent did not stake. Your stake will be returned.';

export const STAKE_UNREADABLE_MESSAGE = "Couldn't check the match right now. Nothing was sent. Try again in a moment.";

function skippedMessage(err: BattleStakeSkipped): string {
  if (err.reason === 'not_final') return NOT_FINAL;
  if (err.reason === 'unreadable') return STAKE_UNREADABLE_MESSAGE;
  return STAKE_CLOSED_MESSAGE;
}

const isRevertOf = (err: unknown, fn: string): boolean =>
  (err instanceof RevertedError && err.fn === fn) ||
  (typeof err === 'object' && err !== null && (err as { status?: unknown; fn?: unknown }).status === 'reverted' && (err as { fn?: unknown }).fn === fn);

/** Player-facing battle error: stake outcomes and /fund refusals first, then the shared action mapping. */
export function battleErrorText(err: unknown, ctx: ErrorContext): string {
  if (err instanceof StakeFundsError) return STAKE_FUNDS_MESSAGE;
  if (err instanceof BattleStakeSkipped) return skippedMessage(err);
  if (isRevertOf(err, 'battleStake') || (ctx.fn === 'battleStake' && err instanceof RevertedError)) return STAKE_CLOSED_MESSAGE;
  if (isRevertOf(err, 'battleClaim') || (ctx.fn === 'battleClaim' && err instanceof RevertedError)) return NOT_FINAL;
  if (err instanceof FundError) return FUND_MESSAGE[err.reason];
  return toFriendly(err, ctx);
}