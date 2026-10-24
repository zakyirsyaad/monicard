/**
 * CardBattle ABI (BATTLE-SPEC.md v3): no NadCards, no deck arguments. The local
 * copy keeps the server independent of Qwen-4's contract export; once
 * `@nad/shared` exports the real `battleAbi`, this body becomes
 * `export { battleAbi } from '@nad/shared';`.
 */

const MATCH_VIEW = {
  type: 'tuple',
  components: [
    { name: 'p1', type: 'address' },
    { name: 'p2', type: 'address' },
    { name: 'status', type: 'uint8' },
    { name: 'turn', type: 'uint8' },
    { name: 'score1', type: 'uint8' },
    { name: 'score2', type: 'uint8' },
    { name: 'lastMoveBlock', type: 'uint32' },
    { name: 'special1', type: 'bool' },
    { name: 'special2', type: 'bool' },
    { name: 'drawn1', type: 'uint8' },
    { name: 'drawn2', type: 'uint8' },
    { name: 'placed1', type: 'uint16' },
    { name: 'placed2', type: 'uint16' },
    { name: 'el1', type: 'uint8[10]' },
    { name: 'el2', type: 'uint8[10]' },
    { name: 'rar1', type: 'uint8[10]' },
    { name: 'rar2', type: 'uint8[10]' },
    { name: 'atk1', type: 'uint16[10]' },
    { name: 'atk2', type: 'uint16[10]' },
    { name: 'maxHp1', type: 'uint16[10]' },
    { name: 'maxHp2', type: 'uint16[10]' },
    { name: 'hp1', type: 'uint16[10]' },
    { name: 'hp2', type: 'uint16[10]' },
    { name: 'board1', type: 'uint8[3]' },
    { name: 'board2', type: 'uint8[3]' },
  ],
} as const;

export const battleAbi = [
  {
    type: 'function',
    name: 'createMatch',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'joinMatch',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'act',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'handIdx', type: 'uint8' },
      { name: 'special', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimTimeout',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getMatch',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [MATCH_VIEW],
  },
  {
    type: 'function',
    name: 'getMatches',
    stateMutability: 'view',
    inputs: [
      { name: 'from', type: 'uint256' },
      { name: 'count', type: 'uint256' },
    ],
    outputs: [{ type: 'tuple[]', components: MATCH_VIEW.components }],
  },
  {
    type: 'function',
    name: 'matchCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'elementMult',
    stateMutability: 'pure',
    inputs: [
      { name: 'a', type: 'uint8' },
      { name: 'd', type: 'uint8' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'MatchCreated',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'p1', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'MatchJoined',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'p2', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Acted',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'drawnNo', type: 'uint8', indexed: false },
      { name: 'placedNo', type: 'uint8', indexed: false },
      { name: 'special', type: 'bool', indexed: false },
      { name: 'damage', type: 'uint256', indexed: false },
      { name: 'ko', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MatchEnded',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'winner', type: 'address', indexed: true },
    ],
  },
] as const;