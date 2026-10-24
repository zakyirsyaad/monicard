import { encodeEventTopics, encodeFunctionData, keccak256, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, test, vi } from 'vitest';
import { battleAbi } from '../src/battleAbi';
import { createReceiptHub } from '../src/receiptHub';
import { handleRelay, validateRawTx, type RelayConfig, type RelayDeps } from '../src/relay';

// anvil's well-known public dev key #0 (test key, never holds value)
const ANVIL_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(ANVIL_KEY);

const CARDS: Hex = '0x1111111111111111111111111111111111111111';
const ARENA: Hex = '0x2222222222222222222222222222222222222222';
const BATTLE: Hex = '0x3333333333333333333333333333333333333333';
const GAS_LIMITS = {
  freePull: 200_000,
  paidPull: 200_000,
  createDuel: 200_000,
  joinDuel: 200_000,
  attack: 70_000,
  settle: 200_000,
  createMatch: 200_000,
  joinMatch: 250_000,
  act: 300_000,
  claimTimeout: 120_000,
};
const CFG: RelayConfig = {
  chainId: 10143,
  cards: CARDS,
  arena: ARENA,
  battle: BATTLE,
  gasLimits: GAS_LIMITS,
  pullPrice: 50_000_000_000_000_000n,
};
const MAX_FEE = 200_000_000_000n;

const createMatchData = encodeFunctionData({ abi: battleAbi, functionName: 'createMatch' });
const joinMatchData = encodeFunctionData({ abi: battleAbi, functionName: 'joinMatch', args: [5n] });
const actData = encodeFunctionData({ abi: battleAbi, functionName: 'act', args: [5n, 255, true] });
const claimTimeoutData = encodeFunctionData({ abi: battleAbi, functionName: 'claimTimeout', args: [5n] });

const V2_ACT = [
  {
    type: 'function',
    name: 'act',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'special', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

type TxOverrides = { to?: Hex; data?: Hex; value?: bigint; gas?: bigint };

async function signTx(o: TxOverrides = {}): Promise<Hex> {
  return account.signTransaction({
    type: 'eip1559',
    chainId: 10143,
    nonce: 0,
    to: o.to ?? BATTLE,
    data: o.data ?? actData,
    value: o.value ?? 0n,
    gas: o.gas ?? 300_000n,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: 2_000_000_000n,
  });
}

describe('battle relay allowlist', () => {
  test('accepts the four battle functions with zero value within their gas limits', async () => {
    const cases: [Hex, string, bigint][] = [
      [createMatchData, 'createMatch', 200_000n],
      [joinMatchData, 'joinMatch', 250_000n],
      [actData, 'act', 300_000n],
      [claimTimeoutData, 'claimTimeout', 120_000n],
    ];
    for (const [data, fn, gas] of cases) {
      const result = validateRawTx(await signTx({ data, gas }), CFG);
      expect(result.ok, fn).toBe(true);
      if (result.ok) expect(result.fn).toBe(fn);
    }
  });

  test('rejects a value-carrying battle tx (CardBattle is never payable)', async () => {
    const result = validateRawTx(await signTx({ data: createMatchData, value: 1n }), CFG);
    expect(result).toEqual({ ok: false, reason: 'value' });
  });

  test('rejects gas above the battle limit and a battle target without a configured address', async () => {
    expect(validateRawTx(await signTx({ data: actData, gas: 300_001n }), CFG)).toEqual({ ok: false, reason: 'gas' });
    const noBattle: RelayConfig = { ...CFG, battle: undefined };
    expect(validateRawTx(await signTx({ data: createMatchData, gas: 200_000n }), noBattle)).toEqual({
      ok: false,
      reason: 'to',
    });
  });

  test('rejects the v2 act(uint256,bool) selector, so only the v3 signature decodes', async () => {
    const v2 = encodeFunctionData({ abi: V2_ACT, functionName: 'act', args: [5n, true] });
    expect(validateRawTx(await signTx({ data: v2, gas: 300_000n }), CFG)).toEqual({ ok: false, reason: 'selector' });
  });

  test('still rejects a battle selector sent to the cards contract', async () => {
    expect(validateRawTx(await signTx({ to: CARDS, data: createMatchData, gas: 200_000n }), CFG)).toEqual({
      ok: false,
      reason: 'selector',
    });
  });
});

// ------------------------------------------------------------------ events

type FakeLog = TransactionReceipt['logs'][number];
const makeLog = (topics: readonly Hex[], data: Hex): FakeLog => ({ address: BATTLE, topics, data }) as unknown as FakeLog;

function matchCreatedLog(id: bigint): FakeLog {
  const topics = encodeEventTopics({ abi: battleAbi, eventName: 'MatchCreated', args: { id, p1: account.address } });
  return makeLog(topics as Hex[], '0x');
}

function matchJoinedLog(id: bigint): FakeLog {
  const topics = encodeEventTopics({ abi: battleAbi, eventName: 'MatchJoined', args: { id, p2: account.address } });
  return makeLog(topics as Hex[], '0x');
}

function setup(logs: FakeLog[]) {
  const hub = createReceiptHub();
  const client = {
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const hash = keccak256(serializedTransaction);
      hub.ingest(123n, [
        { transactionHash: hash, blockNumber: 123n, status: 'success', to: BATTLE, logs } as unknown as TransactionReceipt,
      ]);
      return hash;
    },
    getTransactionReceipt: async () => {
      throw new Error('not found');
    },
  };
  const deps: RelayDeps = {
    chain: { client: client as never, call: (fn) => fn(client as never) },
    hub,
    stats: { recordLatency: vi.fn() },
    cfg: CFG,
    getBalance: async () => 10n ** 18n,
    timeoutMs: 500,
  };
  return deps;
}

describe('events.matchId', () => {
  test('createMatch returns the id from MatchCreated', async () => {
    const res = await handleRelay({ rawTx: await signTx({ data: createMatchData, gas: 200_000n }) }, '1.2.3.4', setup([matchCreatedLog(5n)]));
    expect(res.status).toBe(200);
    expect((res.json as { events: { matchId?: string } }).events.matchId).toBe('5');
  });

  test('joinMatch returns the id from MatchJoined', async () => {
    const res = await handleRelay({ rawTx: await signTx({ data: joinMatchData, gas: 250_000n }) }, '1.2.3.4', setup([matchJoinedLog(6n)]));
    expect(res.status).toBe(200);
    expect((res.json as { events: { matchId?: string } }).events.matchId).toBe('6');
  });

  test('act has no matchId field', async () => {
    const res = await handleRelay({ rawTx: await signTx({ data: actData, gas: 300_000n }) }, '1.2.3.4', setup([]));
    expect(res.status).toBe(200);
    expect((res.json as { events: { matchId?: string } }).events.matchId).toBeUndefined();
  });
});