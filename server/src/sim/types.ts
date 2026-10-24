import type { Hex } from '@nad/shared';

export type SideState = { myHp: number; myMaxHp: number; oppHp: number; atk: number; mult: number; skillUsed: boolean; block: number; endBlock: number; lastBlock: number };

export type DuelSummary = { duelId: string; mode: 'sim' | 'testnet'; opponent: Hex; myElement: number; oppElement: number; result: 'win' | 'loss' | 'draw'; skillUsedAtHpPct: number | null; followedPolicy: boolean; hpTimeline: { block: number; myHp: number; oppHp: number }[] };
