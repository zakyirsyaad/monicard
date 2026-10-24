import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELEMENTS, NADMON, RARITIES, nadmonFor, strongAgainst, weakTo } from '@nad/shared';
import type { CardData, Lore } from './lore';

// ---------------------------------------------------------------- tokens

export type Theme = 'light' | 'dark';
type TokenValue = string | { light: string; dark: string };
export type Tokens = { color: { tokens: { name: string; value: TokenValue }[] } };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DESIGN_SYSTEM = join(REPO_ROOT, 'docs/design-system');
const HEX = /^#[0-9a-f]{6}$/;
const ALIAS = /^\{([^}]+)\}$/;

let tokensCache: Tokens | undefined;

/** Reads docs/design-system/tokens.json once. */
export function loadTokens(): Tokens {
  tokensCache ??= JSON.parse(readFileSync(join(DESIGN_SYSTEM, 'tokens.json'), 'utf8')) as Tokens;
  return tokensCache;
}

function resolveChain(tokens: Tokens, name: string, theme: Theme, seen: readonly string[]): string {
  if (seen.includes(name)) throw new Error(`Token alias cycle: ${[...seen, name].join(' -> ')}`);
  const token = tokens.color.tokens.find((t) => t.name === name);
  if (!token) throw new Error(`Unknown token: ${name}`);
  const raw = typeof token.value === 'string' ? token.value : token.value[theme];
  const alias = ALIAS.exec(raw);
  if (alias?.[1]) return resolveChain(tokens, alias[1], theme, [...seen, name]);
  const hex = raw.toLowerCase();
  if (!HEX.test(hex)) throw new Error(`Token ${name} does not resolve to a #rrggbb color: ${raw}`);
  return hex;
}

/** Resolves a color token (following `{alias}` chains) to a lowercase `#rrggbb`. */
export function resolveTokenHex(tokens: Tokens, name: string, theme: Theme = 'light'): string {
  return resolveChain(tokens, name, theme, []);
}

// ------------------------------------------------------------ text helpers

const ELLIPSIS = '…';

/** Splits words longer than `maxChars` into full-width chunks. */
function splitLongWords(words: readonly string[], maxChars: number): string[] {
  return words.flatMap((word) => {
    const chunks: string[] = [];
    for (let i = 0; i < word.length; i += maxChars) chunks.push(word.slice(i, i + maxChars));
    return chunks.length > 0 ? chunks : [word];
  });
}

function greedyLines(words: readonly string[], maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= maxChars) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function withEllipsis(line: string, maxChars: number): string {
  const room = line.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return `${room}${ELLIPSIS}`;
}

/**
 * Breaks `text` at spaces into at most `maxLines` lines of at most `maxChars` characters.
 * A word longer than `maxChars` is hard-cut. When text is dropped the last line ends with "…".
 * (The tail chunk of a hard-cut word may still share a line with following words.)
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = splitLongWords(text.split(/\s+/).filter(Boolean), maxChars);
  const lines = greedyLines(words, maxChars);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[kept.length - 1] ?? '';
  return [...kept.slice(0, -1), withEllipsis(last, maxChars)];
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

// ----------------------------------------------------------------- nadmon

const nadmonCache = new Map<string, string>();

/** Content of a Nadmon svg strictly between its root `<svg …>` tag and the final `</svg>`. */
export function nadmonInner(id: string): string {
  if (!NADMON.some((n) => n.id === id)) throw new Error(`Unknown Nadmon id: ${id}`);
  const cached = nadmonCache.get(id);
  if (cached !== undefined) return cached;
  const source = readFileSync(join(DESIGN_SYSTEM, 'assets/Nadmon', `${id}.svg`), 'utf8');
  const open = /<svg\b[^>]*>/.exec(source);
  const close = source.lastIndexOf('</svg>');
  if (!open || close < open.index + open[0].length) throw new Error(`Malformed Nadmon svg: ${id}`);
  const inner = source.slice(open.index + open[0].length, close).trim();
  nadmonCache.set(id, inner);
  return inner;
}

// ------------------------------------------------------------------- card

const SANS = `'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif`;
const MONO = `'JetBrains Mono', Menlo, monospace`;
const RARITY_SYMBOLS = ['●', '◆', '◆◆', '★'] as const;
const CARD_WIDTH = 300;
const CARD_HEIGHT = 560;
const GUTTER = 12;
const INNER_LEFT = 16;
const INNER_RIGHT = CARD_WIDTH - INNER_LEFT;
const META_MAX_CHARS = 48;
const LORE_MAX_CHARS = 44;
const LORE_MAX_LINES = 4;
const TITLE_MAX_CHARS = 36;
const CHIP_CHAR_WIDTH = 7;
const CHIP_PADDING = 14;

type Palette = Record<
  | 'surfaceRaised' | 'line' | 'ink' | 'inkMuted' | 'purpleTint' | 'purpleInk'
  | 'rarity' | 'element' | 'legendary',
  string
>;

type TextStyle = {
  size: number;
  weight?: number;
  fill: string;
  mono?: boolean;
  anchor?: 'start' | 'middle' | 'end';
  spacing?: string;
};

const num = (n: number): string => n.toLocaleString('en-US');

function buildPalette(card: CardData): Palette {
  const tokens = loadTokens();
  const hex = (name: string): string => resolveTokenHex(tokens, name);
  const element = ELEMENTS[card.element];
  const rarity = RARITIES[card.rarity];
  if (!element || !rarity) throw new Error(`Invalid card element ${card.element} / rarity ${card.rarity}`);
  return {
    surfaceRaised: hex('surface-raised'),
    line: hex('line'),
    ink: hex('ink'),
    inkMuted: hex('ink-muted'),
    purpleTint: hex('purple-tint'),
    purpleInk: hex('purple-ink'),
    rarity: hex(`rarity-${rarity.toLowerCase()}`),
    element: hex(`element-${element.toLowerCase()}`),
    legendary: hex('rarity-legendary'),
  };
}

function text(x: number, y: number, content: string, s: TextStyle): string {
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${s.mono ? MONO : SANS}"`,
    `font-size="${s.size}"`,
    `font-weight="${s.weight ?? 400}"`,
    `fill="${s.fill}"`,
  ];
  if (s.anchor) attrs.push(`text-anchor="${s.anchor}"`);
  if (s.spacing) attrs.push(`letter-spacing="${s.spacing}"`);
  return `<text ${attrs.join(' ')}>${escapeXml(content)}</text>`;
}

function chip(x: number, label: string, color: string, p: Palette): { svg: string; width: number } {
  const width = Math.round(label.length * CHIP_CHAR_WIDTH + CHIP_PADDING);
  const svg =
    `<rect x="${x}" y="62" width="${width}" height="18" rx="8" fill="${p.purpleTint}"/>` +
    text(x + width / 2, 75, label, { size: 10, weight: 600, fill: color, anchor: 'middle', spacing: '.06em' });
  return { svg, width };
}

function header(card: CardData, name: string, stage: number, p: Palette): string {
  return [
    text(INNER_LEFT, 26, `STAGE ${stage}`, { size: 10, weight: 600, fill: p.inkMuted, spacing: '.06em' }),
    text(INNER_LEFT, 52, name, { size: 24, weight: 800, fill: p.ink }),
    text(INNER_RIGHT, 52, `HP ${num(card.hp)}`, { size: 13, weight: 600, fill: p.ink, mono: true, anchor: 'end' }),
  ].join('');
}

function chips(card: CardData, p: Palette): string {
  const element = chip(INNER_LEFT, (ELEMENTS[card.element] ?? '').toUpperCase(), p.element, p);
  const rarity = chip(INNER_LEFT + element.width + 6, (RARITIES[card.rarity] ?? '').toUpperCase(), p.purpleInk, p);
  return element.svg + rarity.svg;
}

function imageWindow(nadmonId: string, p: Palette): string {
  return (
    `<clipPath id="art"><rect x="${GUTTER}" y="88" width="276" height="172" rx="8"/></clipPath>` +
    `<g clip-path="url(#art)"><svg x="12" y="88" width="276" height="172" viewBox="0 0 240 150">${nadmonInner(nadmonId)}</svg></g>` +
    `<rect x="${GUTTER}" y="88" width="276" height="172" rx="8" fill="none" stroke="${p.element}" stroke-width="2"/>`
  );
}

function metaLine(card: CardData, evolvesFromName: string | null): string {
  const form = evolvesFromName ? `from ${evolvesFromName}` : 'basic';
  const line = `${ELEMENTS[card.element]} · ${form} · Block #${num(card.mintedAt)}`;
  return wrapText(line, META_MAX_CHARS, 1)[0] ?? '';
}

function attackRow(top: number, name: string, value: string, note: string, p: Palette): string {
  return [
    `<line x1="${GUTTER}" y1="${top}" x2="${CARD_WIDTH - GUTTER}" y2="${top}" stroke="${p.line}" stroke-width="1"/>`,
    text(INNER_LEFT, top + 21, name, { size: 15, weight: 600, fill: p.ink }),
    text(INNER_RIGHT, top + 21, value, { size: 18, weight: 600, fill: p.ink, mono: true, anchor: 'end' }),
    text(INNER_LEFT, top + 38, note, { size: 11, fill: p.inkMuted }),
  ].join('');
}

function attacks(card: CardData, p: Palette): string {
  const strong = strongAgainst(card.element);
  return (
    attackRow(290, 'Tap', num(card.atk), `Damage per tap. ×1.5 vs ${ELEMENTS[strong]}.`, p) +
    attackRow(335, 'Last stand', `${num(card.atk * 10)}–${num(card.atk * 50)}`, 'Once per duel, at neutral element.', p)
  );
}

function column(x: number, label: string, value: string, p: Palette): string {
  return (
    text(x, 404, label, { size: 10, fill: p.inkMuted }) +
    text(x, 420, value, { size: 12, weight: 600, fill: p.ink })
  );
}

function matchupRow(card: CardData, p: Palette): string {
  return [
    `<line x1="${GUTTER}" y1="390" x2="${CARD_WIDTH - GUTTER}" y2="390" stroke="${p.line}" stroke-width="1"/>`,
    column(INNER_LEFT, 'Strong vs', ELEMENTS[strongAgainst(card.element)], p),
    column(112, 'Weak to', ELEMENTS[weakTo(card.element)], p),
    column(204, 'Record', `${card.wins} W · ${card.losses} L`, p),
  ].join('');
}

function flavorBox(lore: Lore, status: 'ready' | 'forging', p: Palette): string {
  const title = status === 'forging' ? 'Forging lore…' : (wrapText(lore.title, TITLE_MAX_CHARS, 1)[0] ?? '');
  const lines = status === 'forging' ? [] : wrapText(lore.lore, LORE_MAX_CHARS, LORE_MAX_LINES);
  return [
    `<rect x="${GUTTER}" y="434" width="276" height="92" rx="8" fill="none" stroke="${p.line}" stroke-width="1"/>`,
    text(24, 454, title, { size: 12, weight: 600, fill: p.ink }),
    ...lines.map((line, i) => text(24, 472 + i * 14, line, { size: 11, fill: p.inkMuted })),
  ].join('');
}

function footer(card: CardData, p: Palette): string {
  const symbol = RARITY_SYMBOLS[card.rarity] ?? '';
  const symbolFill = card.rarity === 3 ? p.legendary : p.inkMuted;
  return (
    text(INNER_LEFT, 548, `Blitz Jogja · ${card.id}`, { size: 10, fill: p.inkMuted, mono: true }) +
    text(INNER_RIGHT, 548, symbol, { size: 10, fill: symbolFill, mono: true, anchor: 'end' })
  );
}

function frame(p: Palette): string {
  return `<rect x="1.5" y="1.5" width="${CARD_WIDTH - 3}" height="${CARD_HEIGHT - 3}" rx="14" fill="${p.surfaceRaised}" stroke="${p.rarity}" stroke-width="3"/>`;
}

/** Full 300 × 560 TCG card, light theme. `forging` replaces the lore with a placeholder. */
export function cardSvg(card: CardData, lore: Lore, status: 'ready' | 'forging' = 'ready'): string {
  const p = buildPalette(card);
  const species = nadmonFor(card.element, card.rarity);
  const from = species.evolvesFrom ? (NADMON.find((n) => n.id === species.evolvesFrom)?.name ?? null) : null;
  const body = [
    frame(p),
    header(card, lore.name, species.stage, p),
    chips(card, p),
    imageWindow(species.id, p),
    text(CARD_WIDTH / 2, 278, metaLine(card, from), { size: 10, fill: p.inkMuted, anchor: 'middle' }),
    attacks(card, p),
    matchupRow(card, p),
    flavorBox(lore, status, p),
    footer(card, p),
  ];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">` +
    `<title>${escapeXml(lore.name)}</title>${body.join('')}</svg>`
  );
}
