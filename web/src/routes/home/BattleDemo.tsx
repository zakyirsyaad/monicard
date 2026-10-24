import './home.css';

const SLOTS = [6, 36, 66] as const;
const SLOT = 'absolute w-[28%] aspect-[240/150] rounded-chip border border-line bg-surface-sunken';
const CARD = 'absolute block w-[28%] h-auto rounded-chip border-2 bg-surface-sunken';

/** Looping mini battle: draw, place, strike, super effective, KO. Pure CSS; Infernad (Fire) beats Voltnad (Lightning). */
export function BattleDemo() {
  return (
    <div
      className="demo-loop relative mx-auto aspect-square w-full max-w-[420px] overflow-hidden rounded-card border border-line bg-surface-raised"
      role="img"
      aria-label="Animated match: Infernad is drawn, placed on the board and knocks out Voltnad with a super effective strike."
    >
      {SLOTS.map((left) => (
        <span key={`o${left}`} className={SLOT} style={{ left: `${left}%`, top: '6%' }} aria-hidden="true" />
      ))}
      {SLOTS.map((left) => (
        <span key={`p${left}`} className={SLOT} style={{ left: `${left}%`, top: '38%' }} aria-hidden="true" />
      ))}

      <span className="absolute left-0 right-0 top-[33%] h-px bg-line" aria-hidden="true" />

      {/* Opponent front card */}
      <div className="demo-hit absolute w-[28%]" style={{ left: '36%', top: '6%' }}>
        <img src="/nadmon/voltnad.svg" alt="" className="block h-auto w-full rounded-chip border-2 border-berry bg-surface-sunken" />
      </div>
      <span
        className="demo-dmg data-lg absolute text-berry opacity-0"
        style={{ left: '44%', top: '10%' }}
        aria-hidden="true"
      >
        −420
      </span>
      <span
        className="demo-eff label absolute rounded-chip bg-berry-tint px-2 py-1 text-berry"
        style={{ left: '28%', top: '29%' }}
        aria-hidden="true"
      >
        Super effective ×1.5
      </span>
      <span
        className="demo-ko data-lg absolute rounded-chip bg-berry px-2 text-on-deep"
        style={{ left: '46%', top: '14%' }}
        aria-hidden="true"
      >
        KO
      </span>

      {/* Player card: deck to hand to slot, then strikes */}
      <div className="demo-fly absolute w-[28%]" style={{ left: '36%', top: '38%' }}>
        <div className="demo-lunge">
          <img src="/nadmon/infernad.svg" alt="" className={`${CARD} static w-full border-purple`} />
        </div>
      </div>

      {/* Hand: deck of card backs plus two held cards */}
      <div className="absolute flex w-[28%] items-center justify-center rounded-chip border-2 border-deep bg-deep aspect-[240/150]" style={{ left: '6%', top: '72%' }} aria-hidden="true">
        <span className="label text-on-deep">Monicard</span>
      </div>
      <img src="/nadmon/sparkit.svg" alt="" className={`${CARD} border-line`} style={{ left: '36%', top: '72%' }} aria-hidden="true" />
      <img src="/nadmon/dripnad.svg" alt="" className={`${CARD} border-line`} style={{ left: '66%', top: '72%' }} aria-hidden="true" />
    </div>
  );
}
