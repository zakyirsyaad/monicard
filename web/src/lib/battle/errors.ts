import { FundError } from '../actions';
import { toFriendly } from '../errors';
import type { ErrorContext } from '../errors';
import type { FundReason } from '../types';

const FUND_MESSAGE: Record<Exclude<FundReason, 'balance_ok'>, string> = {
  disabled: 'Test MON is off right now. Ask the host to enable it.',
  limit_address: 'This wallet has used all its test MON top-ups. Try another wallet.',
  limit_ip: 'Too many test MON top-ups from this network. Try again in a few minutes.',
  budget: 'The event test MON budget is spent. Ask the host to top it up.',
};

/** Player-facing battle error: /fund refusals first, then the shared action mapping. */
export function battleErrorText(err: unknown, ctx: ErrorContext): string {
  if (err instanceof FundError) return FUND_MESSAGE[err.reason];
  return toFriendly(err, ctx);
}