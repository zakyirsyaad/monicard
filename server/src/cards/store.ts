import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lore } from './lore';

export type CardStore = {
  get(id: number): Lore | undefined;
  set(id: number, lore: Lore): void;
};

const FILE_NAME = 'cards.json';
const CORRUPT_SUFFIX = '.corrupt';

/** Moves an unreadable file aside so the next write cannot destroy it. */
function quarantine(file: string): void {
  try {
    renameSync(file, `${file}${CORRUPT_SUFFIX}`);
  } catch (err) {
    console.warn(`[cards] could not rename ${file} to ${file}${CORRUPT_SUFFIX}:`, err);
  }
}

function isLore(value: unknown): value is Lore {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.title === 'string' &&
    typeof v.lore === 'string' &&
    (v.source === 'ai' || v.source === 'template')
  );
}

function loadEntries(file: string): Map<number, Lore> {
  const entries = new Map<number, Lore>();
  if (!existsSync(file)) return entries;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('cards.json must contain an object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (isLore(value)) entries.set(Number(key), value);
    }
  } catch (err) {
    console.warn(`[cards] could not read ${file}, keeping it as ${file}${CORRUPT_SUFFIX} and starting empty:`, err);
    quarantine(file);
    entries.clear();
  }
  return entries;
}

/** Lore persisted to `<dataDir>/cards.json`; writes are atomic (tmp file + rename). */
export function createCardStore(dataDir: string): CardStore {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, FILE_NAME);
  const entries = loadEntries(file);

  const persist = (next: ReadonlyMap<number, Lore>): void => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(next)), 'utf8');
    renameSync(tmp, file);
  };

  return {
    get: (id) => entries.get(id),
    set: (id, lore) => {
      persist(new Map(entries).set(id, lore));
      entries.set(id, lore);
    },
  };
}
