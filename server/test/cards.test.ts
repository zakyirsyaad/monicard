import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { ELEMENTS, NADMON, nadmonFor } from '@nad/shared';
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, createPublicClient, custom, decodeFunctionData, type Hex, type TransactionReceipt } from 'viem';
import { z } from 'zod';
import { nadCardsAbi } from '@nad/shared';
import type { Llm } from '../src/llm';
import { forgeLore, fallbackLore, type CardData, type Lore } from '../src/cards/lore';
import { attachCardMinting, createCardService, createChainCardReader, type CardMetadataJson } from '../src/cards/service';
import { cardRoutes } from '../src/cards/routes';
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
    expect(readdirSync(dir)).toEqual(['cards.json']);
    const parsed = JSON.parse(readFileSync(join(dir, 'cards.json'), 'utf8'));
    expect(Object.keys(parsed)).toEqual(['1']);
  });

  test('renames a corrupt cards.json to cards.json.corrupt before starting empty', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, 'cards.json'), '{not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createCardStore(dir);
    warn.mockRestore();
    expect(readFileSync(join(dir, 'cards.json.corrupt'), 'utf8')).toBe('{not json');
    expect(existsSync(join(dir, 'cards.json'))).toBe(false);
  });

  test('does not change memory when persisting fails', () => {
    const dir = join(makeTmp(), 'gone');
    const store = createCardStore(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(() => store.set(1, lore())).toThrow();
    expect(store.get(1)).toBeUndefined();
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

// ------------------------------------------------------------- svg fixes

describe('svg carry-in fixes', () => {
  test('escapeXml strips characters illegal in XML 1.0 but keeps tab, newline and astral chars', () => {
    const dirty = `a${String.fromCharCode(0)}b${String.fromCharCode(8)}c${String.fromCharCode(0x1f)}d\te\nf${String.fromCharCode(0xfffe)}g\u{1F525}`;
    expect(escapeXml(dirty)).toBe('abcd\te\nfg\u{1F525}');
    expect(escapeXml(`x${String.fromCharCode(0xd800)}y`)).toBe('xy');
  });

  test('card with control characters in lore is still valid XML', () => {
    const svg = cardSvg(card(), lore({ title: `Bad${String.fromCharCode(1)}Title`, lore: `Lore${String.fromCharCode(0)}text` }));
    const file = join(makeTmp(), 'ctl.svg');
    writeFileSync(file, svg, 'utf8');
    execFileSync('xmllint', ['--noout', file]);
  });

  test('record uses the thousands formatter', () => {
    expect(cardSvg(card({ wins: 1234, losses: 1000 }), lore())).toContain('1,234 W · 1,000 L');
  });

  test('header and title use the species name, not lore.name', () => {
    const svg = cardSvg(card(), lore({ name: 'Imposter' }));
    expect(svg).not.toContain('Imposter');
    expect(svg).toContain('>Sparkit</text>');
    expect(svg).toContain('<title>Sparkit</title>');
  });
});

// ----------------------------------------------------------------- forgeLore

type JsonArgs = { system: string; user: string; timeoutMs: number };

function fakeLlm(produce: () => Promise<unknown>): Llm & { calls: JsonArgs[] } {
  const calls: JsonArgs[] = [];
  return {
    calls,
    json: async <T>(system: string, user: string, schema: z.ZodType<T>, timeoutMs: number): Promise<T> => {
      calls.push({ system, user, timeoutMs });
      return schema.parse(await produce());
    },
  };
}

const goodReply = { title: 'Rider of the Blitz', lore: 'Never waits for the next block.' };

describe('forgeLore', () => {
  afterEach(() => vi.useRealTimers());

  test('uses the template when there is no LLM', async () => {
    expect(await forgeLore(card(), null)).toEqual(fallbackLore(card()));
  });

  test('falls back on invalid JSON (LLM throws)', async () => {
    const lore = await forgeLore(card(), fakeLlm(() => Promise.reject(new Error('invalid json'))));
    expect(lore.source).toBe('template');
    expect(lore).toEqual(fallbackLore(card()));
  });

  test('falls back on timeout when the LLM takes 5 s and timeoutMs is 50', async () => {
    vi.useFakeTimers();
    const slow = fakeLlm(() => new Promise((resolve) => setTimeout(() => resolve(goodReply), 5000)));
    const pending = forgeLore(card(), slow, 50);
    await vi.advanceTimersByTimeAsync(60);
    expect((await pending).source).toBe('template');
  });

  test('valid output becomes ai lore with the Nadmon species name', async () => {
    const result = await forgeLore(card(), fakeLlm(async () => ({ ...goodReply, name: 'Hacker' })));
    expect(result).toEqual({ name: nadmonFor(2, 1).name, title: goodReply.title, lore: goodReply.lore, source: 'ai' });
  });

  test('prompt includes name, element, rarity, atk and hp, and the timeout is passed on', async () => {
    const llm = fakeLlm(async () => goodReply);
    await forgeLore(card({ atk: 12, hp: 1950 }), llm, 1234);
    const { system, user, timeoutMs } = llm.calls[0]!;
    expect(timeoutMs).toBe(1234);
    for (const part of ['Sparkit', 'Lightning', 'Rare', '12', '1950']) expect(user).toContain(part);
    expect(system).toMatch(/english/i);
    expect(system).toMatch(/JSON/);
  });

  test('rejects too-long title or lore and falls back', async () => {
    expect((await forgeLore(card(), fakeLlm(async () => ({ title: 'x'.repeat(41), lore: 'ok' })))).source).toBe('template');
    expect((await forgeLore(card(), fakeLlm(async () => ({ title: 'ok', lore: 'x'.repeat(171) })))).source).toBe('template');
  });

  test('sanitizes control characters, emoji and whitespace', async () => {
    const result = await forgeLore(
      card(),
      fakeLlm(async () => ({ title: `Spark \u{1F525}${String.fromCharCode(7)}  Runner`, lore: 'Fast.\n\nVery \u{26A1}\u{FE0F} fast.' })),
    );
    expect(result.title).toBe('Spark Runner');
    expect(result.lore).toBe('Fast. Very fast.');
    expect(result.source).toBe('ai');
  });

  test('falls back when the text is empty after sanitizing or uses banned words', async () => {
    expect((await forgeLore(card(), fakeLlm(async () => ({ title: '\u{1F525}', lore: 'ok' })))).source).toBe('template');
    expect((await forgeLore(card(), fakeLlm(async () => ({ title: 'Lucky One', lore: 'Place your bet and gamble on it.' })))).source).toBe('template');
    expect((await forgeLore(card(), fakeLlm(async () => ({ title: 'A better one', lore: 'Nothing banned here at all.' })))).source).toBe('ai');
  });
});

// -------------------------------------------------------------- card service

const PUBLIC_URL = 'https://nadgacha.example';

const memoryStore = () => {
  const map = new Map<number, Lore>();
  return { map, get: (id: number) => map.get(id), set: (id: number, l: Lore) => void map.set(id, l) };
};

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('createCardService', () => {
  test('metadata always has the full shape, matching what the web consumes', async () => {
    const store = memoryStore();
    const svc = createCardService({ readCard: async (id) => card({ id }), store, llm: null, publicUrl: PUBLIC_URL });
    const meta = (await svc.metadata(204))!;
    const species = nadmonFor(2, 1);
    const l = fallbackLore(card());
    expect(meta.name).toBe('Sparkit #204');
    expect(meta.description).toContain(l.title);
    expect(meta.image).toBe(`${PUBLIC_URL}/card/204/image.svg`);
    expect(meta.attributes).toEqual([
      { trait_type: 'Element', value: 'Lightning' },
      { trait_type: 'Rarity', value: 'Rare' },
      { trait_type: 'ATK', value: 12 },
      { trait_type: 'HP', value: 1950 },
      { trait_type: 'Stage', value: 1 },
      { trait_type: 'Wins', value: 12 },
      { trait_type: 'Losses', value: 4 },
    ]);
    expect(meta.nadgacha).toEqual({
      ...card(),
      nadmon: { id: species.id, name: species.name, stage: species.stage },
      title: l.title,
      lore: l.lore,
      status: 'ready',
    });
    expect(Object.keys(meta).sort()).toEqual(['attributes', 'description', 'image', 'nadgacha', 'name']);
  });

  test('stats always come from the chain, lore from the store', async () => {
    const store = memoryStore();
    store.set(5, lore({ name: 'Sparkit', title: 'Stored Title', lore: 'Stored lore.', source: 'ai' }));
    let wins = 1;
    const svc = createCardService({ readCard: async (id) => card({ id, wins }), store, llm: null, publicUrl: PUBLIC_URL });
    expect((await svc.metadata(5))!.nadgacha.wins).toBe(1);
    wins = 2;
    const again = (await svc.metadata(5))!;
    expect(again.nadgacha.wins).toBe(2);
    expect(again.nadgacha.title).toBe('Stored Title');
  });

  test('creates template lore lazily for a mint missed while the server was down', async () => {
    const store = memoryStore();
    const svc = createCardService({ readCard: async (id) => card({ id }), store, llm: null, publicUrl: PUBLIC_URL });
    const meta = (await svc.metadata(9))!;
    expect(meta.nadgacha.status).toBe('ready');
    expect(store.get(9)).toEqual(fallbackLore(card({ id: 9 })));
    expect(meta.nadgacha.title).toBe(store.get(9)!.title);
  });

  test('still serves lore when persisting the lazy template fails', async () => {
    const store = { get: () => undefined, set: () => { throw new Error('disk full'); } };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = createCardService({ readCard: async (id) => card({ id }), store, llm: null, publicUrl: PUBLIC_URL });
    expect((await svc.metadata(9))!.nadgacha.status).toBe('ready');
    expect(await svc.svg(9)).toContain('<svg');
    error.mockRestore();
  });

  test('reports forging with full stats while an onMint forge is in progress, then ready with ai lore', async () => {
    const store = memoryStore();
    const gate = deferred<unknown>();
    const llm = fakeLlm(() => gate.promise);
    const svc = createCardService({ readCard: async (id) => card({ id }), store, llm, publicUrl: PUBLIC_URL });
    const minting = svc.onMint(5);
    const during = (await svc.metadata(5))!;
    expect(during.nadgacha.status).toBe('forging');
    expect(during.nadgacha.atk).toBe(12);
    expect(during.nadgacha.hp).toBe(1950);
    expect(during.nadgacha.nadmon.name).toBe('Sparkit');
    expect(during.name).toBe('Sparkit #5');
    expect(await svc.svg(5)).toContain('Forging lore…');
    gate.resolve(goodReply);
    await minting;
    const after = (await svc.metadata(5))!;
    expect(after.nadgacha.status).toBe('ready');
    expect(after.nadgacha.title).toBe(goodReply.title);
    expect(store.get(5)?.source).toBe('ai');
    expect(await svc.svg(5)).toContain(goodReply.title);
  });

  test('de-duplicates concurrent onMint calls per id', async () => {
    const store = memoryStore();
    const gate = deferred<unknown>();
    const llm = fakeLlm(() => gate.promise);
    const svc = createCardService({ readCard: async (id) => card({ id }), store, llm, publicUrl: PUBLIC_URL });
    const a = svc.onMint(5);
    const b = svc.onMint(5);
    const other = svc.onMint(6);
    gate.resolve(goodReply);
    await Promise.all([a, b, other]);
    expect(llm.calls).toHaveLength(2);
    await svc.onMint(5);
    expect(llm.calls).toHaveLength(2);
  });

  test('onMint ignores a token that does not exist and leaves no forging state', async () => {
    const llm = fakeLlm(async () => goodReply);
    const svc = createCardService({ readCard: async () => null, store: memoryStore(), llm, publicUrl: PUBLIC_URL });
    await svc.onMint(77);
    expect(llm.calls).toHaveLength(0);
  });

  test('forging flag clears even when onMint fails', async () => {
    let fail = true;
    const readCard = async (id: number) => {
      if (fail) throw new Error('rpc down');
      return card({ id });
    };
    const svc = createCardService({ readCard, store: memoryStore(), llm: null, publicUrl: PUBLIC_URL });
    await expect(svc.onMint(5)).rejects.toThrow('rpc down');
    fail = false;
    expect((await svc.metadata(5))!.nadgacha.status).toBe('ready');
  });

  test('returns null for a nonexistent token and caches that for 10 s', async () => {
    let clock = 1_000;
    const readCard = vi.fn(async () => null);
    const svc = createCardService({ readCard, store: memoryStore(), llm: null, publicUrl: PUBLIC_URL, now: () => clock });
    expect(await svc.metadata(404)).toBeNull();
    expect(await svc.svg(404)).toBeNull();
    clock += 9_999;
    expect(await svc.metadata(404)).toBeNull();
    expect(readCard).toHaveBeenCalledTimes(1);
    clock += 2;
    expect(await svc.metadata(404)).toBeNull();
    expect(readCard).toHaveBeenCalledTimes(2);
  });

  test('onMint clears the negative cache so a fresh mint is visible at once', async () => {
    let exists = false;
    const readCard = async (id: number) => (exists ? card({ id }) : null);
    const svc = createCardService({ readCard, store: memoryStore(), llm: null, publicUrl: PUBLIC_URL, now: () => 1 });
    expect(await svc.metadata(8)).toBeNull();
    exists = true;
    await svc.onMint(8);
    expect(await svc.metadata(8)).not.toBeNull();
  });

  test('chain read errors propagate and are not cached as 404', async () => {
    let fail = true;
    const readCard = async (id: number) => {
      if (fail) throw new Error('rpc down');
      return card({ id });
    };
    const svc = createCardService({ readCard, store: memoryStore(), llm: null, publicUrl: PUBLIC_URL, now: () => 1 });
    await expect(svc.metadata(3)).rejects.toThrow('rpc down');
    fail = false;
    expect(await svc.metadata(3)).not.toBeNull();
  });

  test('svg returns a valid card for an existing token', async () => {
    const svc = createCardService({ readCard: async (id) => card({ id }), store: memoryStore(), llm: null, publicUrl: PUBLIC_URL });
    const svg = (await svc.svg(204))!;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Blitz Jogja · 204');
  });
});

// ------------------------------------------------------------------- routes

describe('cardRoutes', () => {
  const makeApp = () => {
    const svc = createCardService({
      readCard: async (id) => (id === 5 ? card({ id }) : null),
      store: memoryStore(),
      llm: null,
      publicUrl: PUBLIC_URL,
    });
    return cardRoutes(svc);
  };

  test('/card/5 returns metadata JSON', async () => {
    const res = await makeApp().request('/card/5');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as CardMetadataJson;
    expect(body.name).toBe('Sparkit #5');
    expect(body.nadgacha.id).toBe(5);
    expect(body.image).toBe(`${PUBLIC_URL}/card/5/image.svg`);
  });

  test('/card/5/image.svg returns svg with cache headers', async () => {
    const res = await makeApp().request('/card/5/image.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect((await res.text()).startsWith('<svg')).toBe(true);
  });

  test('missing tokens are 404 with reason not_found on both routes', async () => {
    const app = makeApp();
    for (const path of ['/card/6', '/card/6/image.svg']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ reason: 'not_found' });
    }
  });

  test('non-numeric ids and the /card/:id.svg shape are 404 and never reach the service', async () => {
    const app = makeApp();
    expect((await app.request('/card/abc')).status).toBe(404);
    expect((await app.request('/card/abc/image.svg')).status).toBe(404);
    expect((await app.request('/card/5.svg')).status).toBe(404);
    expect((await app.request('/card/99999999999999999999')).status).toBe(404);
  });

  test('chain failures answer 503 instead of caching a 404', async () => {
    const svc = createCardService({
      readCard: async () => {
        throw new Error('rpc down');
      },
      store: memoryStore(),
      llm: null,
      publicUrl: PUBLIC_URL,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await cardRoutes(svc).request('/card/5');
    error.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ reason: 'unavailable' });
  });
});

// --------------------------------------------------- chain reader and minting

const CARDS_ADDRESS = '0x00000000000000000000000000000000000000c1' as Hex;
const OWNER = '0x00000000000000000000000000000000000000a1' as Hex;

function fakeChain(minted: Map<number, CardData>, failRpc = () => false) {
  const client = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
          if (failRpc()) throw Object.assign(new Error('connection refused'), { code: -32603 });
          const data = (params as [{ data: Hex }])[0].data;
          const call = decodeFunctionData({ abi: nadCardsAbi, data });
          const id = Number(call.args?.[0]);
          const found = minted.get(id);
          if (call.functionName === 'ownerOf') {
            if (!found) {
              const revertData = encodeErrorResult({ abi: nadCardsAbi, errorName: 'ERC721NonexistentToken', args: [BigInt(id)] });
              throw Object.assign(new Error('execution reverted'), { code: 3, data: revertData });
            }
            return encodeFunctionResult({ abi: nadCardsAbi, functionName: 'ownerOf', result: OWNER });
          }
          if (call.functionName === 'cards') {
            return encodeFunctionResult({
              abi: nadCardsAbi,
              functionName: 'cards',
              result: { ...found!, mintedAt: BigInt(found!.mintedAt) },
            });
          }
          throw new Error(`unexpected call ${call.functionName}`);
        },
      },
      { retryCount: 0 },
    ),
  });
  return { call: <T,>(fn: (c: typeof client) => Promise<T>) => fn(client) } as unknown as Parameters<typeof createChainCardReader>[0];
}

describe('createChainCardReader', () => {
  test('reads card stats, with mintedAt as a number', async () => {
    const minted = new Map([[7, card({ id: 7, mintedAt: 73_562_481 })]]);
    const read = createChainCardReader(fakeChain(minted), CARDS_ADDRESS);
    expect(await read(7)).toEqual(card({ id: 7, mintedAt: 73_562_481 }));
  });

  test('returns null when ownerOf reverts (token does not exist)', async () => {
    const read = createChainCardReader(fakeChain(new Map()), CARDS_ADDRESS);
    expect(await read(99)).toBeNull();
  });

  test('rethrows transport failures instead of reporting a missing token', async () => {
    const read = createChainCardReader(fakeChain(new Map([[7, card({ id: 7 })]]), () => true), CARDS_ADDRESS);
    await expect(read(7)).rejects.toThrow();
  });
});

function mintReceipt(tokenId: bigint, address: Hex = CARDS_ADDRESS): TransactionReceipt {
  const topics = encodeEventTopics({ abi: nadCardsAbi, eventName: 'CardMinted', args: { tokenId, owner: OWNER } });
  const data = encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint16' }],
    [1, 2, 12, 1950],
  );
  return { status: 'success', logs: [{ address, topics, data }] } as unknown as TransactionReceipt;
}

describe('attachCardMinting', () => {
  const makeHub = () => {
    let listener: ((block: bigint, receipts: TransactionReceipt[]) => void) | undefined;
    return {
      onIngest: (cb: (block: bigint, receipts: TransactionReceipt[]) => void) => void (listener = cb),
      emit: (receipts: TransactionReceipt[]) => listener!(10n, receipts),
    };
  };
  const svcWith = (onMint: (id: number) => Promise<void>) => ({ onMint, metadata: async () => null, svg: async () => null });

  test('calls service.onMint for CardMinted logs from the cards address only', async () => {
    const hub = makeHub();
    const onMint = vi.fn(async (_id: number) => undefined);
    attachCardMinting(hub, svcWith(onMint), CARDS_ADDRESS);
    hub.emit([
      mintReceipt(7n),
      mintReceipt(8n, '0x00000000000000000000000000000000000000d2'),
      mintReceipt(9n, CARDS_ADDRESS.toUpperCase().replace('0X', '0x') as Hex),
      { status: 'success', logs: [] } as unknown as TransactionReceipt,
    ]);
    expect(onMint.mock.calls.map((c) => c[0])).toEqual([7, 9]);
  });

  test('ignores logs that are not CardMinted', () => {
    const hub = makeHub();
    const onMint = vi.fn(async (_id: number) => undefined);
    attachCardMinting(hub, svcWith(onMint), CARDS_ADDRESS);
    const junk = { status: 'success', logs: [{ address: CARDS_ADDRESS, topics: ['0x1234'], data: '0x' }] } as unknown as TransactionReceipt;
    hub.emit([junk]);
    expect(onMint).not.toHaveBeenCalled();
  });

  test('catches onMint failures (sync and async) and logs only once', async () => {
    const hub = makeHub();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onMint = vi.fn(async (_id: number): Promise<void> => {
      throw new Error('boom');
    });
    attachCardMinting(hub, svcWith(onMint), CARDS_ADDRESS);
    hub.emit([mintReceipt(1n), mintReceipt(2n)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(onMint).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
