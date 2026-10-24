import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { NADMON, nadmonFor } from '../src/index';

const NADMON_DIR = fileURLToPath(new URL('../../docs/design-system/assets/Nadmon/', import.meta.url));

describe('NADMON table', () => {
  test('has the nine entries from the design-system README', () => {
    expect(NADMON.map((n) => [n.id, n.name, n.element, n.stage, n.evolvesFrom])).toEqual([
      ['embrit', 'Embrit', 0, 1, null],
      ['blazenad', 'Blazenad', 0, 2, 'embrit'],
      ['infernad', 'Infernad', 0, 3, 'blazenad'],
      ['dripnad', 'Dripnad', 1, 1, null],
      ['wavenad', 'Wavenad', 1, 2, 'dripnad'],
      ['abyssnad', 'Abyssnad', 1, 3, 'wavenad'],
      ['sparkit', 'Sparkit', 2, 1, null],
      ['voltnad', 'Voltnad', 2, 2, 'sparkit'],
      ['tempestnad', 'Tempestnad', 2, 3, 'voltnad'],
    ]);
  });

  test('ids match the svg filenames in the asset folder', () => {
    const files = readdirSync(NADMON_DIR)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -4))
      .sort();
    expect(NADMON.map((n) => n.id).sort()).toEqual(files);
  });

  test('names match the README table', () => {
    const readme = readFileSync(`${NADMON_DIR}README.md`, 'utf8');
    for (const n of NADMON) {
      expect(readme).toContain(`\`${n.id}.svg\` — ${n.name}`);
    }
  });

  test('evolvesFrom points at the previous stage of the same element', () => {
    for (const n of NADMON) {
      if (n.stage === 1) {
        expect(n.evolvesFrom).toBeNull();
        continue;
      }
      const prev = NADMON.find((p) => p.id === n.evolvesFrom);
      expect(prev?.element).toBe(n.element);
      expect(prev?.stage).toBe(n.stage - 1);
    }
  });
});

describe('nadmonFor', () => {
  test('maps rarity to stage', () => {
    expect(nadmonFor(2, 0).id).toBe('sparkit');
    expect(nadmonFor(2, 1).id).toBe('sparkit');
    expect(nadmonFor(2, 2).id).toBe('voltnad');
    expect(nadmonFor(1, 3).id).toBe('abyssnad');
  });

  test('every element and rarity resolves to an entry with the right element and stage', () => {
    const stageFor = [1, 1, 2, 3];
    for (let element = 0; element <= 2; element++) {
      for (let rarity = 0; rarity <= 3; rarity++) {
        const n = nadmonFor(element, rarity);
        expect(n.element).toBe(element);
        expect(n.stage).toBe(stageFor[rarity]);
      }
    }
  });

  test('throws for an unknown element', () => {
    expect(() => nadmonFor(3, 0)).toThrow();
  });
});
