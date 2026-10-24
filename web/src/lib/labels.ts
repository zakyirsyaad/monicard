// TODO: replace these name arrays with ELEMENTS / RARITIES from @nad/shared once its Task 4 lands (it is empty today).
export const ELEMENT_NAMES = ['Fire', 'Water', 'Lightning'] as const;
export const RARITY_NAMES = ['Common', 'Rare', 'Epic', 'Legendary'] as const;

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
