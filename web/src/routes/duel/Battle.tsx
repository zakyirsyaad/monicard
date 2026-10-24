import { useEffect, useRef, useState } from 'react';
import { HpBar } from '../../components/HpBar';
import { LatencyBadge } from '../../components/LatencyBadge';
import { Notice } from '../../components/Notice';
import { SkillButton } from '../../components/SkillButton';
import { TapButton } from '../../components/TapButton';
import { countdownSeconds, otherSide, secondsLeft, sideStats } from '../../lib/duelView';
import type { Side } from '../../lib/duelView';
import { formatInt } from '../../lib/format';
import { skillDamage, tapDamage } from '../../lib/game';
import { prefersReducedMotion } from '../../lib/motion';
import type { DuelView } from '../../lib/types';
import { CardSlot } from './CardSlot';
import type { DuelEngine } from './useDuelEngine';

const SHAKE_MS = 240;
const PANEL = 'mx-auto flex min-h-[100dvh] max-w-[420px] flex-col gap-4 px-4 py-4';

type Floater = { key: number; value: number };

export interface BattleProps {
  duel: DuelView;
  block: number;
  side: Side;
  countdown: boolean;
  duelEngine: DuelEngine;
  opponentName: string;
  taunt: string | null;
}

/** Rising "+dmg" numbers above the opponent bar; each removes itself when its animation ends. */
function useFloaters(): [Floater[], (value: number) => void, (key: number) => void] {
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const nextKey = useRef(0);
  const add = (value: number) => {
    if (prefersReducedMotion()) return;
    nextKey.current += 1;
    const key = nextKey.current;
    setFloaters((list) => [...list, { key, value }]);
  };
  const remove = (key: number) => setFloaters((list) => list.filter((f) => f.key !== key));
  return [floaters, add, remove];
}

/** Skill-only screen shake of the duel panel (never per tap); skipped under reduced motion. */
function useShake(): [boolean, () => void] {
  const [shaking, setShaking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shake = () => {
    if (prefersReducedMotion()) return;
    setShaking(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShaking(false), SHAKE_MS);
  };
  return [shaking, shake];
}

/** Engine error, floating over the top so the duel layout does not jump. Outside the shaking panel. */
function ErrorToast({ text }: { text: string }) {
  return (
    <div className="fixed inset-x-4 top-4 z-10 mx-auto max-w-[388px]">
      <Notice>{text}</Notice>
    </div>
  );
}

type OpponentPanelProps = {
  name: string;
  hp: number;
  maxHp: number;
  pendingDamage: number;
  floaters: Floater[];
  onFloaterDone: (key: number) => void;
  taunt: string | null;
};

/** Opponent HP bar with the rising damage numbers above it and the optional taunt bubble below. */
function OpponentPanel({ name, hp, maxHp, pendingDamage, floaters, onFloaterDone, taunt }: OpponentPanelProps) {
  return (
    <section className="relative">
      <div aria-hidden="true" className="absolute -top-6 right-0 h-0">
        {floaters.map((f) => (
          <span
            key={f.key}
            className="dmg-float data-lg absolute right-0 top-0 text-berry"
            onAnimationEnd={() => onFloaterDone(f.key)}
          >
            +{formatInt(f.value)}
          </span>
        ))}
      </div>
      <HpBar side="opponent" name={name} hp={hp} maxHp={maxHp} pendingDamage={pendingDamage} />
      {taunt && <p className="body mt-2 rounded-card border border-line bg-surface-raised px-3 py-2 text-ink">{taunt}</p>}
    </section>
  );
}

export function Battle({ duel, block, side, countdown, duelEngine, opponentName, taunt }: BattleProps) {
  const [floaters, addFloater, removeFloater] = useFloaters();
  const [shaking, shake] = useShake();
  const me = sideStats(duel, side);
  const opp = sideStats(duel, otherSide(side));
  const { engine, latencyMs, skillRequested, error, stats } = duelEngine;
  const pendingDamage = engine ? engine.pendingDamageEstimate(me.atk, me.mult, me.hp, me.maxHp) : 0;
  const skillUsed = me.skillUsed || skillRequested;
  const skillDmg = skillDamage(me.atk, me.mult, me.hp, me.maxHp);
  const seconds = secondsLeft(duel.endBlock, Math.max(block, duel.startBlock));
  const startsIn = countdownSeconds(duel.startBlock, block);

  const onTap = () => {
    duelEngine.tap();
    addFloater(tapDamage(1, me.atk, me.mult));
  };

  // Shake only when this press actually requested the skill; never per tap.
  const onSkill = () => {
    if (duelEngine.requestSkill()) shake();
  };

  return (
    <main className="min-h-[100dvh] overflow-hidden bg-surface text-ink">
      {error && <ErrorToast text={error} />}
      <div className={`${PANEL} ${shaking ? 'skill-shake' : ''}`}>
        <div className="flex items-center justify-between gap-3">
          <LatencyBadge block={block} latencyMs={latencyMs} txHash={stats?.lastTxHash ?? null} />
          <span className="data text-ink-muted">{seconds}s</span>
        </div>
        <OpponentPanel
          name={opponentName}
          hp={opp.hp}
          maxHp={opp.maxHp}
          pendingDamage={pendingDamage}
          floaters={floaters}
          onFloaterDone={removeFloater}
          taunt={taunt}
        />
        <div className="flex flex-col gap-2">
          <CardSlot id={String(opp.card)} />
          <CardSlot id={String(me.card)} />
        </div>
        <HpBar side="self" name="You" hp={me.hp} maxHp={me.maxHp} pendingDamage={0} />
        <div className="mt-auto flex flex-col gap-3">
          <SkillButton damage={skillDmg} used={skillUsed} disabled={countdown} onUse={onSkill} />
          <TapButton state={countdown ? 'countdown' : 'active'} countdown={startsIn} onTap={onTap} />
        </div>
      </div>
    </main>
  );
}
