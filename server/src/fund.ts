import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAddress, parseEther, type Hex, type TransactionReceipt } from 'viem';

export const FUND_AMOUNT_WEI = parseEther('0.15');
export const FUND_THRESHOLD_WEI = parseEther('0.05');
export const FUND_BUDGET_WEI_DEFAULT = parseEther('3');
export const MAX_PER_ADDRESS = 3;
export const MAX_PER_IP_PER_10_MIN = 10;
export const IP_WINDOW_MS = 600_000;
export const FUND_RECEIPT_TIMEOUT_MS = 20_000;
/** After a confirmed funding, the RPC balance may be stale; treat the address as funded. */
export const FUND_COOLDOWN_MS = 5_000;
const TRANSFER_GAS = 21_000n;

export type FundReason = 'limit_address' | 'limit_ip' | 'budget' | 'balance_ok';

export interface FundLimiterConfig {
  amountWei: bigint;
  thresholdWei: bigint;
  maxPerAddress: number;
  maxPerIpPer10Min: number;
  budgetWei: bigint;
  ledgerPath: string;
}

export interface ReserveInput {
  address: Hex;
  ip: string;
  balanceWei: bigint;
  now: number;
}

export type ReserveResult =
  | { fund: true; release(): void; confirm(at?: number): void }
  | { fund: false; reason: FundReason };

export interface FundLimiter {
  reserve(input: ReserveInput): ReserveResult;
  spentWei(): bigint;
}

interface LedgerFile {
  spentWei: string;
  perAddress: Record<string, number>;
  ipLog: Record<string, number[]>;
}

interface LedgerState {
  spent: bigint;
  perAddress: Map<string, number>;
  ipLog: Map<string, number[]>;
}

function emptyState(): LedgerState {
  return { spent: 0n, perAddress: new Map(), ipLog: new Map() };
}

function parseLedger(raw: string): LedgerState {
  const f = JSON.parse(raw) as LedgerFile;
  return {
    spent: BigInt(f.spentWei),
    perAddress: new Map(Object.entries(f.perAddress).map(([k, v]) => [k, Number(v)])),
    ipLog: new Map(Object.entries(f.ipLog).map(([k, v]) => [k, v.map(Number)])),
  };
}

function loadLedger(path: string): LedgerState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw e;
  }
  try {
    return parseLedger(raw);
  } catch {
    console.error(`[fund] corrupt ledger at ${path}; moved to ${path}.corrupt, starting empty`);
    renameSync(path, `${path}.corrupt`);
    return emptyState();
  }
}

function serializeLedger(state: LedgerState, now: number): LedgerFile {
  const ipLog: Record<string, number[]> = {};
  for (const [ip, stamps] of state.ipLog) {
    const fresh = stamps.filter((t) => t > now - IP_WINDOW_MS);
    if (fresh.length > 0) ipLog[ip] = fresh;
  }
  return {
    spentWei: state.spent.toString(),
    perAddress: Object.fromEntries(state.perAddress),
    ipLog,
  };
}

function saveLedger(path: string, state: LedgerState, now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(serializeLedger(state, now)));
    renameSync(tmp, path);
  } catch (e) {
    console.error('[fund] ledger write failed:', e instanceof Error ? e.message : e);
  }
}

export function createFundLimiter(cfg: FundLimiterConfig): FundLimiter {
  const state = loadLedger(cfg.ledgerPath);
  const inFlight = new Set<string>();
  const cooldownUntil = new Map<string, number>();

  function check(addr: string, input: ReserveInput): FundReason | null {
    if (input.balanceWei >= cfg.thresholdWei) return 'balance_ok';
    if (inFlight.has(addr)) return 'balance_ok';
    if ((cooldownUntil.get(addr) ?? 0) > input.now) return 'balance_ok';
    if ((state.perAddress.get(addr) ?? 0) >= cfg.maxPerAddress) return 'limit_address';
    const recent = (state.ipLog.get(input.ip) ?? []).filter((t) => t > input.now - IP_WINDOW_MS);
    if (recent.length >= cfg.maxPerIpPer10Min) return 'limit_ip';
    if (state.spent + cfg.amountWei > cfg.budgetWei) return 'budget';
    return null;
  }

  function reserve(input: ReserveInput): ReserveResult {
    const addr = input.address.toLowerCase();
    const reason = check(addr, input);
    if (reason) return { fund: false, reason };
    state.spent += cfg.amountWei;
    state.perAddress.set(addr, (state.perAddress.get(addr) ?? 0) + 1);
    state.ipLog.set(input.ip, [...(state.ipLog.get(input.ip) ?? []), input.now]);
    inFlight.add(addr);
    saveLedger(cfg.ledgerPath, state, input.now);
    let settled = false;
    return {
      fund: true,
      confirm(at: number = Date.now()) {
        inFlight.delete(addr);
        cooldownUntil.set(addr, at + FUND_COOLDOWN_MS);
      },
      release() {
        if (settled) return;
        settled = true;
        inFlight.delete(addr);
        state.spent -= cfg.amountWei;
        state.perAddress.set(addr, Math.max(0, (state.perAddress.get(addr) ?? 1) - 1));
        const stamps = [...(state.ipLog.get(input.ip) ?? [])];
        const idx = stamps.indexOf(input.now);
        if (idx >= 0) stamps.splice(idx, 1);
        state.ipLog.set(input.ip, stamps);
        saveLedger(cfg.ledgerPath, state, input.now);
      },
    };
  }

  return { reserve, spentWei: () => state.spent };
}

let fundEnabled = false;
export function setFundEnabled(v: boolean): void {
  fundEnabled = v;
}
export function isFundEnabled(): boolean {
  return fundEnabled;
}

export interface FundDeps {
  limiter: FundLimiter;
  queue: {
    address: Hex;
    send(req: { to: Hex; data: Hex; gas: bigint; value?: bigint }): Promise<Hex>;
  };
  hub: { wait(hash: Hex, timeoutMs: number): Promise<TransactionReceipt> };
  getBalance(address: Hex): Promise<bigint>;
  enabled?: () => boolean;
  /** Transfer amount; must match the limiter's amountWei (defaults to FUND_AMOUNT_WEI). */
  amountWei?: bigint;
}

export type FundStatus = 200 | 400 | 502;
export interface FundResponse {
  status: FundStatus;
  json: { funded: boolean; txHash?: Hex; reason?: string };
}

const BAD_ADDRESS: FundResponse = { status: 400, json: { funded: false, reason: 'address' } };
const SEND_FAILED: FundResponse = { status: 502, json: { funded: false, reason: 'send' } };

function parseAddress(body: unknown): Hex | null {
  if (typeof body !== 'object' || body === null) return null;
  const a = (body as { address?: unknown }).address;
  return typeof a === 'string' && isAddress(a, { strict: false }) ? (a as Hex) : null;
}

class RevertedError extends Error {}

/** Sends the transfer; resolves after the receipt, or with the hash if the receipt wait fails. */
async function transfer(address: Hex, deps: FundDeps): Promise<Hex> {
  const hash = await deps.queue.send({
    to: address,
    data: '0x',
    gas: TRANSFER_GAS,
    value: deps.amountWei ?? FUND_AMOUNT_WEI,
  });
  try {
    const receipt = await deps.hub.wait(hash, FUND_RECEIPT_TIMEOUT_MS);
    if (receipt.status !== 'success') throw new RevertedError(`transfer reverted (${hash})`);
  } catch (e) {
    if (e instanceof RevertedError) throw e;
    // The tx was accepted by the RPC and will likely land: keep the charge.
    console.error('[fund] receipt wait failed, keeping charge:', e instanceof Error ? e.message : e);
  }
  return hash;
}

export async function handleFund(body: unknown, ip: string, deps: FundDeps): Promise<FundResponse> {
  const address = parseAddress(body);
  if (!address) return BAD_ADDRESS;
  if (!(deps.enabled ?? isFundEnabled)()) {
    return { status: 200, json: { funded: false, reason: 'disabled' } };
  }
  let balanceWei: bigint;
  try {
    balanceWei = await deps.getBalance(address);
  } catch (e) {
    console.error('[fund] balance lookup failed:', e instanceof Error ? e.message : e);
    return SEND_FAILED;
  }
  const r = deps.limiter.reserve({ address, ip, balanceWei, now: Date.now() });
  if (!r.fund) return { status: 200, json: { funded: false, reason: r.reason } };
  try {
    const txHash = await transfer(address, deps);
    r.confirm(Date.now());
    return { status: 200, json: { funded: true, txHash } };
  } catch (e) {
    r.release();
    console.error('[fund] transfer failed:', e instanceof Error ? e.message : e);
    return SEND_FAILED;
  }
}
