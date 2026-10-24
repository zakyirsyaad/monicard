import { describe, expect, it } from 'vitest';
import { parseGwei, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signCall } from '../src/lib/sign';
import type { Config } from '../src/lib/types';

const ARENA = '0x2222222222222222222222222222222222222222' as const;

const config = {
  chainId: 10143,
  contracts: { cards: '0x1111111111111111111111111111111111111111', arena: ARENA },
  gasLimits: { freePull: 1, paidPull: 1, createDuel: 1, joinDuel: 1, attack: 120000, settle: 1 },
  gasPrice: '50000000000',
  batchMs: 1000,
  pullPrice: '50000000000000000',
  event: { name: 'Test', sponsor: null },
  agent: '0x3333333333333333333333333333333333333333',
  bots: [],
} satisfies Config;

describe('signCall', () => {
  it('signs an EIP-1559 tx with the frozen fee rules', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const raw = await signCall(account, config, { to: ARENA, data: '0x1234', nonce: 7, gas: 120000 });
    const tx = parseTransaction(raw);
    expect(tx.type).toBe('eip1559');
    expect(tx.chainId).toBe(10143);
    expect(tx.maxFeePerGas).toBe(100000000000n);
    expect(tx.maxPriorityFeePerGas).toBe(parseGwei('2'));
    expect(tx.gas).toBe(120000n);
    expect(tx.nonce).toBe(7);
    expect(tx.to).toBe(ARENA);
    expect(tx.data).toBe('0x1234');
    expect(tx.value ?? 0n).toBe(0n);
  });

  it('passes value through for payable calls', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const raw = await signCall(account, config, {
      to: ARENA,
      data: '0x',
      nonce: 0,
      gas: 1,
      value: 50000000000000000n,
    });
    expect(parseTransaction(raw).value).toBe(50000000000000000n);
  });
});
