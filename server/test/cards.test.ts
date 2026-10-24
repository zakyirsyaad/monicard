import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { ELEMENTS, NADMON, nadmonFor } from '@nad/shared';
import { fallbackLore, type CardData, type Lore } from '../src/cards/lore';
import { createCardStore } from '../src/cards/store';
import {
  cardSvg,
  escapeXml,
  loadTokens,
  nadmonInner,
  resolveTokenHex,
  wrapText,
} from '../src/cards/svg';

const tmpDirs: string[] = [];
const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nad-cards-'));
  tmpDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const card = (overrides: Partial<CardData> = {}): CardData => ({
  id: 204,
  atk: 12,
  hp: 1950,
  element: 2,
  rarity: 1,
  wins: 12,
  losses: 4,
  mintedAt: 73_562_481,
  ...overrides,
});

const lore = (overrides: Partial<Lore> = {}): Lore => ({
  name: 'Sparkit',
  title: 'Rider of the Blitz',
  lore: 'Never waits for the next block.',
  source: 'template',
  ...overrides,
});

describe('fallbackLore', () => {
  test('is deterministic per card', () => {
    expect(fallbackLore(card())).toEqual(fallbackLore(card()));
  });

  test('differs across ids for at least some cards', () => {
    const lores = new Set<string>();
    const titles = new Set<string>();
    for (let id = 0; id < 20; id++) {
      const l = fallbackLore(card({ id }));
      lores.add(l.lore);
      titles.add(l.title);
    }
    expect(lores.size).toBeGreaterThanOrEqual(4);
    expect(titles.size).toBeGreaterThanOrEqual(4);
  });

  test('title and lore do not always pair the same way', () => {
    const pairs = new Set<string>();
    for (let id = 0; id < 60; id++) {
      const l = fallbackLore(card({ id }));
      pairs.add(`${l.title}|${l.lore}`);
    }
    expect(pairs.size).toBeGreaterThan(5);
  });

  test('name is the Nadmon name and source is template', () => {
    const l = fallbackLore(card({ element: 0, rarity: 3 }));
    expect(l.name).toBe(nadmonFor(0, 3).name);
    expect(l.source).toBe('template');
  });

  test('every element and id yields wrap-safe English text without banned words', () => {
    for (let element = 0; element < 3; element++) {
      for (let id = 0; id < 40; id++) {
        const l = fallbackLore(card({ id, element }));
        expect(l.lore.length).toBeLessThanOrEqual(175);
        expect(wrapText(l.lore, 44, 4).join(' ')).not.toContain('…');
        expect(l.title.length).toBeLessThanOrEqual(36);
        expect(`${l.title} ${l.lore}`).not.toMatch(/\bbet\b|bets|wager|gambl/i);
        expect(`${l.title} ${l.lore}`).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u);
      }
    }
  });
});

describe('resolveTokenHex', () => {
  const tokens = loadTokens();

  test('resolves rarity and alias tokens to lowercase hex', () => {
    expect(resolveTokenHex(tokens, 'rarity-epic')).toBe('#200052');
    expect(resolveTokenHex(tokens, 'focus')).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('supports the dark theme', () => {
    expect(resolveTokenHex(tokens, 'surface', 'dark')).toBe('#0e100f');
    expect(resolveTokenHex(tokens, 'surface')).toBe('#fbfaf9');
  });

  test('throws on unknown names and alias cycles', () => {
    expect(() => resolveTokenHex(tokens, 'nope')).toThrow(/unknown/i);
    const cyclic = {
      color: {
        tokens: [
          { name: 'a', value: '{b}' },
          { name: 'b', value: '{a}' },
        ],
      },
    };
    expect(() => resolveTokenHex(cyclic, 'a')).toThrow(/cycle/i);
  });
});

describe('wrapText', () => {
  test('wraps at spaces within maxChars', () => {
    const lines = wrapText('one two three four five six seven', 10, 4);
    expect(lines).toEqual(['one two', 'three four', 'five six', 'seven']);
  });

  test('truncates to maxLines with an ellipsis inside maxChars', () => {
    const text = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore';
    const lines = wrapText(text, 20, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
  });

  test('ellipsis stays within maxChars even when the last line is full', () => {
    const lines = wrapText('aaaaaaaaaa bbbbbbbbbb cccccccccc', 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toHaveLength(10);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });

  test('hard-cuts a single word longer than maxChars', () => {
    expect(wrapText('abcdefghijkl', 5, 4)).toEqual(['abcde', 'fghij', 'kl']);
  });

  test('does not truncate text that fits and handles empty input', () => {
    expect(wrapText('short text', 44, 4)).toEqual(['short text']);
    expect(wrapText('', 44, 4)).toEqual([]);
  });

  test('wraps a long lore to at most 4 lines', () => {
    const long = 'word '.repeat(80).trim();
    const lines = wrapText(long, 44, 4);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.at(-1)!.endsWith('…')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(44);
  });
});

describe('escapeXml', () => {
  test('escapes the five XML specials', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
});

describe('nadmonInner', () => {
  test('returns content between the root tags for every Nadmon', () => {
    for (const n of NADMON) {
      const inner = nadmonInner(n.id);
      expect(inner.length).toBeGreaterThan(50);
      expect(inner).not.toMatch(/<svg\b/);
      expect(inner).not.toContain('</svg>');
    }
  });

  test('rejects an unknown id and path traversal', () => {
    expect(() => nadmonInner('unknown')).toThrow(/unknown/i);
    expect(() => nadmonInner('../../../package')).toThrow(/unknown/i);
  });
});

describe('cardSvg', () => {
  const xmllintOk = (svg: string): void => {
    const file = join(makeTmp(), 'card.svg');
    writeFileSync(file, svg, 'utf8');
    execFileSync('xmllint', ['--noout', file]);
  };

  test('is valid XML with a single root width and a nested nadmon viewBox, even with & and < in lore', () => {
    const svg = cardSvg(card(), lore({ title: 'Fish & Chips <3', lore: 'Tom & Jerry <script>"x"</script> \'y\'' }));
    xmllintOk(svg);
    expect(svg.match(/width="300"/g)).toHaveLength(1);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 300 560"');
    expect(svg).toContain('<svg x="12" y="88" width="276" height="172" viewBox="0 0 240 150">');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('Tom &amp; Jerry &lt;script&gt;');
  });

  test('forging svg is valid and shows the placeholder instead of the lore', () => {
    const svg = cardSvg(card(), lore(), 'forging');
    xmllintOk(svg);
    expect(svg).toContain('Forging lore…');
    expect(svg).not.toContain('Never waits for the next block.');
    expect(svg).not.toContain('Rider of the Blitz');
  });

  test('shows stats, block, last stand range and columns', () => {
    const svg = cardSvg(card(), lore());
    expect(svg).toContain('HP 1,950');
    expect(svg).toContain('Block #73,562,481');
    expect(svg).toContain('120–600');
    expect(svg).toContain('Strong vs');
    expect(svg).toContain('Weak to');
    expect(svg).toContain('12 W · 4 L');
    expect(svg).toContain('Blitz Jogja · 204');
    expect(svg).toContain('Damage per tap. ×1.5 vs Water.');
    expect(svg).toContain('Once per duel, at neutral element.');
    expect(svg).toContain('Lightning · basic · Block #73,562,481');
    expect(svg).toContain('STAGE 1');
  });

  test('stage 2 and 3 meta names the previous form', () => {
    const epic = cardSvg(card({ rarity: 2 }), lore({ name: 'Voltnad' }));
    expect(epic).toContain('Lightning · from Sparkit · Block #73,562,481');
    const legendary = cardSvg(card({ rarity: 3 }), lore({ name: 'Tempestnad' }));
    expect(legendary).toContain('Lightning · from Voltnad · Block #73,562,481');
  });

  test('uses element color and rarity frame for a Water Epic and a Fire Legendary', () => {
    const tokens = loadTokens();
    const water = cardSvg(card({ element: 1, rarity: 2 }), lore({ name: 'Wavenad' }));
    expect(water).toContain(resolveTokenHex(tokens, 'element-water'));
    expect(water).toContain(resolveTokenHex(tokens, 'rarity-epic'));
    expect(water).toContain('◆◆');
    const fire = cardSvg(card({ element: 0, rarity: 3 }), lore({ name: 'Infernad' }));
    expect(fire).toContain(resolveTokenHex(tokens, 'element-fire'));
    expect(fire).toContain(resolveTokenHex(tokens, 'rarity-legendary'));
    expect(fire).toContain('★');
  });

  test('has no gradients, filters, shadows or emoji, and every color comes from tokens', () => {
    const svg = cardSvg(card({ rarity: 3 }), lore());
    expect(svg).not.toMatch(/gradient|filter|shadow/i);
    expect(svg).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    const tokens = loadTokens();
    const allowed = new Set(
      tokens.color.tokens.map((t) => resolveTokenHex(tokens, t.name)),
    );
    const outsideNadmon = svg.replace(/<svg x="12"[\s\S]*?<\/svg>/, '');
    for (const hex of outsideNadmon.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
      expect(allowed.has(hex.toLowerCase())).toBe(true);
    }
  });

  test('uses single-quoted font family names inside double-quoted attributes', () => {
    const svg = cardSvg(card(), lore());
    expect(svg).toContain(`font-family="'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif"`);
    expect(svg).toContain(`font-family="'JetBrains Mono', Menlo, monospace"`);
  });

  test('renders every element and rarity combination as valid XML', () => {
    for (let element = 0; element < ELEMENTS.length; element++) {
      for (let rarity = 0; rarity < 4; rarity++) {
        xmllintOk(cardSvg(card({ element, rarity }), fallbackLore(card({ element, rarity }))));
      }
    }
  });
});

describe('createCardStore', () => {
  test('persists across two store instances', () => {
    const dir = join(makeTmp(), 'nested', 'data');
    const first = createCardStore(dir);
    expect(first.get(5)).toBeUndefined();
    first.set(5, lore({ source: 'ai' }));
    const second = createCardStore(dir);
    expect(second.get(5)).toEqual(lore({ source: 'ai' }));
    expect(second.get(6)).toBeUndefined();
  });

  test('leaves no temp file behind after a write', () => {
    const dir = makeTmp();
    createCardStore(dir).set(1, lore());
    const parsed = JSON.parse(readFileSync(join(dir, 'cards.json'), 'utf8'));
    expect(Object.keys(parsed)).toEqual(['1']);
  });

  test('survives a corrupt cards.json by starting empty and warning', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, 'cards.json'), '{not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createCardStore(dir);
    expect(store.get(1)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    store.set(1, lore());
    expect(createCardStore(dir).get(1)).toEqual(lore());
  });
});
