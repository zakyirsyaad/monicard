import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError, TimeoutError } from '../src/lib/api';
import { FundError, MaybeLandedError, RevertedError } from '../src/lib/actions';
import { friendlyError, toFriendly } from '../src/lib/errors';
import { InsufficientFundsError } from '../src/lib/flows';

describe('friendlyError', () => {
  it('maps a reverted join on a non-open duel', () =>
    expect(friendlyError({ kind: 'reverted', fn: 'joinDuel', duelStatus: 'Active' })).toBe(
      'This duel already started. Create a new one.',
    ));

  it('maps agent busy', () =>
    expect(friendlyError({ kind: 'agent', reason: 'busy' })).toBe(
      'AI Agent is in another duel. Try again in a moment.',
    ));

  it('maps network errors', () =>
    expect(friendlyError({ kind: 'network' })).toBe('Network is busy. Trying again.'));

  it('maps the other agent refusals', () => {
    expect(friendlyError({ kind: 'agent', reason: 'reserved' })).toBe(
      'AI Agent is reserved for the stage demo right now.',
    );
    expect(friendlyError({ kind: 'agent', reason: 'not_open' })).toBe(
      "That duel can't be joined anymore. Create a new one.",
    );
    expect(friendlyError({ kind: 'agent', reason: 'stale' })).toBe(
      "That duel can't be joined anymore. Create a new one.",
    );
    expect(friendlyError({ kind: 'agent', reason: 'limit_ip' })).toBe(
      'Too many challenges from this network. Try again in a few minutes.',
    );
  });

  it('maps reverted calls by function', () => {
    expect(friendlyError({ kind: 'reverted', fn: 'paidPull' })).toBe(
      "The pull didn't go through. Wait a second and try again.",
    );
    expect(friendlyError({ kind: 'reverted', fn: 'freePull' })).toBe('You already pulled your free card.');
    expect(friendlyError({ kind: 'reverted', fn: 'createDuel' })).toBe("Couldn't create the duel. Try again.");
    expect(friendlyError({ kind: 'reverted', fn: 'attack' })).toBe('That didn\'t go through. Try again.');
  });

  it('keeps a reverted join generic when the duel was still open', () => {
    expect(friendlyError({ kind: 'reverted', fn: 'joinDuel', duelStatus: 'Open' })).toBe(
      "That didn't go through. Try again.",
    );
    expect(friendlyError({ kind: 'reverted', fn: 'joinDuel' })).toBe("That didn't go through. Try again.");
  });

  it('maps relay rejections', () => {
    expect(friendlyError({ kind: 'relay', reason: 'balance' })).toBe('Not enough test MON.');
    expect(friendlyError({ kind: 'relay', reason: 'rate_limit' })).toBe('Too many requests. Wait a moment.');
    expect(friendlyError({ kind: 'relay', reason: 'http_429' })).toBe('Too many requests. Wait a moment.');
    expect(friendlyError({ kind: 'relay', reason: 'bad_sig' })).toBe('The network rejected that. Try again.');
  });

  it('never uses exclamation marks or an Error prefix', () => {
    const all = [
      friendlyError({ kind: 'network' }),
      friendlyError({ kind: 'relay', reason: 'x' }),
      friendlyError({ kind: 'reverted', fn: 'joinDuel', duelStatus: 'P1Won' }),
      friendlyError({ kind: 'agent', reason: 'busy' }),
    ];
    for (const text of all) {
      expect(text).not.toMatch(/!|^Error/);
    }
  });
});

describe('toFriendly', () => {
  const ctx = { fn: 'joinDuel', duelStatus: 'Active' as const };

  it('maps ApiError reasons to relay errors', () => {
    expect(toFriendly(new ApiError(400, 'balance'), ctx)).toBe('Not enough test MON.');
    expect(toFriendly(new ApiError(429, 'http_429'), ctx)).toBe('Too many requests. Wait a moment.');
  });

  it('maps NetworkError and TimeoutError to the network message', () => {
    expect(toFriendly(new NetworkError(), ctx)).toBe('Network is busy. Trying again.');
    expect(toFriendly(new TimeoutError(5000), ctx)).toBe('Network is busy. Trying again.');
  });

  it('maps a reverted relay result using the context', () => {
    expect(toFriendly({ status: 'reverted' }, ctx)).toBe('This duel already started. Create a new one.');
    expect(toFriendly({ status: 'reverted' }, { fn: 'paidPull' })).toBe(
      "The pull didn't go through. Wait a second and try again.",
    );
  });

  it('falls back to a calm generic message for unknown errors', () => {
    expect(toFriendly(new Error('boom'), ctx)).toBe("That didn't go through. Try again.");
    expect(toFriendly('weird', ctx)).toBe("That didn't go through. Try again.");
  });

  it('warns when a tx may have gone through', () => {
    const text = 'That may have gone through. Check your card and try again.';
    expect(friendlyError({ kind: 'uncertain' })).toBe(text);
    expect(toFriendly(new MaybeLandedError('paidPull'), ctx)).toBe(text);
  });

  it('maps funding refusals', () => {
    expect(toFriendly(new FundError('disabled'), ctx)).toBe('Test MON is off right now. Ask the host to enable it.');
    for (const reason of ['limit_address', 'limit_ip', 'budget'] as const) {
      expect(toFriendly(new FundError(reason), ctx)).toBe('The test MON faucet is busy. Try again in a minute.');
    }
  });

  it('maps a short balance after funding', () => {
    expect(toFriendly(new InsufficientFundsError(), ctx)).toBe('Not enough test MON for another pull.');
  });

  it('prefers the function name carried by a RevertedError', () => {
    expect(toFriendly(new RevertedError('freePull'), { fn: 'paidPull' })).toBe('You already pulled your free card.');
  });
});
