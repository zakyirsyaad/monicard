import { blitzArenaAbi, nadCardsAbi, stakeVaultAbi, type Hex } from '@nad/shared';
import { battleAbi } from './battleAbi';
import {
  decodeFunctionData,
  isHex,
  keccak256,
  parseEther,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import type { ChainLike } from './chainTypes';
import type { ReceiptHub, TxReceipt } from './receiptHub';

export const RELAY_TIMEOUT_MS = 5_000;
/** Longest the early balance check may delay a request before it is skipped (fail open). */
export const BALANCE_TIMEOUT_MS = 1_000;
export const RATE_WINDOW_MS = 1_000;
export const MAX_TX_PER_SENDER = 3;
export const MAX_TX_PER_IP = 30;
/** Extra sends of an already-counted hash allowed per window (client timeout-resend), then 429. */
export const MAX_RESENDS_PER_WINDOW = 2;
const MAX_ERROR_MESSAGE_CHARS = 200;
/** Substrings (lowercase) of node errors meaning "the node already has / already mined this tx". */
const KNOWN_TX_ERRORS = ['already known', 'nonce too low', 'replacement transaction underpriced'];

const CARDS_FNS = ['freePull', 'paidPull'] as const;
const ARENA_FNS = ['createDuel', 'joinDuel', 'attack', 'settle'] as const;
const VAULT_FNS = ['stake', 'claim'] as const;
const BATTLE_FNS = ['createMatch', 'joinMatch', 'act', 'claimTimeout'] as const;

/** Inclusive bounds of the value a `stake` tx may carry (mirrors StakeVault MIN_STAKE / MAX_STAKE). */
export const STAKE_MIN_WEI = parseEther('0.001');
export const STAKE_MAX_WEI = parseEther('1');

export type RelayConfig = {
  chainId: number;
  cards: Hex;
  arena: Hex;
  /** StakeVault address; vault txs are only relayed when set. */
  stakeVault?: Hex;
  /** CardBattle address; battle txs are only relayed when set. */
  battle?: Hex;
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

  const target = targetContract(tx.to, cfg);
  if (!target) return reject('to');

  const fn = decodeFn(target, tx.data ?? '0x');
  if (!fn) return reject('selector');
  const value = tx.value ?? 0n;
  if (!isValueAllowed(fn, value, cfg)) return reject('value');
  const limit = cfg.gasLimits[fn];
  if (limit === undefined || gas > BigInt(limit)) return reject('gas');
  return { ok: true, hash: keccak256(raw), fn, gas, maxFeePerGas, value };
}

type Target = 'cards' | 'arena' | 'vault' | 'battle';

const TARGET_ABIS = { cards: nadCardsAbi, arena: blitzArenaAbi, vault: stakeVaultAbi, battle: battleAbi } as const;
const TARGET_FNS: Record<Target, readonly string[]> = {
  cards: CARDS_FNS,
  arena: ARENA_FNS,
  vault: VAULT_FNS,
  battle: BATTLE_FNS,
};

/** Which of our contracts `to` is (case-insensitive); vault/battle only count when configured. */
function targetContract(to: string | null | undefined, cfg: RelayConfig): Target | null {
  const addr = to?.toLowerCase();
  if (!addr) return null;
  if (addr === cfg.cards.toLowerCase()) return 'cards';
  if (addr === cfg.arena.toLowerCase()) return 'arena';
  if (cfg.stakeVault !== undefined && addr === cfg.stakeVault.toLowerCase()) return 'vault';
  if (cfg.battle !== undefined && addr === cfg.battle.toLowerCase()) return 'battle';
  return null;
}

/** Exact value for paidPull, the stake range for stake, zero for everything else. */
function isValueAllowed(fn: string, value: bigint, cfg: RelayConfig): boolean {
  if (fn === 'paidPull') return value === cfg.pullPrice;
  if (fn === 'stake') return value >= STAKE_MIN_WEI && value <= STAKE_MAX_WEI;
  return value === 0n;
}

/** Name of the allowed function being called, or null when the selector is not allowed on that contract. */
function decodeFn(target: Target, data: Hex): string | null {
  try {
    const { functionName } = decodeFunctionData({ abi: TARGET_ABIS[target], data });
    return TARGET_FNS[target].includes(functionName) ? functionName : null;
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
  const seen = new Map<string, { at: number; resends: number }>();

  function sweep(cutoff: number): void {
    for (const map of [senders, ips]) {
      for (const [key, times] of map) {
        const live = times.filter((t) => t > cutoff);
        if (live.length === 0) map.delete(key);
        else if (live.length !== times.length) map.set(key, live);
      }
    }
    for (const [hash, entry] of seen) if (entry.at <= cutoff) seen.delete(hash);
  }

  const push = (map: Map<string, number[]>, key: string, t: number): void => {
    map.set(key, [...(map.get(key) ?? []), t]);
  };

  return {
    allow(sender, ip, hash) {
      const t = now();
      sweep(t - RATE_WINDOW_MS);
      const key = `${sender.toLowerCase()}`;
      const known = seen.get(hash.toLowerCase());
      if (known) {
        if (known.resends >= MAX_RESENDS_PER_WINDOW) return false;
        known.resends += 1; // resend of a counted tx: free, but bounded
        return true;
      }
      if ((senders.get(key)?.length ?? 0) >= MAX_TX_PER_SENDER) return false;
      if ((ips.get(ip)?.length ?? 0) >= MAX_TX_PER_IP) return false;
      push(senders, key, t);
      push(ips, ip, t);
      seen.set(hash.toLowerCase(), { at: t, resends: 0 });
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

function decodeEvents(receipt: TxReceipt, cfg: RelayConfig): { tokenId?: string; duelId?: string; matchId?: string } {
  const from = (addr: Hex) => receipt.logs.filter((l) => l.address.toLowerCase() === addr.toLowerCase());
  const minted = parseEventLogs({ abi: nadCardsAbi, eventName: 'CardMinted', logs: from(cfg.cards) })[0];
  const created = parseEventLogs({ abi: blitzArenaAbi, eventName: 'DuelCreated', logs: from(cfg.arena) })[0];
  const matchId = cfg.battle === undefined ? undefined : matchIdFrom(receipt, cfg.battle);
  return {
    ...(minted ? { tokenId: minted.args.tokenId.toString() } : {}),
    ...(created ? { duelId: created.args.id.toString() } : {}),
    ...(matchId !== undefined ? { matchId } : {}),
  };
}

/** `MatchCreated` for createMatch, `MatchJoined` for joinMatch; both carry the id. */
function matchIdFrom(receipt: TxReceipt, battle: Hex): string | undefined {
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === battle.toLowerCase());
  const created = parseEventLogs({ abi: battleAbi, eventName: 'MatchCreated', logs })[0];
  if (created) return created.args.id.toString();
  const joined = parseEventLogs({ abi: battleAbi, eventName: 'MatchJoined', logs })[0];
  return joined ? joined.args.id.toString() : undefined;
}

const TRANSPORT_ERROR_NAMES = ['HttpRequestError', 'TimeoutError', 'WebSocketRequestError'];
const TRANSPORT_ERROR_TEXT = ['timeout', 'took too long', 'fetch failed'];

/** The send may or may not have reached the node (network trouble), so the tx may still get mined. */
function isTransportError(err: unknown): boolean {
  const names = [(err as { name?: string })?.name, (err as { cause?: { name?: string } })?.cause?.name];
  if (names.some((n) => n !== undefined && TRANSPORT_ERROR_NAMES.includes(n))) return true;
  const text = errorText(err);
  return TRANSPORT_ERROR_TEXT.some((k) => text.includes(k));
}

const isKnownTxError = (err: unknown): boolean => {
  const text = errorText(err);
  return KNOWN_TX_ERRORS.some((k) => text.includes(k));
};

type Outcome =
  | { kind: 'receipt'; receipt: TxReceipt }
  | { kind: 'timeout' }
  | { kind: 'send-error'; err: unknown };

/** A fresh pending promise per call, so nothing long-lived retains a finished request. */
const never = (): Promise<Outcome> => new Promise<Outcome>(() => undefined);

const lookupReceipt = (deps: RelayDeps, hash: Hex): Promise<TxReceipt | null> =>
  deps.chain.call((c) => c.getTransactionReceipt({ hash })).catch(() => null);

/** Receipt already ingested by the watcher, else one direct lookup, else null. */
async function findReceipt(deps: RelayDeps, hash: Hex): Promise<TxReceipt | null> {
  const fromHub = await deps.hub.wait(hash, 0).catch(() => null);
  return fromHub ?? lookupReceipt(deps, hash);
}

/**
 * The send path. Resolves with an outcome only when it has something decisive (a receipt
 * or a definitive send error); otherwise stays pending so the hub waiter decides.
 */
async function sendPath(deps: RelayDeps, raw: Hex, hash: Hex): Promise<Outcome> {
  try {
    await deps.chain.call((c) => c.sendRawTransaction({ serializedTransaction: raw }));
    return never();
  } catch (err) {
    if (isTransportError(err)) return never();
    if (isKnownTxError(err)) {
      const receipt = await lookupReceipt(deps, hash);
      return receipt ? { kind: 'receipt', receipt } : never();
    }
    const receipt = await findReceipt(deps, hash);
    return receipt ? { kind: 'receipt', receipt } : { kind: 'send-error', err };
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
  // while sendRawTransaction is still in flight. The request then ends with whichever comes
  // first: the hub receipt or a decisive send result, bounded by the waiter's timeout.
  const budgetMs = Math.max(0, (deps.timeoutMs ?? RELAY_TIMEOUT_MS) - (now() - startedAt));
  const waiting = deps.hub.wait(checked.hash, budgetMs);
  const fromHub: Promise<Outcome> = waiting.then(
    (receipt): Outcome => ({ kind: 'receipt', receipt }),
    (): Outcome => ({ kind: 'timeout' }),
  );
  const outcome = await Promise.race([fromHub, sendPath(deps, raw, checked.hash)]);
  if (outcome.kind === 'timeout') return fail(504, { reason: 'timeout', hash: checked.hash });
  if (outcome.kind === 'send-error') return fail(400, { reason: 'send', message: shortMessage(outcome.err) });
  const { receipt } = outcome;
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

/** Fails open: a down or slow balance source must not block the relay; the node still rejects underfunded txs. */
async function checkBalance(deps: RelayDeps, sender: Hex, tx: ValidTx): Promise<RelayResult | null> {
  const balance = await withTimeout(deps.getBalance(sender).catch(() => null), BALANCE_TIMEOUT_MS);
  if (balance === null) return null;
  return tx.gas * tx.maxFeePerGas + tx.value > balance ? fail(400, { reason: 'balance' }) : null;
}

/** Resolves with the promise's value, or null if it takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
