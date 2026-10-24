// Mirrors the constants in contracts/src/BlitzArena.sol.
export const COUNTDOWN_BLOCKS = 10;
export const DUEL_BLOCKS = 67;
export const MAX_TAPS_PER_BLOCK = 3;
export const MAX_TAPS_PER_TX = 30;

export const ELEMENTS = ['Fire', 'Water', 'Lightning'] as const;
export const RARITIES = ['Common', 'Rare', 'Epic', 'Legendary'] as const;

/** Percent chance per rarity on freePull, index-aligned with RARITIES. */
export const RARITY_ODDS = [60, 28, 10, 2] as const;

/** Element index into ELEMENTS. */
export type Element = 0 | 1 | 2;
