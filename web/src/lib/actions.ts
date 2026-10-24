import { encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { blitzArenaAbi, nadCardsAbi } from './abi';
import { ApiError, TimeoutError } from './api';
import { signCall } from './sign';
import type { Account, Api, Config, FundReason, RelayResult } from './types';

/** 0.1 MON: below this a burner is topped up through /fund. */
export const MIN_FUND_WEI = 100_000_000_000_000_000n;
/** N9: a fresh balance is not visible for about 3 Monad blocks after the /fund receipt. */
export const FUND_SETTLE_MS = 1500;
/** Reserve balance: a value tx must be the first tx in 3 blocks (about 1.5 s). */
export const TX_GAP_MS = 1500;
export const LAST_TX_KEY = 'nad.lastTxAt';

const MAX_RESENDS = 3;
const NONCE_ERROR = /nonce/i;

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class FundError extends Error {
  constructor(readonly reason: Exclude<FundReason, 'balance_ok'>) {
    super(`Funding refused: ${reason}`);
    this.name = 'FundError';
  }
}

/** A relayed tx that mined with status `reverted`. Shaped like a result so `toFriendly` understands it. */
export class RevertedError extends Error {
  readonly status = 'reverted' as const;
  constructor(readonly fn: string) {
    super(`${fn} reverted`);
    this.name = 'RevertedError';
  }
}

/** A relay timed out and the nonce has since moved: the first send most likely landed. Never re-sign. */
export class MaybeLandedError extends Error {
  constructor(readonly fn: string) {
    super(`${fn} may have landed`);
    this.name = 'MaybeLandedError';
  }
}

export function mustSucceed(result: RelayResult, fn: string): RelayResult {
  if (result.status !== 'success') throw new RevertedError(fn);
  return result;
}

export type FundDeps = { api: Api; sleep?: (ms: number) => Promise<void> };

export type ActionDeps = FundDeps & {
  account: PrivateKeyAccount;
  config: Config;
  now?: () => number;
};

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function recordTx(at: number): void {
  try {
    storage()?.setItem(LAST_TX_KEY, String(at));
  } catch {
    // Storage blocked: the pull-again gap simply stays unknown.
  }
}

/** Milliseconds since this browser last relayed a tx. Infinity when unknown. */
export function msSinceLastTx(now: () => number = Date.now): number {
  try {
    const raw = storage()?.getItem(LAST_TX_KEY);
    if (raw === null || raw === undefined) return Infinity;
    const at = Number(raw);
    return Number.isFinite(at) ? Math.max(0, now() - at) : Infinity;
  } catch {
    return Infinity;
  }
}

/** Reserve balance: waits until the burner's last tx is 3 blocks old (a value tx must be the first in 3 blocks). */
export async function waitForTxGap({ now, sleep = defaultSleep }: Pick<ActionDeps, 'now' | 'sleep'>): Promise<void> {
  const gap = Math.max(0, TX_GAP_MS - msSinceLastTx(now));
  if (gap > 0) await sleep(gap);
}

/** Tops the burner up when its balance is under `minWei`. Returns the fresh account. */
export async function ensureFunds(
  { api, sleep = defaultSleep }: FundDeps,
  address: Hex,
  minWei: bigint = MIN_FUND_WEI,
): Promise<Account> {
  const account = await api.getAccount(address);
  if (BigInt(account.balance) >= minWei) return account;

  const result = await api.fund(address);
  if (result.funded) {
    await sleep(FUND_SETTLE_MS);
  } else if (result.reason !== 'balance_ok') {
    throw new FundError(result.reason ?? 'disabled');
  }
  return api.getAccount(address);
}

export type CallParams = { fn: string; to: Hex; data: Hex; gas: number; value?: bigint };

type Relayed = { result: RelayResult; timedOut: boolean };

/** A relay that failed after at least one timeout (the identical raw tx was resent). */
class RelayFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly timedOut: boolean,
  ) {
    super('Relay failed');
  }
}

/** Relays `raw`, resending the byte-identical tx on timeouts. */
async function relayWithResends(deps: ActionDeps, raw: Hex): Promise<Relayed> {
  const now = deps.now ?? Date.now;
  let timedOut = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return { result: await deps.api.relay(raw), timedOut };
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw new RelayFailure(err, timedOut);
      timedOut = true;
      if (attempt >= MAX_RESENDS) throw new RelayFailure(err, timedOut);
    } finally {
      recordTx(now());
    }
  }
}

const UNSAFE_FNS: ReadonlySet<string> = new Set(['createDuel', 'joinDuel', 'stake', 'claim']);

/** Calls the player must not blindly repeat: a value tx would pay twice, a duel call would duplicate a duel. */
const isUnsafeToRepeat = (call: CallParams): boolean =>
  (call.value ?? 0n) > 0n || UNSAFE_FNS.has(call.fn);

/**
 * Signs a call with the burner and relays it. A nonce error re-signs once, but only if no send of this call
 * ever timed out: after a timeout the first send probably landed, and re-signing would duplicate a value tx.
 */
export async function sendCall(deps: ActionDeps, call: CallParams): Promise<RelayResult> {
  const { api, account, config } = deps;
  const sign = async (): Promise<{ raw: Hex; nonce: number }> => {
    const { nonce } = await api.getAccount(account.address);
    const raw = await signCall(account, config, {
      to: call.to,
      data: call.data,
      gas: call.gas,
      value: call.value,
      nonce,
    });
    return { raw, nonce };
  };

  const first = await sign();
  try {
    return (await relayWithResends(deps, first.raw)).result;
  } catch (failure) {
    if (!(failure instanceof RelayFailure)) throw failure;
    const err = failure.cause;
    const isNonceError = err instanceof ApiError && NONCE_ERROR.test(err.reason);
    // After a timeout the first send may have landed: any other failure must not invite a repeat of an unsafe call.
    if (failure.timedOut && !isNonceError && isUnsafeToRepeat(call)) throw new MaybeLandedError(call.fn);
    if (!isNonceError) throw err;
    if (failure.timedOut) {
      const { nonce } = await api.getAccount(account.address);
      if (nonce > first.nonce) throw new MaybeLandedError(call.fn);
      throw err;
    }
    try {
      return (await relayWithResends(deps, (await sign()).raw)).result;
    } catch (second) {
      throw second instanceof RelayFailure ? second.cause : second;
    }
  }
}

export function freePull(deps: ActionDeps): Promise<RelayResult> {
  const { config } = deps;
  return sendCall(deps, {
    fn: 'freePull',
    to: config.contracts.cards,
    data: encodeFunctionData({ abi: nadCardsAbi, functionName: 'freePull' }),
    gas: config.gasLimits.freePull,
  });
}

export function paidPull(deps: ActionDeps, pullPriceWei: string | bigint): Promise<RelayResult> {
  const { config } = deps;
  return sendCall(deps, {
    fn: 'paidPull',
    to: config.contracts.cards,
    data: encodeFunctionData({ abi: nadCardsAbi, functionName: 'paidPull' }),
    gas: config.gasLimits.paidPull,
    value: BigInt(pullPriceWei),
  });
}

export function createDuel(deps: ActionDeps, cardId: string): Promise<RelayResult> {
  const { config } = deps;
  return sendCall(deps, {
    fn: 'createDuel',
    to: config.contracts.arena,
    data: encodeFunctionData({ abi: blitzArenaAbi, functionName: 'createDuel', args: [BigInt(cardId)] }),
    gas: config.gasLimits.createDuel,
  });
}

export function joinDuel(deps: ActionDeps, duelId: string, cardId: string): Promise<RelayResult> {
  const { config } = deps;
  return sendCall(deps, {
    fn: 'joinDuel',
    to: config.contracts.arena,
    data: encodeFunctionData({
      abi: blitzArenaAbi,
      functionName: 'joinDuel',
      args: [BigInt(duelId), BigInt(cardId)],
    }),
    gas: config.gasLimits.joinDuel,
  });
}
