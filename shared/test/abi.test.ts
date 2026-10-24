import { describe, expect, test } from 'vitest';
import { blitzArenaAbi, nadCardsAbi, stakeVaultAbi } from '../src/abi';
import { blitzArenaBytecode, nadCardsBytecode, stakeVaultBytecode } from '../src/bytecode';

type AbiParam = { name: string; type: string; components?: readonly AbiParam[] };
type AbiItem = {
  type: string;
  name?: string;
  inputs?: readonly AbiParam[];
  outputs?: readonly AbiParam[];
};

function namesOf(abi: readonly AbiItem[], type: string): string[] {
  return abi.filter((item) => item.type === type && item.name !== undefined).map((item) => item.name as string);
}

function functionNames(abi: readonly AbiItem[]): string[] {
  return namesOf(abi, 'function');
}

function eventNames(abi: readonly AbiItem[]): string[] {
  return namesOf(abi, 'event');
}

describe('nadCardsAbi', () => {
  test('exposes the pull, card lookup and mint-tracking functions', () => {
    const functions = functionNames(nadCardsAbi);
    expect(functions).toEqual(expect.arrayContaining(['freePull', 'paidPull', 'cardOf', 'cards', 'hasPulled']));
  });

  test('emits CardMinted', () => {
    expect(eventNames(nadCardsAbi)).toContain('CardMinted');
  });
});

describe('blitzArenaAbi', () => {
  test('exposes the duel lifecycle and read functions', () => {
    const functions = functionNames(blitzArenaAbi);
    expect(functions).toEqual(
      expect.arrayContaining(['createDuel', 'joinDuel', 'attack', 'settle', 'getDuels', 'duelCount']),
    );
  });

  test('emits DuelCreated', () => {
    expect(eventNames(blitzArenaAbi)).toContain('DuelCreated');
  });

  test('getDuels returns duel structs whose component names match decodeDuels field reads, in order', () => {
    const getDuels = blitzArenaAbi.find(
      (item) => item.type === 'function' && item.name === 'getDuels',
    ) as AbiItem | undefined;
    const duelStruct = getDuels?.outputs?.[0]?.components;
    expect(duelStruct?.map((component) => component.name)).toEqual([
      'p1',
      'hp1',
      'atk1',
      'mult1',
      'lastBlock1',
      'skill1',
      'status',
      'p2',
      'hp2',
      'atk2',
      'mult2',
      'lastBlock2',
      'skill2',
      'startBlock',
      'card1',
      'card2',
      'maxHp1',
      'maxHp2',
      'settled',
    ]);
  });
});

describe('stakeVaultAbi', () => {
  test('exposes stake, claim, the stakes lookup and the stake bound constants', () => {
    expect(functionNames(stakeVaultAbi)).toEqual(
      expect.arrayContaining(['stake', 'claim', 'stakes', 'MIN_STAKE', 'MAX_STAKE']),
    );
  });

  test('emits Staked and Claimed', () => {
    expect(eventNames(stakeVaultAbi)).toEqual(expect.arrayContaining(['Staked', 'Claimed']));
  });
});

describe('bytecode', () => {
  test('nadCardsBytecode is a hex string longer than 100 chars', () => {
    expect(nadCardsBytecode.startsWith('0x')).toBe(true);
    expect(nadCardsBytecode.length).toBeGreaterThan(100);
  });

  test('blitzArenaBytecode is a hex string longer than 100 chars', () => {
    expect(blitzArenaBytecode.startsWith('0x')).toBe(true);
    expect(blitzArenaBytecode.length).toBeGreaterThan(100);
  });

  test('stakeVaultBytecode is a hex string longer than 100 chars', () => {
    expect(stakeVaultBytecode.startsWith('0x')).toBe(true);
    expect(stakeVaultBytecode.length).toBeGreaterThan(100);
  });
});
