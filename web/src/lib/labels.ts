import { ELEMENTS, RARITIES } from './game';

export const ELEMENT_NAMES = ELEMENTS;
export const RARITY_NAMES = RARITIES;

export const LEGENDARY_RARITY = 3;

// Full literal class strings so Tailwind's content scan generates them.
export const elementTextClass = ['text-element-fire', 'text-element-water', 'text-element-lightning'] as const;
export const elementBorderClass = ['border-element-fire', 'border-element-water', 'border-element-lightning'] as const;
export const rarityBorderClass = [
  'border-rarity-common',
  'border-rarity-rare',
  'border-rarity-epic',
  'border-rarity-legendary',
] as const;

export const rarityTextClass = [
  'text-rarity-common',
  'text-rarity-rare',
  'text-rarity-epic',
  'text-rarity-legendary',
] as const;
