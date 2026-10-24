import { MAX_TAPS_PER_BLOCK, MAX_TAPS_PER_TX, type Element } from './constants';

/** Attacker `attacker` beats defender `defender` iff `(defender + 1) % 3 === attacker`. */
export function elementMult(attacker: number, defender: number): 150 | 100 | 75 {
  if ((defender + 1) % 3 === attacker) return 150;
  if (attacker === defender) return 100;
  return 75;
}

/** The element that `element` beats. */
export function strongAgainst(element: number): Element {
  return ((element + 2) % 3) as Element;
}

/** The element that beats `element`. */
export function weakTo(element: number): Element {
  return ((element + 1) % 3) as Element;
}

/** Taps the contract will credit: min(requested, blocksElapsed * 3, 30), never negative. */
export function allowedTaps(requested: number, blocksElapsed: number): number {
  return Math.max(0, Math.min(requested, blocksElapsed * MAX_TAPS_PER_BLOCK, MAX_TAPS_PER_TX));
}

/** Integer damage from `taps` taps; floors like Solidity division. */
export function tapDamage(taps: number, atk: number, mult: number): number {
  return Math.floor((taps * atk * mult) / 100);
}

/** Skill damage: 10% of ATK base, up to 50% when the target is nearly dead. */
export function skillDamage(atk: number, mult: number, hp: number, maxHp: number): number {
  const missing = Math.max(0, maxHp - hp);
  return Math.floor((atk * mult * (10 * maxHp + 40 * missing)) / (100 * maxHp));
}
