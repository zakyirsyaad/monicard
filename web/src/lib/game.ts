// Single import point for game rules: re-exports @nad/shared (the source of truth mirroring the contracts).
// Never import `@nad/shared/bytecode` from web.
export {
  COUNTDOWN_BLOCKS,
  DUEL_BLOCKS,
  MAX_TAPS_PER_BLOCK,
  MAX_TAPS_PER_TX,
  ELEMENTS,
  RARITIES,
  RARITY_ODDS,
  NADMON,
  elementMult,
  strongAgainst,
  weakTo,
  allowedTaps,
  tapDamage,
  skillDamage,
  nadmonFor,
} from '@nad/shared';
export type { Element, Nadmon } from '@nad/shared';
export type { DuelStatus, DuelView } from './types';
