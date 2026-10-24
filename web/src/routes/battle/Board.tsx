import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Notice } from '../../components/Notice';
import { formatInt, shortHex } from '../../lib/format';
import { toFriendly } from '../../lib/errors';
import { prefersReducedMotion } from '../../lib/motion';
import { burnerAccount } from '../../lib/player';
import { useArenaSocket } from '../../lib/useArenaSocket';
import { useConfig } from '../../lib/useConfig';
import {
  actBattle,
  challengeBattleAgent,
  claimBattleTimeout,
  joinBattle,
} from '../../lib/battle/actions';
import { battleMock } from '../../lib/battle/mock';
import {
  NO_PLACE,
  TURN_TIMEOUT_BLOCKS,
  advantageText,
  boardCards,
  boardDamage,
  boardSize,
  canClaimTimeout,
  damageBetween,
  emptyBoardSlot,
  frontCard,
  frontSlot,
  handCards,
  handOf,
  mySide,
  otherSide,
  pileLeft,
  sameAddress,
  sideAddress,
  sideData,
  strikeDamage,
  turnBlocksLeft,
} from '../../lib/battle/rules';
import { blocksToSeconds, isBattleMock, useMatch } from '../../lib/battle/useMatch';
import type { BattleSide, MatchView } from '../../lib/battle/types';
import { BattleResult } from './ResultOverlay';
import { BoardCard, HandCard, Pile, ScoreDots } from './cards';
import { OpenRoom } from './OpenRoom';

const DRAW_FLASH_MS = 900;
const DAMAGE_FLASH_MS = 650;

type Busy = 'join' | 'attack' | 'special' | 'agent' | 'timeout' | null;

type BannerTone = 'self' | 'opponent' | 'neutral';

const TONE_CLASS: Record<BannerTone, string> = {
  self: 'bg-purple-tint text-purple-ink',
  opponent: 'bg-berry-tint text-berry',
  neutral: 'border border-line bg-surface-raised text-ink',
};

export function BattleRoute() {
  const { id = '' } = useParams();
  return <Battle key={id} id={id} />;
}

function Centered({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-surface px-6 text-ink">
      <div className="flex max-w-[320px] flex-col items-center gap-3 text-center">
        <h1 className="display">{title}</h1>
        <p className="body text-ink-muted">{body}</p>
        {children}
      </div>
    </main>
  );
}

function ActionButton({
  label,
  amount,
  tone,
  disabled,
  busy,
  busyLabel,
  ariaLabel,
  onClick,
}: {
  label: string;
  amount: number;
  tone: 'purple' | 'deep';
  disabled: boolean;
  busy: boolean;
  busyLabel: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  const look = tone === 'purple' ? 'bg-purple text-on-purple' : 'bg-deep text-on-deep';
  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-busy={busy}
      aria-label={ariaLabel}
      onClick={onClick}
      className={`flex h-14 flex-col items-center justify-center rounded-card px-2 [touch-action:manipulation] disabled:opacity-40 ${look}`}
    >
      <span className="title leading-tight">{busy ? busyLabel : label}</span>
      {!busy && amount > 0 && <span className="data leading-tight opacity-80">{formatInt(amount)} dmg</span>}
    </button>
  );
}

function Battle({ id }: { id: string }) {
  const { config } = useConfig();
  const address = burnerAccount().address;
  const state = useMatch(id, config);
  const arena = useArenaSocket({ duelId: id });
  const match = state.match;
  const side = match ? mySide(match, address) : null;

  const [selected, setSelected] = useState<number | null>(null);
  const [awaitingBlock, setAwaitingBlock] = useState<number | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [damage, setDamage] = useState<{ key: number; side: BattleSide; amount: number } | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawTick, setDrawTick] = useState(0);
  const prevMatch = useRef<MatchView | null>(null);
  const handRef = useRef<HTMLDivElement | null>(null);

  const topSide: BattleSide = side === null ? 1 : otherSide(side);
  const bottomSide: BattleSide = side === null ? 2 : side;
  const top = match ? sideData(match, topSide) : null;
  const bottom = match ? sideData(match, bottomSide) : null;
  const me = side !== null && match ? sideData(match, side) : null;
  const foe = side !== null && match ? sideData(match, otherSide(side)) : null;
  const hand = me ? handCards(me) : [];
  const myTurn = match?.status === 'Active' && side !== null && match.turn === side;
  const targetCard = foe ? frontCard(foe) : null;
  const selectedCard = selected !== null ? (hand.find((card) => card.drawNo === selected) ?? null) : null;
  const selectedContribution =
    selectedCard !== null && targetCard !== null && me !== null && emptyBoardSlot(me) !== -1
      ? strikeDamage(selectedCard.atk, selectedCard.element, targetCard.element)
      : 0;
  const strike = me !== null && targetCard !== null ? boardDamage(me, targetCard.element) + selectedContribution : 0;
  const specialPreview = strike * 2;
  const myFront = me ? frontCard(me) : null;
  const advantage =
    myTurn && myFront !== null && targetCard !== null ? advantageText(myFront.element, targetCard.element) : null;
  const blocksLeft = match ? turnBlocksLeft(match, state.block) : 0;
  const clock = match?.status === 'Active' ? `${blocksToSeconds(blocksLeft)}s` : '—';
  const isAgent =
    side !== null &&
    match !== null &&
    ((config !== null && sideAddress(match, otherSide(side)) !== '' && sameAddress(sideAddress(match, otherSide(side)), config.agent)) ||
      (isBattleMock() && battleMock.isAgentMatch(id)));
  const agentLevel = arena.agent?.level;
  const topName = !match
    ? '—'
    : side === null
      ? shortHex(sideAddress(match, topSide))
      : isAgent
        ? `AI Agent${agentLevel !== undefined ? ` · Lv.${agentLevel}` : ''}`
        : shortHex(sideAddress(match, topSide));
  const bottomName = !match ? '—' : side === null ? shortHex(sideAddress(match, bottomSide)) : 'You';
  const canClaim = side !== null && match !== null && canClaimTimeout(match, side, state.block);
  const specialUsed = me?.specialUsed ?? false;
  const canAct = myTurn && match?.status === 'Active' && busy === null && awaitingBlock === null;
  const mustPlace = me !== null && boardSize(me) === 0 && hand.length > 0;
  const canAttack = canAct && (!mustPlace || selectedCard !== null);
  const canSpecial = canAttack && !specialUsed && strike > 0;

  useEffect(() => {
    const prev = prevMatch.current;
    prevMatch.current = match;
    if (!match || !prev || prev.id !== match.id) return;

    const lostByP1 = damageBetween(prev, match, 1);
    const lostByP2 = damageBetween(prev, match, 2);
    if (lostByP1 > 0) setDamage({ key: Date.now(), side: 1, amount: lostByP1 });
    else if (lostByP2 > 0) setDamage({ key: Date.now(), side: 2, amount: lostByP2 });

    if (side !== null) {
      const before = sideData(prev, side).drawn;
      const after = sideData(match, side).drawn;
      if (after > before) {
        setDrawing(true);
        setDrawTick((tick) => tick + 1);
      }
    }
  }, [match, side]);

  useEffect(() => {
    if (!damage) return undefined;
    const timer = setTimeout(() => setDamage(null), DAMAGE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [damage]);

  useEffect(() => {
    if (!drawing) return undefined;
    const timer = setTimeout(() => setDrawing(false), DRAW_FLASH_MS);
    return () => clearTimeout(timer);
  }, [drawing, drawTick]);

  useEffect(() => {
    if (selected === null || match === null || side === null) return;
    const now = sideData(match, side);
    if (!handOf(now).includes(selected) || emptyBoardSlot(now) === -1) setSelected(null);
  }, [match, side, selected]);

  useEffect(() => {
    const el = handRef.current;
    if (!el) return;
    el.scrollTo({ left: el.scrollWidth, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [hand.length]);

  useEffect(() => {
    if (awaitingBlock === null) return undefined;
    if (match?.status !== 'Active' || side === null || match.turn !== side || match.lastMoveBlock > awaitingBlock) {
      setAwaitingBlock(null);
      return undefined;
    }
    // The chain may be slow or the tx may have reverted: never trap the player behind a stale lock.
    const timer = setTimeout(() => setAwaitingBlock(null), 4000);
    return () => clearTimeout(timer);
  }, [awaitingBlock, match?.status, match?.turn, match?.lastMoveBlock, side]);

  const run = async (
    kind: Exclude<Busy, null>,
    action: () => Promise<void>,
    failure: string | ((err: unknown) => string),
  ) => {
    if (busy !== null) return;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(typeof failure === 'string' ? failure : failure(err));
    } finally {
      setBusy(null);
    }
  };

  const join = () => {
    if (!config || !match) return;
    void run(
      'join',
      async () => {
        const result = await joinBattle(config, match.id);
        if (result.status !== 'success') throw new Error('joinMatch reverted');
      },
      (err) =>
        err instanceof Error && err.message === 'joinMatch reverted'
          ? 'This match already started. Create a new one.'
          : toFriendly(err, { fn: 'joinMatch' }),
    );
  };

  const fightAgent = () => {
    if (!config || !match) return;
    void run(
      'agent',
      async () => {
        const result = await challengeBattleAgent(config, match.id);
        if (!result.ok) throw new Error(result.reason);
      },
      (err) =>
        err instanceof Error && err.message === 'not_open'
          ? "AI Agent couldn't join this room. Create a new one."
          : 'AI Agent is busy. Try again in a moment.',
    );
  };

  const act = (special: boolean) => {
    if (!config || !match || side === null || !myTurn) return;
    const handIdx = selectedCard !== null ? selectedCard.drawNo : NO_PLACE;
    void run(
      special ? 'special' : 'attack',
      async () => {
        const result = await actBattle(config, match.id, handIdx, special);
        if (result.status !== 'success') throw new Error('act reverted');
        setSelected(null);
        setAwaitingBlock(match.lastMoveBlock);
      },
      (err) =>
        err instanceof Error && err.message === 'act reverted'
          ? "That move didn't go through. The board may have changed. Try again."
          : toFriendly(err, { fn: 'act' }),
    );
  };

  const claim = () => {
    if (!config || !match) return;
    void run(
      'timeout',
      async () => {
        const result = await claimBattleTimeout(config, match.id);
        if (result.status !== 'success') throw new Error('claimTimeout reverted');
      },
      'The timeout window is still open.',
    );
  };

  if (!match) {
    if (state.unavailable) {
      return (
        <Centered title="Card Battle is not available" body="This deployment has no CardBattle contract yet.">
          <Link to="/battle" className="label text-ink-muted underline underline-offset-4">
            Back to Card Battle
          </Link>
        </Centered>
      );
    }
    if (state.missing) {
      return (
        <Centered title="Match not found" body="Check the link or create a new match.">
          <Link to="/battle" className="label text-ink-muted underline underline-offset-4">
            Back to Card Battle
          </Link>
        </Centered>
      );
    }
    return <Centered title="Loading match…" body="Reading the board from Monad." />;
  }

  if (match.status === 'Open') {
    return (
      <OpenRoom
        match={match}
        side={side}
        busy={busy === 'join' || busy === 'agent' ? busy : null}
        error={error}
        onJoin={join}
        onFightAgent={fightAgent}
      />
    );
  }

  if (match.status !== 'Active') {
    return <BattleResult match={match} side={side} config={config} />;
  }

  const banner =
    side === null
      ? { title: 'Spectating', sub: 'Both players are moving.', tone: 'neutral' as BannerTone }
      : myTurn
        ? { title: 'Your turn', sub: selectedCard ? 'Selected. Attack to place and strike.' : 'Draw, place, then strike.', tone: 'self' as BannerTone }
        : {
            title: "Opponent's turn",
            sub: isAgent ? 'AI Agent is choosing a move.' : 'Waiting for their move.',
            tone: 'opponent' as BannerTone,
          };

  const actionHint =
    awaitingBlock !== null
      ? 'Waiting for the chain…'
      : !myTurn
        ? 'Actions unlock on your turn.'
        : selectedCard
          ? 'Attack places the selected card, then every board card strikes.'
          : 'Attack draws one card and strikes with your board.';

  return (
    <main className="flex h-[100dvh] flex-col bg-surface text-ink">
      <div className="mx-auto flex h-full w-full max-w-[420px] flex-col border-x border-line bg-surface">
        <header className="border-b border-line px-4 pb-2 pt-3">
          <div className="flex items-center justify-between gap-3">
            <Link to="/battle" className="label text-ink-muted">
              ← Card Battle
            </Link>
            <span className="data text-ink-muted" aria-label={`${blocksLeft} blocks left in this turn`}>
              {clock}
            </span>
          </div>
          <div className="mt-1 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="label text-berry">{side === null ? 'P1' : 'Opponent'}</p>
              <h1 className="title truncate text-ink">{topName}</h1>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span className="label text-berry">{side === null ? 'P1' : isAgent ? 'AI' : 'Them'}</span>
                <ScoreDots filled={top?.score ?? 0} side="opponent" />
              </span>
              <span className="flex items-center gap-1.5">
                <span className="label text-purple-ink">{side === null ? 'P2' : 'You'}</span>
                <ScoreDots filled={bottom?.score ?? 0} side="self" />
              </span>
            </div>
          </div>
          <div className="mt-2 h-0.5 w-full bg-surface-sunken" aria-hidden="true">
            <div
              className="h-full bg-line"
              style={{ width: `${Math.min(100, (blocksLeft / TURN_TIMEOUT_BLOCKS) * 100)}%` }}
            />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <section className="relative px-4 pt-3" aria-label="Opponent board">
            <div className="flex items-stretch gap-2">
              <Pile count={top ? pileLeft(top) : 0} side="opponent" />
              <div className="grid flex-1 grid-cols-3 gap-2">
                {(top ? boardCards(top) : [null, null, null]).map((card, i) => (
                  <BoardCard
                    key={`top-${i}-${card?.drawNo ?? 'empty'}`}
                    card={card}
                    side="opponent"
                    target={card !== null && top !== null && frontSlot(top) === i}
                    slot={i}
                  />
                ))}
              </div>
            </div>
            {damage && damage.side === topSide && (
              <span
                key={damage.key}
                aria-hidden="true"
                className="dmg-float absolute right-8 top-4 z-20 font-mono text-lg font-semibold text-berry"
              >
                -{formatInt(damage.amount)}
              </span>
            )}
          </section>

          <section className="px-4 py-2" aria-live="polite">
            <div className={`flex items-center justify-between gap-3 rounded-card px-3 py-2 ${TONE_CLASS[banner.tone]}`}>
              <div className="min-w-0">
                <p className="title truncate">{banner.title}</p>
                <p className="label truncate opacity-80">{banner.sub}</p>
              </div>
              {advantage && <span className="label max-w-[96px] shrink-0 text-right">{advantage}</span>}
            </div>
          </section>

          <section className="relative px-4 pt-1" aria-label="Your board">
            <div className="flex items-stretch gap-2">
              <div className="grid flex-1 grid-cols-3 gap-2">
                {(bottom ? boardCards(bottom) : [null, null, null]).map((card, i) => (
                  <BoardCard
                    key={`bottom-${i}-${card?.drawNo ?? 'empty'}`}
                    card={card}
                    side="self"
                    target={card !== null && bottom !== null && frontSlot(bottom) === i}
                    slot={i}
                  />
                ))}
              </div>
              <Pile count={bottom ? pileLeft(bottom) : 0} side="self" />
            </div>
            {damage && damage.side === bottomSide && (
              <span
                key={damage.key}
                aria-hidden="true"
                className="dmg-float absolute left-8 top-3 z-20 font-mono text-lg font-semibold text-berry"
              >
                -{formatInt(damage.amount)}
              </span>
            )}
            {drawing && (
              <span
                key={`draw-${drawTick}`}
                aria-hidden="true"
                className="dmg-float absolute right-6 top-1 z-20 flex h-9 w-9 items-center justify-center rounded-chip border border-line bg-surface-raised text-[9px] font-semibold uppercase tracking-wider text-ink"
              >
                Draw
              </span>
            )}
          </section>

          <section className="mt-1 flex min-h-0 flex-col px-4 pb-2" aria-label="Your hand">
            <div className="flex items-center justify-between gap-3">
              <p className="label text-ink-muted">
                Your hand · {hand.length}
                {me ? ` · ${pileLeft(me)} left` : ''}
              </p>
              {drawing ? (
                <span role="status" className="label text-purple-ink">
                  Drawing…
                </span>
              ) : null}
            </div>
            <div ref={handRef} className="mt-2 flex gap-2 overflow-x-auto pb-2">
              {hand.length === 0 ? (
                <p className="body text-ink-muted">
                  {me && pileLeft(me) === 0 ? 'No cards left in this match.' : 'No cards in hand. Attack to draw.'}
                </p>
              ) : (
                hand.map((card) => (
                  <HandCard
                    key={card.drawNo}
                    card={card}
                    selected={selected === card.drawNo}
                    disabled={!myTurn || busy !== null || (me !== null && emptyBoardSlot(me) === -1)}
                    onSelect={() => {
                      if (!myTurn || busy !== null) return;
                      setSelected((current) => (current === card.drawNo ? null : card.drawNo));
                    }}
                  />
                ))
              )}
            </div>
          </section>
        </div>

        <footer className="mt-auto border-t border-line bg-surface px-4 pb-4 pt-3">
          {error && (
            <div className="mb-2">
              <Notice>{error}</Notice>
            </div>
          )}
          {canClaim && (
            <button
              type="button"
              onClick={claim}
              disabled={busy !== null}
              className="label mb-2 w-full rounded-card border border-berry px-4 py-3 text-berry [touch-action:manipulation] disabled:opacity-40"
            >
              Claim timeout
            </button>
          )}
          <div className="grid grid-cols-2 gap-3">
            <ActionButton
              label="Attack"
              amount={strike}
              tone="purple"
              disabled={!canAttack}
              busy={busy === 'attack'}
              busyLabel="Resolving…"
              ariaLabel={`Attack${strike > 0 ? `, ${strike} damage` : ''}`}
              onClick={() => act(false)}
            />
            <ActionButton
              label={specialUsed ? 'Special used' : 'Special'}
              amount={specialUsed ? 0 : specialPreview}
              tone="deep"
              disabled={!canSpecial || specialUsed}
              busy={busy === 'special'}
              busyLabel="Resolving…"
              ariaLabel={`Special${specialPreview > 0 ? `, ${specialPreview} damage, once per match` : ', once per match'}`}
              onClick={() => act(true)}
            />
          </div>
          <p className="data mt-2 text-center text-ink-muted">{actionHint}</p>
        </footer>
      </div>
    </main>
  );
}
