import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { lostJoinRace, mySide, opponentOf, phase, sameAddress } from '../lib/duelView';
import type { Side } from '../lib/duelView';
import { friendlyError, toFriendly } from '../lib/errors';
import { shortHex } from '../lib/format';
import { burnerAccount } from '../lib/player';
import { RETURN_TO_KEY } from '../lib/returnTo';
import { stakeEnabled } from '../lib/stakeView';
import type { AgentMsg, Config, DuelView } from '../lib/types';
import { useArenaSocket } from '../lib/useArenaSocket';
import { useConfig } from '../lib/useConfig';
import { useStake } from '../lib/useStake';
import type { StakeCtx } from '../lib/useStake';
import { Battle } from './duel/Battle';
import { JoinConfirm } from './duel/JoinConfirm';
import { Message } from './duel/Message';
import { Result } from './duel/Result';
import { Spectator } from './duel/Spectator';
import { NO_STAKE_JOIN, StakeLine } from './duel/StakeLine';
import type { StakeJoin } from './duel/StakeLine';
import { WaitingRoom } from './duel/WaitingRoom';
import { useDuelEngine } from './duel/useDuelEngine';
import type { DuelEngine } from './duel/useDuelEngine';
import { useWakeLock } from './duel/useWakeLock';

const NOT_FOUND_MS = 5000;
const JOIN_RACE_LOST = friendlyError({ kind: 'reverted', fn: 'joinDuel', duelStatus: 'Active' });

type CardState = { cardId: string | null; error: string | null };

/** `/duel/:id`. Keyed by id so a rematch to a new duel remounts with a fresh engine. */
export function DuelRoute() {
  const { id = '' } = useParams();
  return <Duel key={id} id={id} />;
}

/** The burner's card. New players (no card) go through onboarding and come back here. */
function usePlayerCard(duelId: string): CardState {
  const navigate = useNavigate();
  const [state, setState] = useState<CardState>({ cardId: null, error: null });

  useEffect(() => {
    let cancelled = false;
    api.getAccount(burnerAccount().address).then(
      (account) => {
        if (cancelled) return;
        if (account.cardId !== null) {
          setState({ cardId: account.cardId, error: null });
          return;
        }
        try {
          sessionStorage.setItem(RETURN_TO_KEY, `/duel/${duelId}`);
        } catch {
          // Storage blocked: after the pull the player lands on Play and can reopen the link.
        }
        navigate('/', { replace: true });
      },
      (err: unknown) => {
        if (!cancelled) setState({ cardId: null, error: toFriendly(err, { fn: 'getAccount' }) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [duelId, navigate]);

  return state;
}

/** True once the socket is connected and its snapshot still has no such duel after 5 s. */
function useNotFound(connected: boolean, found: boolean): boolean {
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    if (!connected || found) {
      setNotFound(false);
      return undefined;
    }
    const timer = setTimeout(() => setNotFound(true), NOT_FOUND_MS);
    return () => clearTimeout(timer);
  }, [connected, found]);
  return notFound;
}

function opponentName(duel: DuelView, side: Side, vsAgent: boolean, agent: AgentMsg | null): string {
  if (vsAgent) return agent ? `AI Agent · Lv.${agent.level}` : 'AI Agent';
  return shortHex(opponentOf(duel, side));
}

type ParticipantProps = {
  duel: DuelView;
  side: Side;
  view: 'countdown' | 'battle' | 'ended';
  block: number;
  config: Config | null;
  agent: AgentMsg | null;
  taunt: string | null;
  duelEngine: DuelEngine;
  stakeCtx: StakeCtx | null;
  stakeJoin: StakeJoin;
};

/** Countdown, battle and result for a player of this duel; the engine lives above so it survives the switch. */
function Participant({ duel, side, view, block, config, agent, taunt, duelEngine, stakeCtx, stakeJoin }: ParticipantProps) {
  const vsAgent = config !== null && sameAddress(opponentOf(duel, side), config.agent);
  if (view === 'ended') {
    return (
      <Result
        duel={duel}
        side={side}
        config={config}
        vsAgent={vsAgent}
        agent={agent}
        stats={duelEngine.stats}
        stakeCtx={stakeCtx}
      />
    );
  }
  return (
    <Battle
      duel={duel}
      block={block}
      side={side}
      countdown={view === 'countdown'}
      duelEngine={duelEngine}
      opponentName={opponentName(duel, side, vsAgent, agent)}
      taunt={taunt}
      stakeLine={stakeCtx && <StakeLine stake={stakeCtx.stake} join={stakeJoin} />}
    />
  );
}

function Duel({ id }: { id: string }) {
  const { config } = useConfig();
  const address = burnerAccount().address;
  const player = usePlayerCard(id);
  const socket = useArenaSocket({ duelId: id });
  const duel = socket.duels.get(id) ?? null;
  const notFound = useNotFound(socket.connected, duel !== null);
  const side = duel ? mySide(duel, address) : null;
  const view = phase(duel, socket.block, address);
  const duelEngine = useDuelEngine({ duelId: id, duel, block: socket.block, side, config });
  useWakeLock(view === 'countdown' || view === 'battle');

  // Stake UI (N15): behind the /config flag, never against the AI Agent (also not while the agent is still joining).
  const location = useLocation();
  const agentFlow = (location.state as { vsAgent?: boolean } | null)?.vsAgent === true;
  const againstAgent =
    agentFlow ||
    (duel !== null && config !== null && (sameAddress(duel.p1, config.agent) || sameAddress(duel.p2, config.agent)));
  const stakeOn = stakeEnabled(config) && !againstAgent && (side !== null || view === 'join');
  const { stake, refresh } = useStake(id, stakeOn, `${view}:${duel?.status}:${duel?.settled}`);
  const stakeCtx: StakeCtx | null = stakeOn && config ? { config, stake, refresh } : null;
  const [stakeJoin, setStakeJoin] = useState<StakeJoin>(NO_STAKE_JOIN);

  // Remember the join screen: if the duel then leaves Open without us, we lost the race to join.
  const [sawJoinView, setSawJoinView] = useState(false);
  useEffect(() => {
    if (view === 'join') setSawJoinView(true);
  }, [view]);

  if (player.error) return <Message text={player.error} back />;
  if (notFound) return <Message text="This duel doesn't exist." back />;
  if (!duel || player.cardId === null) return <Message text="Loading duel…" />;

  if (side !== null && (view === 'countdown' || view === 'battle' || view === 'ended')) {
    return (
      <Participant
        duel={duel}
        side={side}
        view={view}
        block={socket.block}
        config={config}
        agent={socket.agent}
        taunt={socket.taunts.get(id) ?? null}
        duelEngine={duelEngine}
        stakeCtx={stakeCtx}
        stakeJoin={stakeJoin}
      />
    );
  }
  if (view === 'waiting') {
    return <WaitingRoom duelId={id} myCardId={String(duel.card1)} stakeCtx={stakeCtx} />;
  }
  if (view === 'join') {
    return (
      <JoinConfirm
        duel={duel}
        myCardId={player.cardId}
        config={config}
        stakeCtx={stakeCtx}
        onStakeJoin={setStakeJoin}
      />
    );
  }
  if (lostJoinRace(view, sawJoinView)) return <Message text={JOIN_RACE_LOST} back />;
  return <Spectator />;
}
