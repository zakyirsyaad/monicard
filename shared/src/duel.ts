import { DUEL_BLOCKS } from './constants';

export type Hex = `0x${string}`;

export type DuelStatus = 'Open' | 'Active' | 'P1Won' | 'P2Won' | 'Draw';

export type DuelView = {
  id: string;
  p1: Hex;
  p2: Hex;
  hp1: number;
  hp2: number;
  atk1: number;
  atk2: number;
  mult1: number;
  mult2: number;
  lastBlock1: number;
  lastBlock2: number;
  skill1: boolean;
  skill2: boolean;
  status: DuelStatus;
  startBlock: number;
  endBlock: number;
  card1: number;
  card2: number;
  maxHp1: number;
  maxHp2: number;
  settled: boolean;
};

/** Index-aligned with the `Status` enum in BlitzArena.sol. */
const STATUS_NAMES: readonly DuelStatus[] = ['Open', 'Active', 'P1Won', 'P2Won', 'Draw'];

type RawDuel = Record<string, unknown>;

function num(raw: RawDuel, field: string): number {
  const value = raw[field];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`decodeDuels: field "${field}" is not numeric`);
  }
  return Number(value);
}

function addr(raw: RawDuel, field: string): Hex {
  const value = raw[field];
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`decodeDuels: field "${field}" is not an address`);
  }
  return value as Hex;
}

function flag(raw: RawDuel, field: string): boolean {
  return Boolean(raw[field]);
}

function statusName(raw: RawDuel): DuelStatus {
  const index = num(raw, 'status');
  const name = STATUS_NAMES[index];
  if (name === undefined) throw new Error(`decodeDuels: unknown status ${index}`);
  return name;
}

/**
 * Convert viem-decoded `getDuels(from, count)` structs into DuelViews.
 * `fromId` is the id of the first element.
 */
export function decodeDuels(raw: readonly unknown[], fromId: bigint): DuelView[] {
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`decodeDuels: element ${index} is not an object`);
    }
    const d = entry as RawDuel;
    const startBlock = num(d, 'startBlock');
    return {
      id: (fromId + BigInt(index)).toString(),
      p1: addr(d, 'p1'),
      p2: addr(d, 'p2'),
      hp1: num(d, 'hp1'),
      hp2: num(d, 'hp2'),
      atk1: num(d, 'atk1'),
      atk2: num(d, 'atk2'),
      mult1: num(d, 'mult1'),
      mult2: num(d, 'mult2'),
      lastBlock1: num(d, 'lastBlock1'),
      lastBlock2: num(d, 'lastBlock2'),
      skill1: flag(d, 'skill1'),
      skill2: flag(d, 'skill2'),
      status: statusName(d),
      startBlock,
      endBlock: startBlock + DUEL_BLOCKS,
      card1: num(d, 'card1'),
      card2: num(d, 'card2'),
      maxHp1: num(d, 'maxHp1'),
      maxHp2: num(d, 'maxHp2'),
      settled: flag(d, 'settled'),
    };
  });
}
