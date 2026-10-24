import { ELEMENTS, RARITIES, nadmonFor } from '@nad/shared';
import { z } from 'zod';
import { sanitizeText, withTimeout, type Llm } from '../llm';

/** On-chain card stats; `mintedAt` is the mint block number. */
export type CardData = {
  id: number;
  atk: number;
  hp: number;
  element: number;
  rarity: number;
  wins: number;
  losses: number;
  mintedAt: number;
};

/** `name` is always the Nadmon species name; only `title` and `lore` may come from an LLM. */
export type Lore = { name: string; title: string; lore: string; source: 'ai' | 'template' };

type Pool = { titles: readonly string[]; lore: readonly string[] };

/** Indexed by element: 0 Fire, 1 Water, 2 Lightning. Lore lines fit wrapText(lore, 44, 4). */
const POOLS: readonly Pool[] = [
  {
    titles: [
      'Ember of the Opening Block',
      'Keeper of the Last Spark',
      'Cinder Sovereign',
      'Wanderer of Ash Fields',
      "Forgemaster's Heir",
    ],
    lore: [
      'Born in the first heat of a fresh block, it burns brightest when the clock runs short. Rivals fear the quiet before its flame.',
      'It carries a single coal from the forge where every Nadmon began. Tap by tap the coal grows, until the arena glows warm.',
      'Ash follows wherever it walks. Smoke curls from its footprints, and the ground remembers every duel it has ever won.',
      'Quick to flare and slow to fade, it treats each duel as kindling for the next. Water is the one thing it respects.',
      'Old stories say the first fire learned to dance in a stone circle. This one still dances, and it does not like to lose.',
    ],
  },
  {
    titles: [
      'Tide Caller',
      'Warden of Deep Currents',
      'Mist Walker',
      'Keeper of the Quiet Depth',
      'Rain Bound Wanderer',
    ],
    lore: [
      'It listens to rivers that no map has named. When it strikes, the whole arena feels the pull of a patient, rising tide.',
      'Calm on the surface and relentless below, it wears rivals down one drop at a time. Fire hisses and steps back.',
      'Born where the rain meets the sea, it keeps every storm it has weathered. Lightning is the one guest it never invites.',
      'A ripple crosses the floor before it moves. By the time you notice, the current has already decided the duel.',
      'Deep water holds old secrets, and this one holds a great many. It shares them only with rivals who stay in the fight.',
    ],
  },
  {
    titles: [
      'Spark Runner',
      'Stormwire Duelist',
      'Herald of Thunder',
      'Keeper of the Static Hum',
      'Flash at the Edge of Dusk',
    ],
    lore: [
      'It moves faster than the sound it makes. Blink, and the duel has already turned in its favor, with thunder arriving late.',
      'Static gathers in its fur before every match. Each tap lets a little more loose, until the air itself starts to hum.',
      'Raised on storm fronts and open sky, it never stands still. Water slows it down; everything else simply watches it pass.',
      'A crackle on the wind, a flash on the horizon, a Nadmon that treats every second as a chance to strike twice.',
      'It was forged from a single bolt that refused to fade. Ever since, it has chased the next storm, and the next duel.',
    ],
  },
];

const TITLE_STRIDE = 1;
const LORE_STRIDE = 3;
const LORE_BLOCK = 5;

function pickIndex(n: number, length: number): number {
  return ((n % length) + length) % length;
}

/** Deterministic template lore: same card, same text. Title and lore use different derivations from `id`. */
export function fallbackLore(card: CardData): Lore {
  const pool = POOLS[card.element];
  if (!pool) throw new Error(`No lore pool for element ${card.element}`);
  const id = Math.floor(Math.abs(card.id));
  const title = pool.titles[pickIndex(id * TITLE_STRIDE, pool.titles.length)];
  const lore = pool.lore[pickIndex(id * LORE_STRIDE + Math.floor(id / LORE_BLOCK), pool.lore.length)];
  if (title === undefined || lore === undefined) throw new Error('Empty lore pool');
  return { name: nadmonFor(card.element, card.rarity).name, title, lore, source: 'template' };
}

const DEFAULT_LORE_TIMEOUT_MS = 4000;
const MAX_TITLE_CHARS = 40;
const MAX_LORE_CHARS = 170;
const BANNED_WORDS = /\b(?:bets?|betting|wagers?|wagering|gambl\w*)\b/i;

const loreReply = z.object({ title: z.string().max(MAX_TITLE_CHARS), lore: z.string().max(MAX_LORE_CHARS) });

const LORE_SYSTEM =
  'You write short collectible-card flavor text for Nadmon, small elemental creatures in a tap-duel card game. ' +
  'Reply with JSON only: {"title": string, "lore": string}. ' +
  `Write in English with a relaxed, confident tone. "title" is an epithet of at most ${MAX_TITLE_CHARS} characters. ` +
  `"lore" is one or two sentences of at most ${MAX_LORE_CHARS} characters. ` +
  'Never use the words bet, wager or gamble. No emoji, no real people, no real brands.';

function lorePrompt(card: CardData, name: string): string {
  return [
    `Nadmon: ${name}`,
    `Element: ${ELEMENTS[card.element]}`,
    `Rarity: ${RARITIES[card.rarity]}`,
    `ATK: ${card.atk}`,
    `HP: ${card.hp}`,
  ].join('\n');
}

/** Cleaned `{title, lore}` from an LLM reply, or null when nothing usable is left. */
function cleanReply(reply: z.infer<typeof loreReply>): { title: string; lore: string } | null {
  const title = sanitizeText(reply.title);
  const lore = sanitizeText(reply.lore);
  if (title === '' || lore === '' || BANNED_WORDS.test(`${title} ${lore}`)) return null;
  return { title, lore };
}

/**
 * AI lore for a freshly minted card. Never throws for LLM trouble: no LLM, timeout, HTTP error,
 * invalid JSON, over-long or unusable text all give the deterministic template. `name` is always the species.
 */
export async function forgeLore(card: CardData, llm: Llm | null, timeoutMs = DEFAULT_LORE_TIMEOUT_MS): Promise<Lore> {
  const template = fallbackLore(card);
  if (!llm) return template;
  try {
    const reply = await withTimeout(llm.json(LORE_SYSTEM, lorePrompt(card, template.name), loreReply, timeoutMs), timeoutMs);
    const cleaned = cleanReply(reply);
    return cleaned ? { name: template.name, ...cleaned, source: 'ai' } : template;
  } catch {
    return template;
  }
}
