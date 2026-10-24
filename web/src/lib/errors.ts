import { FundError, MaybeLandedError } from './actions';
import { ApiError, NetworkError, TimeoutError, isTransient } from './api';
import { InsufficientFundsError } from './flows';
import { StakeFundsError } from './stakeFlows';
import type { DuelStatus } from './types';

export type AgentRefusalReason = 'busy' | 'reserved' | 'not_open' | 'stale' | 'limit_ip';

export type FriendlyInput =
  | { kind: 'reverted'; fn: string; duelStatus?: DuelStatus }
  | { kind: 'relay'; reason: string }
  | { kind: 'network' }
  | { kind: 'uncertain'; fn?: string }
  | { kind: 'agent'; reason: AgentRefusalReason };

export type ErrorContext = { fn: string; duelStatus?: DuelStatus };

const GENERIC_REVERT = "That didn't go through. Try again.";
export const STAKING_CLOSED = 'Staking closed for this duel.';
export const NOT_FINAL = "The result isn't final yet. Try again in a moment.";
const RATE_LIMITED = /limit|429/i;

function revertedMessage(fn: string, duelStatus?: DuelStatus): string {
  // Receipts carry no revert reason, so the message is inferred from the call and the duel status.
  if (fn === 'joinDuel' && duelStatus !== undefined && duelStatus !== 'Open') {
    return 'This duel already started. Create a new one.';
  }
  if (fn === 'paidPull') return "The pull didn't go through. Wait a second and try again.";
  if (fn === 'freePull') return 'You already pulled your free card.';
  if (fn === 'createDuel') return "Couldn't create the duel. Try again.";
  if (fn === 'stake') return STAKING_CLOSED;
  if (fn === 'claim') return NOT_FINAL;
  return GENERIC_REVERT;
}

function relayMessage(reason: string): string {
  if (reason === 'balance') return 'Not enough test MON.';
  if (RATE_LIMITED.test(reason)) return 'Too many requests. Wait a moment.';
  return 'The network rejected that. Try again.';
}

function agentMessage(reason: AgentRefusalReason): string {
  switch (reason) {
    case 'busy':
      return 'AI Agent is in another duel. Try again in a moment.';
    case 'reserved':
      return 'AI Agent is reserved for the stage demo right now.';
    case 'not_open':
    case 'stale':
      return "That duel can't be joined anymore. Create a new one.";
    case 'limit_ip':
      return 'Too many challenges from this network. Try again in a few minutes.';
  }
}

/** User-facing text for a failed action. Says what happened and what to do next. */
export function friendlyError(e: FriendlyInput): string {
  switch (e.kind) {
    case 'reverted':
      return revertedMessage(e.fn, e.duelStatus);
    case 'relay':
      return relayMessage(e.reason);
    case 'network':
      return 'Network is busy. Trying again.';
    case 'uncertain':
      if (e.fn === 'createDuel' || e.fn === 'joinDuel') return 'That may have gone through. Check Play and try again.';
      return 'That may have gone through. Check your card and try again.';
    case 'agent':
      return agentMessage(e.reason);
  }
}

function isRevertedResult(err: unknown): err is { status: 'reverted'; fn?: unknown } {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 'reverted';
}

function fundMessage(err: FundError): string {
  return err.reason === 'disabled'
    ? 'Test MON is off right now. Ask the host to enable it.'
    : 'The test MON faucet is busy. Try again in a minute.';
}

/** Maps anything a player action can throw or return to `friendlyError`. */
export function toFriendly(err: unknown, ctx: ErrorContext): string {
  if (isRevertedResult(err)) {
    const fn = typeof err.fn === 'string' ? err.fn : ctx.fn;
    return friendlyError({ kind: 'reverted', fn, duelStatus: ctx.duelStatus });
  }
  if (err instanceof FundError) return fundMessage(err);
  if (err instanceof MaybeLandedError) return friendlyError({ kind: 'uncertain', fn: err.fn });
  if (err instanceof StakeFundsError) return 'Not enough test MON to stake.';
  if (err instanceof InsufficientFundsError) return 'Not enough test MON for another pull.';
  if (err instanceof NetworkError || err instanceof TimeoutError) return friendlyError({ kind: 'network' });
  if (err instanceof ApiError && err.status >= 500 && isTransient(err)) return friendlyError({ kind: 'network' });
  if (err instanceof ApiError) return friendlyError({ kind: 'relay', reason: err.reason });
  return GENERIC_REVERT;
}
