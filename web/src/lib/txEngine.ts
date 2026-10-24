import { encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { blitzArenaAbi } from './abi';
import { ApiError, NetworkError, TimeoutError } from './api';
import { allowedTaps, skillDamage, tapDamage } from './game';
import { signCall } from './sign';
import type { Config, RelayResult } from './types';

export type EngineDuel = {
  id: bigint;
  startBlock: number;
  endBlock: number;
  side: 1 | 2;
  /** From `DuelView.lastBlock1/2`, so the tap cap is right after a reload. */
  lastBlock: number;
  /** Own side, for `stats().damageSent`. */
  atk: number;
  mult: number;
};

export type TxError = { kind: 'relay'; reason: string } | { kind: 'network' } | { kind: 'reverted'; fn: 'attack' };

export type TxEvents = {
  sent: { taps: number; skill: boolean; nonce: number };
  confirmed: { hash: Hex; latencyMs: number; blockNumber: number; taps: number; skill: boolean };
  error: TxError;
};

export type TxStats = { txCount: number; damageSent: number; avgLatencyMs: number; lastTxHash: Hex | null };

export type TxEngine = {
  start(duel: EngineDuel): void;
  /** False when ignored (not started, outside startBlock ≤ block < endBlock − 2). */
  tap(): boolean;
  /** False when ignored (outside the send window, or already requested/used). */
  requestSkill(): boolean;
  /** Block of the latest WebSocket message: the engine's current block and the WS HP basis. */
  onBlock(block: number): void;
  pendingDamageEstimate(atk: number, mult: number, hp: number, maxHp: number): number;
  on<E extends keyof TxEvents>(ev: E, cb: (payload: TxEvents[E]) => void): () => void;
  stats(): TxStats;
  stop(): void;
};

export type TxEngineDeps = {
  account: PrivateKeyAccount;
  config: Config;
  relay: (rawTx: Hex, timeoutMs?: number) => Promise<RelayResult>;
  getNonce: () => Promise<number>;
  now?: () => number;
};

type Batch = { taps: number; skill: boolean };
type Unreflected = Batch & { blockNumber: number };

/** No send at block ≥ endBlock − NO_SEND_MARGIN; at endBlock − FLUSH_MARGIN batchMs is ignored. */
const NO_SEND_MARGIN = 2;
const FLUSH_MARGIN = 3;
const NONCE_ERROR = /nonce/i;

class Stopped extends Error {}

function toTxError(err: unknown): TxError {
  if (err instanceof ApiError) return { kind: 'relay', reason: err.reason };
  if (err instanceof NetworkError) return { kind: 'network' };
  return { kind: 'relay', reason: err instanceof Error ? err.message : 'unknown' };
}

export function createTxEngine(deps: TxEngineDeps): TxEngine {
  const { account, config, relay, getNonce } = deps;
  const now = deps.now ?? (() => Date.now());
  const listeners = { sent: new Set(), confirmed: new Set(), error: new Set() } as {
    [E in keyof TxEvents]: Set<(p: TxEvents[E]) => void>;
  };

  let duel: EngineDuel | null = null;
  let epoch = 0;
  let block = 0;
  let lastBlock = 0;
  let buffer = 0;
  let skill: 'idle' | 'requested' | 'busy' | 'used' = 'idle';
  let inFlight: Batch | null = null;
  let lastSendAt: number | null = null;
  let nextNonce: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unreflected: Unreflected[] = [];
  let stats: TxStats = { txCount: 0, damageSent: 0, avgLatencyMs: 0, lastTxHash: null };

  function emit<E extends keyof TxEvents>(ev: E, payload: TxEvents[E]): void {
    for (const cb of listeners[ev]) {
      try {
        cb(payload);
      } catch (err) {
        // A broken listener must not stop the engine (the next send check runs after emit).
        console.error(`txEngine ${ev} listener failed`, err);
      }
    }
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  const inPlay = (d: EngineDuel): boolean => block >= d.startBlock && block < d.endBlock - NO_SEND_MARGIN;
  const tapCap = (): number => allowedTaps(buffer, block - lastBlock);

  function trySend(): void {
    if (!duel || inFlight || !inPlay(duel)) return;
    const batch: Batch = { taps: tapCap(), skill: skill === 'requested' };
    if (batch.taps === 0 && !batch.skill) return;
    const finalFlush = block >= duel.endBlock - FLUSH_MARGIN;
    const wait = lastSendAt === null || finalFlush ? 0 : lastSendAt + config.batchMs - now();
    if (wait > 0) {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        trySend();
      }, wait);
      return;
    }
    clearTimer();
    buffer -= batch.taps;
    if (batch.skill) skill = 'busy';
    inFlight = batch;
    lastSendAt = now();
    void dispatch(duel, batch, epoch);
  }

  async function signBatch(d: EngineDuel, batch: Batch, nonce: number): Promise<Hex> {
    const data = encodeFunctionData({ abi: blitzArenaAbi, functionName: 'attack', args: [d.id, batch.taps, batch.skill] });
    return signCall(account, config, { to: config.contracts.arena, data, nonce, gas: config.gasLimits.attack });
  }

  /** Relays `raw`, resending the byte-identical raw tx on every timeout. */
  async function relayUntilAnswered(raw: Hex, myEpoch: number): Promise<RelayResult> {
    for (;;) {
      if (myEpoch !== epoch) throw new Stopped();
      try {
        return await relay(raw);
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
      }
    }
  }

  async function signAndRelay(d: EngineDuel, batch: Batch, nonce: number, myEpoch: number): Promise<RelayResult> {
    const raw = await signBatch(d, batch, nonce);
    if (myEpoch !== epoch) throw new Stopped();
    nextNonce = nonce + 1;
    emit('sent', { ...batch, nonce });
    return relayUntilAnswered(raw, myEpoch);
  }

  async function sendWithNonceRetry(d: EngineDuel, batch: Batch, myEpoch: number): Promise<RelayResult> {
    const nonce = nextNonce ?? (await getNonce());
    try {
      return await signAndRelay(d, batch, nonce, myEpoch);
    } catch (err) {
      if (!(err instanceof ApiError) || !NONCE_ERROR.test(err.reason)) throw err;
      const fresh = await getNonce();
      if (myEpoch !== epoch) throw new Stopped();
      return signAndRelay(d, batch, fresh, myEpoch);
    }
  }

  async function dispatch(d: EngineDuel, batch: Batch, myEpoch: number): Promise<void> {
    let res: RelayResult;
    try {
      res = await sendWithNonceRetry(d, batch, myEpoch);
    } catch (err) {
      if (myEpoch !== epoch || err instanceof Stopped) return;
      // Not mined: refetch the chain nonce lazily before the next tx.
      nextNonce = null;
      return settle(batch, toTxError(err));
    }
    if (myEpoch !== epoch) return;
    if (res.status !== 'success') return settle(batch, { kind: 'reverted', fn: 'attack' });
    confirm(d, batch, res);
  }

  /** Drops a failed tx: its taps are lost, the rest of the buffer stays; the skill can be requested again. */
  function settle(batch: Batch, error: TxError): void {
    inFlight = null;
    if (batch.skill) skill = 'idle';
    emit('error', error);
    trySend();
  }

  function confirm(d: EngineDuel, batch: Batch, res: RelayResult): void {
    const blockNumber = Number(res.blockNumber);
    inFlight = null;
    lastBlock = blockNumber;
    if (batch.skill) skill = 'used';
    if (blockNumber > block) unreflected = [...unreflected, { ...batch, blockNumber }];
    const txCount = stats.txCount + 1;
    stats = {
      txCount,
      damageSent: stats.damageSent + tapDamage(batch.taps, d.atk, d.mult),
      avgLatencyMs: (stats.avgLatencyMs * stats.txCount + res.latencyMs) / txCount,
      lastTxHash: res.hash,
    };
    emit('confirmed', { hash: res.hash, latencyMs: res.latencyMs, blockNumber, ...batch });
    trySend();
  }

  /** Cancels timers and orphans any in-flight promise (its result is ignored). Stats are kept. */
  function halt(): void {
    clearTimer();
    epoch += 1;
    duel = null;
    inFlight = null;
  }

  function start(next: EngineDuel): void {
    halt();
    duel = next;
    lastBlock = next.lastBlock;
    buffer = 0;
    skill = 'idle';
    lastSendAt = null;
    nextNonce = null;
    unreflected = [];
    stats = { txCount: 0, damageSent: 0, avgLatencyMs: 0, lastTxHash: null };
  }

  return {
    start,
    stop: halt,
    tap() {
      if (!duel || !inPlay(duel)) return false;
      buffer += 1;
      trySend();
      return true;
    },
    requestSkill() {
      if (!duel || !inPlay(duel) || skill !== 'idle') return false;
      skill = 'requested';
      trySend();
      return true;
    },
    onBlock(b) {
      block = Math.max(block, b);
      unreflected = unreflected.filter((u) => u.blockNumber > block);
      trySend();
    },
    pendingDamageEstimate(atk, mult, hp, maxHp) {
      const pending = [...(inFlight ? [inFlight] : []), ...unreflected];
      const taps = tapCap() + pending.reduce((sum, b) => sum + b.taps, 0);
      const skillDmg = pending.some((b) => b.skill) ? skillDamage(atk, mult, hp, maxHp) : 0;
      return tapDamage(taps, atk, mult) + skillDmg;
    },
    on(ev, cb) {
      const set = listeners[ev] as Set<typeof cb>;
      set.add(cb);
      return () => void set.delete(cb);
    },
    stats: () => stats,
  };
}
