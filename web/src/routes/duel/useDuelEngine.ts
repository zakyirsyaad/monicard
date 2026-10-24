import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../../lib/api';
import { burnerAccount } from '../../lib/player';
import { sideStats } from '../../lib/duelView';
import type { Side } from '../../lib/duelView';
import { friendlyError } from '../../lib/errors';
import { createTxEngine } from '../../lib/txEngine';
import type { TxEngine, TxStats } from '../../lib/txEngine';
import type { Config, DuelView } from '../../lib/types';

const ERROR_HIDE_MS = 3000;

/** idle → requested (pressed) → sent (riding a tx). A failed skill tx goes back to idle, like the engine. */
type SkillState = 'idle' | 'requested' | 'sent';

export type DuelEngine = {
  /** Null until /config arrives. Screens only read it; `tap`/`requestSkill` drive it. */
  engine: TxEngine | null;
  latencyMs: number | null;
  skillRequested: boolean;
  error: string | null;
  stats: TxStats | null;
  tap: () => void;
  /** True when this press requested the skill (the caller shakes the panel only then). */
  requestSkill: () => boolean;
};

type Args = { duelId: string; duel: DuelView | null; block: number; side: Side | null; config: Config | null };

type EngineEvents = {
  latencyMs: number | null;
  skill: SkillState;
  setSkill: Dispatch<SetStateAction<SkillState>>;
  error: string | null;
  rerender: () => void;
};

function makeEngine(config: Config): TxEngine {
  const account = burnerAccount();
  return createTxEngine({
    account,
    config,
    relay: api.relay,
    getNonce: () => api.getAccount(account.address).then((a) => a.nonce),
  });
}

/** Subscribes to engine events. Owns `stop()`: deferred so StrictMode's simulated unmount does not kill the engine. */
function useEngineEvents(engine: TxEngine | null): EngineEvents {
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [skill, setSkill] = useState<SkillState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!engine) return undefined;
    clearTimeout(stopTimer.current); // StrictMode re-setup: cancel the stop its cleanup scheduled.
    const offs = [
      engine.on('sent', (e) => {
        if (e.skill) setSkill('sent');
        rerender();
      }),
      engine.on('confirmed', (e) => {
        setLatencyMs(e.latencyMs);
        rerender(); // stats and pending damage changed even when the latency did not
      }),
      engine.on('error', (e) => {
        setSkill((s) => (s === 'sent' ? 'idle' : s)); // one tx in flight: a sent skill was that tx
        setError(friendlyError(e));
        rerender();
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      stopTimer.current = setTimeout(() => engine.stop(), 0);
    };
  }, [engine]);

  useEffect(() => {
    if (error === null) return undefined;
    const timer = setTimeout(() => setError(null), ERROR_HIDE_MS);
    return () => clearTimeout(timer);
  }, [error]);

  return { latencyMs, skill, setSkill, error, rerender };
}

/** Feeds socket blocks and starts the engine once per duel (also mid-duel after a reload). */
function useEngineStart(engine: TxEngine | null, { duelId, duel, block, side }: Args): void {
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    if (engine && block > 0) engine.onBlock(block);
  }, [engine, block]);

  useEffect(() => {
    if (!engine || !duel || side === null || startedFor.current === duelId) return;
    if (duel.status !== 'Active' || block >= duel.endBlock) return;
    const own = sideStats(duel, side);
    engine.start({
      id: BigInt(duel.id),
      startBlock: duel.startBlock,
      endBlock: duel.endBlock,
      side,
      lastBlock: own.lastBlock,
      atk: own.atk,
      mult: own.mult,
    });
    startedFor.current = duelId;
  }, [engine, duel, side, block, duelId]);
}

/** One tx engine per duel mount (the Duel route is keyed by id). */
export function useDuelEngine(args: Args): DuelEngine {
  const engineRef = useRef<TxEngine | null>(null);
  if (engineRef.current === null && args.config) engineRef.current = makeEngine(args.config);
  const engine = engineRef.current;
  const { latencyMs, skill, setSkill, error, rerender } = useEngineEvents(engine);
  useEngineStart(engine, args);

  // Re-render on every tap so the pending damage moves immediately.
  const tap = useCallback(() => {
    engine?.tap();
    rerender();
  }, [engine, rerender]);

  const requestSkill = useCallback((): boolean => {
    if (!engine || skill !== 'idle') return false;
    engine.requestSkill();
    setSkill('requested');
    return true;
  }, [engine, skill, setSkill]);

  return {
    engine,
    latencyMs,
    skillRequested: skill !== 'idle',
    error,
    stats: engine ? engine.stats() : null,
    tap,
    requestSkill,
  };
}
