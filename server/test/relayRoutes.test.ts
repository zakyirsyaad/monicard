import { blitzArenaAbi } from '@nad/shared';
import { encodeFunctionData, keccak256, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, test, vi } from 'vitest';
import { createReceiptHub } from '../src/receiptHub';
import { relayRoutes } from '../src/relayRoutes';
import type { RelayDeps } from '../src/relay';

// anvil's well-known public dev key #0 (test key, never holds value)
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const CARDS: Hex = '0x1111111111111111111111111111111111111111';
const ARENA: Hex = '0x2222222222222222222222222222222222222222';
const CFG = {
  chainId: 10143,
  cards: CARDS,
  arena: ARENA,
  gasLimits: { freePull: 200_000, paidPull: 200_000, createDuel: 200_000, joinDuel: 200_000, attack: 70_000, settle: 200_000 },
  pullPrice: 50_000_000_000_000_000n,
};

const signAttack = (nonce: number) =>
  account.signTransaction({
    type: 'eip1559',
    chainId: 10143,
    nonce,
    to: ARENA,
    data: encodeFunctionData({ abi: blitzArenaAbi, functionName: 'attack', args: [1n, 3, false] }),
    gas: 70_000n,
    maxFeePerGas: 200_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
  });

function makeApp() {
  const hub = createReceiptHub();
  const client = {
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const hash = keccak256(serializedTransaction);
      hub.ingest(77n, [{ transactionHash: hash, blockNumber: 77n, status: 'success', to: ARENA, logs: [] } as unknown as TransactionReceipt]);
      return hash;
    },
  };
  const deps: RelayDeps = {
    chain: { client: client as never, call: (fn) => fn(client as never) },
    hub,
    stats: { recordLatency: vi.fn() },
    cfg: CFG,
    getBalance: async () => 10n ** 18n,
    timeoutMs: 200,
  };
  return relayRoutes(deps);
}

const post = (app: ReturnType<typeof makeApp>, body: string, headers: Record<string, string> = {}) =>
  app.request('/relay', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('relayRoutes', () => {
  test('happy path returns 200 with the relay response', async () => {
    const app = makeApp();
    const raw = await signAttack(0);
    const res = await post(app, JSON.stringify({ rawTx: raw }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hash: keccak256(raw), status: 'success', blockNumber: '77', events: {} });
  });

  test('invalid JSON and missing rawTx return 400 decode', async () => {
    const app = makeApp();
    for (const body of ['not json', '{}']) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ reason: 'decode' });
    }
  });

  test('rate limits per client IP taken from the first x-forwarded-for entry', async () => {
    const app = makeApp();
    // 30 txs/s per IP: use 31 distinct senders so only the IP limit can trigger
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const signer = privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, '0')}`);
      const raw = await signer.signTransaction({
        type: 'eip1559', chainId: 10143, nonce: 0, to: ARENA,
        data: encodeFunctionData({ abi: blitzArenaAbi, functionName: 'attack', args: [1n, 3, false] }),
        gas: 70_000n, maxFeePerGas: 200_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
      });
      const res = await post(app, JSON.stringify({ rawTx: raw }), { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    // a different forwarded IP (first entry) is a different bucket
    const other = await post(app, JSON.stringify({ rawTx: await signAttack(5) }), { 'x-forwarded-for': '9.9.9.9' });
    expect(other.status).toBe(200);
    // and without the header everything falls into 'unknown'
    const unknown = await post(app, JSON.stringify({ rawTx: await signAttack(6) }));
    expect(unknown.status).toBe(200);
  });
});
