// Facade for @nad/shared game rules: web code imports formulas/constants only from here.
// Implements the frozen Task 4 interface locally until it lands, then becomes a re-export.
export type { DuelStatus, DuelView } from './types';

export const COUNTDOWN_BLOCKS = 10;
export const DUEL_BLOCKS = 67;
export const MAX_TAPS_PER_BLOCK = 3;
export const MAX_TAPS_PER_TX = 30;

export const ELEMENTS = ['Fire', 'Water', 'Lightning'] as const;
export const RARITIES = ['Common', 'Rare', 'Epic', 'Legendary'] as const;
export const RARITY_ODDS = [60, 28, 10, 2] as const;

export type Element = 0 | 1 | 2;

export type Nadmon = {
  id: string;
  name: string;
  element: Element;
  stage: 1 | 2 | 3;
  evolvesFrom: string | null;
};

export const NADMON: readonly Nadmon[] = [
  { id: 'embrit', name: 'Embrit', element: 0, stage: 1, evolvesFrom: null },
  { id: 'blazenad', name: 'Blazenad', element: 0, stage: 2, evolvesFrom: 'embrit' },
  { id: 'infernad', name: 'Infernad', element: 0, stage: 3, evolvesFrom: 'blazenad' },
  { id: 'dripnad', name: 'Dripnad', element: 1, stage: 1, evolvesFrom: null },
  { id: 'wavenad', name: 'Wavenad', element: 1, stage: 2, evolvesFrom: 'dripnad' },
  { id: 'abyssnad', name: 'Abyssnad', element: 1, stage: 3, evolvesFrom: 'wavenad' },
  { id: 'sparkit', name: 'Sparkit', element: 2, stage: 1, evolvesFrom: null },
  { id: 'voltnad', name: 'Voltnad', element: 2, stage: 2, evolvesFrom: 'sparkit' },
  { id: 'tempestnad', name: 'Tempestnad', element: 2, stage: 3, evolvesFrom: 'voltnad' },
];

/** Attacker `a` beats defender `d` iff `(d + 1) % 3 == a`. */
export function elementMult(attacker: number, defender: number): 150 | 100 | 75 {
  if (attacker === defender) return 100;
  return (defender + 1) % 3 === attacker ? 150 : 75;
}

/** The element this one beats. */
export function strongAgainst(element: number): Element {
  return ((element + 2) % 3) as Element;
}

/** The element that beats this one. */
export function weakTo(element: number): Element {
  return ((element + 1) % 3) as Element;
}

export function allowedTaps(requested: number, blocksElapsed: number): number {
  const cap = Math.min(requested, blocksElapsed * MAX_TAPS_PER_BLOCK, MAX_TAPS_PER_TX);
  return Math.max(0, cap);
}

export function tapDamage(taps: number, atk: number, mult: number): number {
  return Math.floor((taps * atk * mult) / 100);
}

export function skillDamage(atk: number, mult: number, hp: number, maxHp: number): number {
  return Math.floor((atk * mult * (10 * maxHp + 40 * (maxHp - hp))) / (100 * maxHp));
}

function stageForRarity(rarity: number): 1 | 2 | 3 {
  if (rarity >= 3) return 3;
  return rarity === 2 ? 2 : 1;
}

export function nadmonFor(element: number, rarity: number): Nadmon {
  const stage = stageForRarity(rarity);
  const found = NADMON.find((n) => n.element === element && n.stage === stage);
  if (!found) throw new Error(`No Nadmon for element ${element}, rarity ${rarity}`);
  return found;
}
