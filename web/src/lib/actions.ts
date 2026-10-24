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

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Relays `raw`, resending the byte-identical tx on timeouts. */
async function relayWithResends(deps: ActionDeps, raw: Hex): Promise<RelayResult> {
  const now = deps.now ?? Date.now;
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.api.relay(raw);
    } catch (err) {
      if (!(err instanceof TimeoutError) || attempt >= MAX_RESENDS) throw err;
    } finally {
      recordTx(now());
    }
  }
}

/** Signs a call with the burner and relays it. Fresh nonce each call; one re-sign on a nonce error. */
export async function sendCall(deps: ActionDeps, call: CallParams): Promise<RelayResult> {
  const { api, account, config } = deps;
  const sign = async (): Promise<Hex> => {
    const { nonce } = await api.getAccount(account.address);
    return signCall(account, config, { to: call.to, data: call.data, gas: call.gas, value: call.value, nonce });
  };

  try {
    return await relayWithResends(deps, await sign());
  } catch (err) {
    if (!(err instanceof ApiError) || !NONCE_ERROR.test(err.reason)) throw err;
    return relayWithResends(deps, await sign());
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
