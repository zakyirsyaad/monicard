import { RARITIES } from '../lib/game';

const TITLES: readonly (readonly [string, string, string, string])[] = [
  ['Spark Keeper', 'Ember Warden', 'Blaze Sovereign', 'Inferno Monarch'],
  ['Tide Drifter', 'Current Sentinel', 'Torrent Sovereign', 'Abyss Monarch'],
  ['Static Scout', 'Arc Warden', 'Storm Sovereign', 'Tempest Monarch'],
];

const LORE: readonly string[] = [
  '{name} was forged in a burst of heat at block #{block}. Its flame never flickers, even under pressure.',
  '{name} surfaced from a deep current at block #{block}. It waits patiently, then strikes all at once.',
  '{name} crackled to life at block #{block}. Every tap it takes only charges it further.',
];

export type CardText = { title: string; lore: string };

/** Deterministic English template text for a mock card. */
export function cardText(
  name: string,
  element: number,
  rarity: number,
  mintedAt: number,
): CardText {
  const titles = TITLES[element] ?? TITLES[0]!;
  const rarityLabel = RARITIES[rarity] ?? RARITIES[0];
  const title = titles[rarity] ?? titles[0];
  const lore = (LORE[element] ?? LORE[0]!)
    .replace('{name}', name)
    .replace('{block}', mintedAt.toLocaleString('en-US'));
  return { title: `${title} (${rarityLabel})`, lore };
}

const LESSON_LOSS = 'Held the skill too long. Firing earlier next time.';
const LESSON_WIN = 'Won with room to spare. Holding the skill a little longer next time.';

export const AGENT_LESSON_TEXT = { loss: LESSON_LOSS, win: LESSON_WIN } as const;
