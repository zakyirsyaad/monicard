import type { Element } from './constants';

export type Nadmon = {
  id: string;
  name: string;
  element: Element;
  stage: 1 | 2 | 3;
  evolvesFrom: string | null;
};

/** The nine Nadmon, matching docs/design-system/assets/Nadmon/README.md. `id` is the svg filename. */
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

function stageForRarity(rarity: number): 1 | 2 | 3 {
  if (rarity >= 3) return 3;
  return rarity === 2 ? 2 : 1;
}

/** Common and Rare are stage 1, Epic stage 2, Legendary stage 3. */
export function nadmonFor(element: number, rarity: number): Nadmon {
  const stage = stageForRarity(rarity);
  const found = NADMON.find((n) => n.element === element && n.stage === stage);
  if (!found) throw new Error(`No Nadmon for element ${element}, rarity ${rarity}`);
  return found;
}
