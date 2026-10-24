import { blitzArenaAbi, nadCardsAbi, type Hex } from '@nad/shared';
import {
  decodeFunctionData,
  isHex,
  keccak256,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import type { ChainLike } from './chainTypes';
import type { ReceiptHub, TxReceipt } from './receiptHub';

export const RELAY_TIMEOUT_MS = 5_000;
export const RATE_WINDOW_MS = 1_000;
export const MAX_TX_PER_SENDER = 3;
export const MAX_TX_PER_IP = 30;
const MAX_ERROR_MESSAGE_CHARS = 200;
/** Substrings (lowercase) of node errors meaning "the node already has / already mined this tx". */
const KNOWN_TX_ERRORS = ['already known', 'nonce too low', 'replacement transaction underpriced'];

const CARDS_FNS = ['freePull', 'paidPull'] as const;
const ARENA_FNS = ['createDuel', 'joinDuel', 'attack', 'settle'] as const;

export type RelayConfig = {
  chainId: number;
  cards: Hex;
  arena: Hex;
  gasLimits: Record<string, number>;
  pullPrice: bigint;
};

export type RejectReason = 'chain' | 'to' | 'selector' | 'value' | 'gas' | 'decode';

export type ValidTx = { ok: true; hash: Hex; fn: string; gas: bigint; maxFeePerGas: bigint; value: bigint };
export type Validation = ValidTx | { ok: false; reason: RejectReason };

const reject = (reason: RejectReason): Validation => ({ ok: false, reason });

/** Pure, synchronous checks on a signed raw tx: type 2 only, our chain, our contracts, our functions. */
export function validateRawTx(raw: Hex, cfg: RelayConfig): Validation {
  if (!isHex(raw, { strict: true }) || raw.length <= 2) return reject('decode');
  let tx;
  try {
    tx = parseTransaction(raw);
  } catch {
    return reject('decode');
  }
  const { gas, maxFeePerGas } = tx;
  if (tx.type !== 'eip1559' || tx.r === undefined || tx.s === undefined) return reject('decode');
  if (gas === undefined || maxFeePerGas === undefined) return reject('decode');
  if (tx.chainId !== cfg.chainId) return reject('chain');

  const to = tx.to?.toLowerCase();
  const isCards = to === cfg.cards.toLowerCase();
  if (!isCards && to !== cfg.arena.toLowerCase()) return reject('to');

  const fn = decodeFn(isCards, tx.data ?? '0x');
  if (!fn) return reject('selector');
  const value = tx.value ?? 0n;
  if (value !== (fn === 'paidPull' ? cfg.pullPrice : 0n)) return reject('value');
  const limit = cfg.gasLimits[fn];
  if (limit === undefined || gas > BigInt(limit)) return reject('gas');
  return { ok: true, hash: keccak256(raw), fn, gas, maxFeePerGas, value };
}

/** Name of the allowed function being called, or null when the selector is not allowed on that contract. */
function decodeFn(isCards: boolean, data: Hex): string | null {
  try {
    const { functionName } = decodeFunctionData({ abi: isCards ? nadCardsAbi : blitzArenaAbi, data });
    const allowed: readonly string[] = isCards ? CARDS_FNS : ARENA_FNS;
    return allowed.includes(functionName) ? functionName : null;
  } catch {
    return null;
  }
}

export type RateLimiter = {
  /** Records the request and returns true, or returns false (recording nothing) when over a limit. */
  allow(sender: string, ip: string, hash: Hex): boolean;
  /** Number of live entries across all internal maps (bounded by traffic of the last window). */
  size(): number;
};

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const senders = new Map<string, number[]>();
  const ips = new Map<string, number[]>();
  const seen = new Map<string, number>();

  function sweep(cutoff: number): void {
    for (const map of [senders, ips]) {
      for (const [key, times] of map) {
        const live = times.filter((t) => t > cutoff);
        if (live.length === 0) map.delete(key);
        else if (live.length !== times.length) map.set(key, live);
      }
    }
    for (const [hash, t] of seen) if (t <= cutoff) seen.delete(hash);
  }

  const push = (map: Map<string, number[]>, key: string, t: number): void => {
    map.set(key, [...(map.get(key) ?? []), t]);
  };

  return {
    allow(sender, ip, hash) {
      const t = now();
      sweep(t - RATE_WINDOW_MS);
      const key = `${sender.toLowerCase()}`;
      if (seen.has(hash.toLowerCase())) return true; // resend of a counted tx
      if ((senders.get(key)?.length ?? 0) >= MAX_TX_PER_SENDER) return false;
      if ((ips.get(ip)?.length ?? 0) >= MAX_TX_PER_IP) return false;
      push(senders, key, t);
      push(ips, ip, t);
      seen.set(hash.toLowerCase(), t);
      return true;
    },
    size: () => senders.size + ips.size + seen.size,
  };
}

export type RelayDeps = {
  chain: ChainLike;
  hub: ReceiptHub;
  stats: { recordLatency(ms: number): void };
  cfg: RelayConfig;
  getBalance(address: Hex): Promise<bigint>;
  now?: () => number;
  /** Receipt wait; defaults to RELAY_TIMEOUT_MS. */
  timeoutMs?: number;
  limiter?: RateLimiter;
};

export type RelayStatus = 200 | 400 | 429 | 504;
export type RelayResult = { status: RelayStatus; json: Record<string, unknown> };

const limiters = new WeakMap<RelayDeps, RateLimiter>();

function limiterFor(deps: RelayDeps): RateLimiter {
  if (deps.limiter) return deps.limiter;
  const existing = limiters.get(deps);
  if (existing) return existing;
  const created = createRateLimiter(deps.now);
  limiters.set(deps, created);
  return created;
}

const fail = (status: RelayStatus, json: Record<string, unknown>): RelayResult => ({ status, json });

function parseBody(body: unknown): Hex | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const rawTx = (body as { rawTx?: unknown }).rawTx;
  return typeof rawTx === 'string' && isHex(rawTx, { strict: true }) ? rawTx : null;
}

function errorText(err: unknown): string {
  const e = err as { message?: string; shortMessage?: string; details?: string };
  return [e?.message, e?.shortMessage, e?.details].filter(Boolean).join(' | ').toLowerCase();
}

function shortMessage(err: unknown): string {
  const e = err as { message?: string; shortMessage?: string };
  const text = e?.shortMessage ?? e?.message?.split('\n')[0] ?? 'send failed';
  return text.slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function decodeEvents(receipt: TxReceipt, cfg: RelayConfig): { tokenId?: string; duelId?: string } {
  const from = (addr: Hex) => receipt.logs.filter((l) => l.address.toLowerCase() === addr.toLowerCase());
  const minted = parseEventLogs({ abi: nadCardsAbi, eventName: 'CardMinted', logs: from(cfg.cards) })[0];
  const created = parseEventLogs({ abi: blitzArenaAbi, eventName: 'DuelCreated', logs: from(cfg.arena) })[0];
  return {
    ...(minted ? { tokenId: minted.args.tokenId.toString() } : {}),
    ...(created ? { duelId: created.args.id.toString() } : {}),
  };
}

/** Sends the raw tx; resolves the receipt if the node reports it as already known/mined, else null. */
async function sendOrFindReceipt(deps: RelayDeps, raw: Hex, hash: Hex): Promise<TxReceipt | null> {
  try {
    await deps.chain.call((c) => c.sendRawTransaction({ serializedTransaction: raw }));
    return null;
  } catch (err) {
    const text = errorText(err);
    if (!KNOWN_TX_ERRORS.some((k) => text.includes(k))) throw err;
    return deps.chain.call((c) => c.getTransactionReceipt({ hash })).catch(() => null);
  }
}

export async function handleRelay(body: unknown, ip: string, deps: RelayDeps): Promise<RelayResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const raw = parseBody(body);
  if (!raw) return fail(400, { reason: 'decode' });
  const checked = validateRawTx(raw, deps.cfg);
  if (!checked.ok) return fail(400, { reason: checked.reason });

  let sender: Hex;
  try {
    sender = await recoverTransactionAddress({ serializedTransaction: raw as never });
  } catch {
    return fail(400, { reason: 'decode' });
  }
  if (!limiterFor(deps).allow(sender, ip, checked.hash)) return fail(429, { reason: 'rate' });

  const balanceError = await checkBalance(deps, sender, checked);
  if (balanceError) return balanceError;

  // The waiter MUST exist before the send: with ~300 ms blocks the receipt can be ingested
  // while sendRawTransaction is still in flight.
  const waiting = deps.hub.wait(checked.hash, deps.timeoutMs ?? RELAY_TIMEOUT_MS);
  waiting.catch(() => undefined); // an early return below must not leave an unhandled rejection
  let receipt: TxReceipt;
  try {
    receipt = (await sendOrFindReceipt(deps, raw, checked.hash)) ?? (await waiting);
  } catch (err) {
    if ((err as Error).message === 'timeout') return fail(504, { reason: 'timeout', hash: checked.hash });
    return fail(400, { reason: 'send', message: shortMessage(err) });
  }
  const latencyMs = now() - startedAt;
  deps.stats.recordLatency(latencyMs);
  return fail(200, {
    hash: checked.hash,
    status: receipt.status,
    latencyMs,
    blockNumber: receipt.blockNumber.toString(),
    events: decodeEvents(receipt, deps.cfg),
  });
}

async function checkBalance(deps: RelayDeps, sender: Hex, tx: ValidTx): Promise<RelayResult | null> {
  let balance: bigint;
  try {
    balance = await deps.getBalance(sender);
  } catch {
    return fail(400, { reason: 'send', message: 'balance lookup failed' });
  }
  return tx.gas * tx.maxFeePerGas + tx.value > balance ? fail(400, { reason: 'balance' }) : null;
}
