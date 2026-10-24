import { blitzArenaAbi, nadCardsAbi } from '@nad/shared';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  serializeTransaction,
  toHex,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, test, vi } from 'vitest';
import { createReceiptHub, type ReceiptHub } from '../src/receiptHub';
import { createRateLimiter, handleRelay, validateRawTx, type RelayDeps } from '../src/relay';

// anvil's well-known public dev key #0 (test key, never holds value)
const ANVIL_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(ANVIL_KEY);

const CARDS: Hex = '0x1111111111111111111111111111111111111111';
const ARENA: Hex = '0x2222222222222222222222222222222222222222';
const PULL_PRICE = 50_000_000_000_000_000n;
const GAS_LIMITS = { freePull: 200_000, paidPull: 200_000, createDuel: 200_000, joinDuel: 200_000, attack: 70_000, settle: 200_000 };
const CFG = { chainId: 10143, cards: CARDS, arena: ARENA, gasLimits: GAS_LIMITS, pullPrice: PULL_PRICE };
const MAX_FEE = 200_000_000_000n;

const attackData = encodeFunctionData({ abi: blitzArenaAbi, functionName: 'attack', args: [1n, 3, false] });
const freePullData = encodeFunctionData({ abi: nadCardsAbi, functionName: 'freePull' });
const paidPullData = encodeFunctionData({ abi: nadCardsAbi, functionName: 'paidPull' });

type TxOverrides = { to?: Hex; data?: Hex; value?: bigint; gas?: bigint; chainId?: number; nonce?: number; signer?: typeof account };

async function signTx(o: TxOverrides = {}): Promise<Hex> {
  return (o.signer ?? account).signTransaction({
    type: 'eip1559',
    chainId: o.chainId ?? 10143,
    nonce: o.nonce ?? 0,
    to: o.to ?? ARENA,
    data: o.data ?? attackData,
    value: o.value ?? 0n,
    gas: o.gas ?? 70_000n,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: 2_000_000_000n,
  });
}

type FakeLog = TransactionReceipt['logs'][number];
const makeLog = (address: Hex, topics: readonly Hex[], data: Hex): FakeLog => ({ address, topics, data }) as unknown as FakeLog;

function cardMintedLog(tokenId: bigint, address: Hex = CARDS): FakeLog {
  const topics = encodeEventTopics({ abi: nadCardsAbi, eventName: 'CardMinted', args: { tokenId, owner: account.address } });
  const data = encodeAbiParameters([{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint16' }], [0, 1, 30, 100]);
  return makeLog(address, topics as Hex[], data);
}

function duelCreatedLog(id: bigint, address: Hex = ARENA): FakeLog {
  const topics = encodeEventTopics({ abi: blitzArenaAbi, eventName: 'DuelCreated', args: { id, p1: account.address } });
  return makeLog(address, topics as Hex[], encodeAbiParameters([{ type: 'uint256' }], [7n]));
}

function receiptFor(hash: Hex, over: { status?: 'success' | 'reverted'; logs?: FakeLog[] } = {}): TransactionReceipt {
  return { transactionHash: hash, blockNumber: 123n, status: over.status ?? 'success', to: ARENA, logs: over.logs ?? [] } as unknown as TransactionReceipt;
}

type FakeChainOpts = {
  /** What a send does; default: ingest a success receipt into the hub synchronously and return the hash. */
  onSend?: (raw: Hex, hub: ReceiptHub) => Hex | void;
  chainReceipts?: Map<Hex, TransactionReceipt>;
};

function setup(opts: FakeChainOpts = {}, depsOver: Partial<RelayDeps> = {}) {
  const hub = createReceiptHub();
  const sent: Hex[] = [];
  const order: string[] = [];
  const spyHub: ReceiptHub = {
    ...hub,
    wait: (hash, ms) => {
      order.push('wait');
      return hub.wait(hash, ms);
    },
  };
  const client = {
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      order.push('send');
      sent.push(serializedTransaction);
      if (opts.onSend) return opts.onSend(serializedTransaction, hub) ?? keccak256(serializedTransaction);
      const hash = keccak256(serializedTransaction);
      hub.ingest(123n, [receiptFor(hash, { logs: [cardMintedLog(42n), duelCreatedLog(9n)] })]);
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = opts.chainReceipts?.get(hash);
      if (!r) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`);
      return r;
    },
  };
  const stats = { recordLatency: vi.fn() };
  const clock = { t: 1_000 };
  const deps: RelayDeps = {
    chain: { client: client as never, call: (fn) => fn(client as never) },
    hub: spyHub,
    stats,
    cfg: CFG,
    getBalance: async () => 10n ** 18n,
    now: () => clock.t,
    timeoutMs: 200,
    ...depsOver,
  };
  return { deps, hub, sent, order, stats, clock };
}

describe('validateRawTx', () => {
  test('accepts a signed attack tx to arena', async () => {
    const raw = await signTx();
    expect(validateRawTx(raw, CFG)).toMatchObject({ ok: true, fn: 'attack', hash: keccak256(raw) });
  });

  test('accepts freePull on cards and paidPull with value == pullPrice', async () => {
    expect(validateRawTx(await signTx({ to: CARDS, data: freePullData, gas: 150_000n }), CFG)).toMatchObject({ ok: true, fn: 'freePull' });
    expect(validateRawTx(await signTx({ to: CARDS, data: paidPullData, value: PULL_PRICE, gas: 150_000n }), CFG)).toMatchObject({ ok: true, fn: 'paidPull' });
  });

  test('matches the destination case-insensitively', async () => {
    const upper = `0x${ARENA.slice(2).toUpperCase()}` as Hex;
    const cfg = { ...CFG, arena: upper };
    expect(validateRawTx(await signTx(), cfg)).toMatchObject({ ok: true });
  });

  test('rejects wrong chain id', async () => {
    expect(validateRawTx(await signTx({ chainId: 1 }), CFG)).toEqual({ ok: false, reason: 'chain' });
  });

  test('rejects unknown contract', async () => {
    const to = '0x3333333333333333333333333333333333333333' as Hex;
    expect(validateRawTx(await signTx({ to }), CFG)).toEqual({ ok: false, reason: 'to' });
  });

  test('rejects transferFrom on cards', async () => {
    const data = encodeFunctionData({ abi: nadCardsAbi, functionName: 'transferFrom', args: [account.address, ARENA, 1n] });
    expect(validateRawTx(await signTx({ to: CARDS, data }), CFG)).toEqual({ ok: false, reason: 'selector' });
  });

  test('rejects a cards function sent to arena and an arena function sent to cards', async () => {
    expect(validateRawTx(await signTx({ to: ARENA, data: freePullData }), CFG)).toEqual({ ok: false, reason: 'selector' });
    expect(validateRawTx(await signTx({ to: CARDS, data: attackData }), CFG)).toEqual({ ok: false, reason: 'selector' });
  });

  test('rejects empty calldata', async () => {
    expect(validateRawTx(await signTx({ data: '0x' }), CFG)).toEqual({ ok: false, reason: 'selector' });
  });

  test('rejects non-zero value on a non-payable function', async () => {
    expect(validateRawTx(await signTx({ value: 1n }), CFG)).toEqual({ ok: false, reason: 'value' });
  });

  test('rejects paidPull with wrong value', async () => {
    const base = { to: CARDS, data: paidPullData, gas: 150_000n };
    expect(validateRawTx(await signTx({ ...base, value: 0n }), CFG)).toEqual({ ok: false, reason: 'value' });
    expect(validateRawTx(await signTx({ ...base, value: PULL_PRICE + 1n }), CFG)).toEqual({ ok: false, reason: 'value' });
  });

  test('rejects gas above the per-function limit', async () => {
    expect(validateRawTx(await signTx({ gas: 70_001n }), CFG)).toEqual({ ok: false, reason: 'gas' });
  });

  test('rejects a legacy (type 0) tx', async () => {
    const raw = await account.signTransaction({ type: 'legacy', chainId: 10143, nonce: 0, to: ARENA, data: attackData, value: 0n, gas: 70_000n, gasPrice: MAX_FEE });
    expect(validateRawTx(raw, CFG)).toEqual({ ok: false, reason: 'decode' });
  });

  test('rejects garbage hex and empty hex', () => {
    expect(validateRawTx('0xdeadbeef', CFG)).toEqual({ ok: false, reason: 'decode' });
    expect(validateRawTx('0x', CFG)).toEqual({ ok: false, reason: 'decode' });
    expect(validateRawTx('0x02zz' as Hex, CFG)).toEqual({ ok: false, reason: 'decode' });
  });

  test('rejects an unsigned type 2 tx', () => {
    const raw = serializeTransaction({ type: 'eip1559', chainId: 10143, nonce: 0, to: ARENA, data: attackData, gas: 70_000n, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: 1n });
    expect(validateRawTx(raw, CFG)).toEqual({ ok: false, reason: 'decode' });
  });
});

describe('handleRelay', () => {
  test('returns decoded tokenId and duelId and the receipt block', async () => {
    const { deps } = setup();
    const raw = await signTx();
    const res = await handleRelay({ rawTx: raw }, '1.1.1.1', deps);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ hash: keccak256(raw), status: 'success', blockNumber: '123', events: { tokenId: '42', duelId: '9' } });
  });

  test('ignores events emitted by other contracts', async () => {
    const other = '0x3333333333333333333333333333333333333333' as Hex;
    const { deps } = setup({
      onSend: (raw, hub) => {
        const hash = keccak256(raw);
        hub.ingest(1n, [receiptFor(hash, { logs: [cardMintedLog(5n, other), duelCreatedLog(6n, other)] })]);
      },
    });
    const res = await handleRelay({ rawTx: await signTx() }, 'ip', deps);
    expect(res.json).toMatchObject({ status: 'success', events: {} });
    expect((res.json as { events: object }).events).toEqual({});
  });

  test('reports a reverted receipt as status reverted', async () => {
    const { deps } = setup({
      onSend: (raw, hub) => {
        hub.ingest(1n, [receiptFor(keccak256(raw), { status: 'reverted' })]);
      },
    });
    const res = await handleRelay({ rawTx: await signTx() }, 'ip', deps);
    expect(res).toMatchObject({ status: 200, json: { status: 'reverted', events: {} } });
  });

  test('measures latency from arrival to ingest and records it', async () => {
    const { deps, clock, stats } = setup({
      onSend: (raw, hub) => {
        clock.t += 180;
        hub.ingest(1n, [receiptFor(keccak256(raw))]);
      },
    });
    const res = await handleRelay({ rawTx: await signTx() }, 'ip', deps);
    expect(res.json).toMatchObject({ latencyMs: 180 });
    expect(stats.recordLatency).toHaveBeenCalledWith(180);
  });

  test('registers the hub waiter before sending, even when the receipt arrives inside send', async () => {
    const { deps, order } = setup();
    await handleRelay({ rawTx: await signTx() }, 'ip', deps);
    expect(order).toEqual(['wait', 'send']);
  });

  test('treats already-known as pending and succeeds once the receipt is ingested', async () => {
    const { deps, hub } = setup({
      onSend: () => {
        throw new Error('already known');
      },
    });
    const raw = await signTx();
    const pending = handleRelay({ rawTx: raw }, 'ip', deps);
    await new Promise((r) => setTimeout(r, 20));
    hub.ingest(55n, [receiptFor(keccak256(raw))]);
    expect(await pending).toMatchObject({ status: 200, json: { status: 'success', blockNumber: '123' } });
  });

  test('matches already-known in the viem error details/shortMessage, case-insensitively', async () => {
    const err = Object.assign(new Error('Request failed'), { shortMessage: 'HTTP request failed', details: 'ALREADY KNOWN' });
    const { deps, hub } = setup({
      onSend: () => {
        throw err;
      },
    });
    const raw = await signTx();
    const pending = handleRelay({ rawTx: raw }, 'ip', deps);
    await new Promise((r) => setTimeout(r, 10));
    hub.ingest(55n, [receiptFor(keccak256(raw))]);
    expect((await pending).status).toBe(200);
  });

  test('nonce too low with an existing chain receipt returns it immediately', async () => {
    const raw = await signTx();
    const hash = keccak256(raw);
    const chainReceipts = new Map([[hash, receiptFor(hash, { logs: [cardMintedLog(77n)] })]]);
    const { deps } = setup(
      {
        chainReceipts,
        onSend: () => {
          throw new Error('nonce too low: next nonce 5, tx nonce 4');
        },
      },
      { timeoutMs: 5_000 },
    );
    const started = Date.now();
    const res = await handleRelay({ rawTx: raw }, 'ip', deps);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res).toMatchObject({ status: 200, json: { hash, status: 'success', events: { tokenId: '77' } } });
  });

  test('replacement transaction underpriced without a receipt keeps waiting then times out', async () => {
    const { deps } = setup({
      onSend: () => {
        throw new Error('replacement transaction underpriced');
      },
    });
    const raw = await signTx();
    const res = await handleRelay({ rawTx: raw }, 'ip', deps);
    expect(res).toEqual({ status: 504, json: { reason: 'timeout', hash: keccak256(raw) } });
  });

  test('two concurrent relays of the same raw tx both resolve from one receipt', async () => {
    let calls = 0;
    const { deps, hub } = setup({
      onSend: (raw) => {
        calls += 1;
        if (calls > 1) throw new Error('already known');
        return keccak256(raw);
      },
    });
    const raw = await signTx();
    const a = handleRelay({ rawTx: raw }, 'ip', deps);
    const b = handleRelay({ rawTx: raw }, 'ip', deps);
    await new Promise((r) => setTimeout(r, 20));
    hub.ingest(9n, [receiptFor(keccak256(raw))]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect((ra.json as { hash: Hex }).hash).toBe((rb.json as { hash: Hex }).hash);
  });

  test('returns 504 with the hash when no receipt arrives in time', async () => {
    const { deps } = setup({ onSend: (raw) => keccak256(raw) }, { timeoutMs: 30 });
    const raw = await signTx();
    const res = await handleRelay({ rawTx: raw }, 'ip', deps);
    expect(res).toEqual({ status: 504, json: { reason: 'timeout', hash: keccak256(raw) } });
  });

  test('other send errors become 400 send with a short message only', async () => {
    const err = Object.assign(new Error('insufficient funds for gas\nVersion: viem@2.0\nstack...'), { shortMessage: 'insufficient funds for gas * price + value' });
    const { deps } = setup({
      onSend: () => {
        throw err;
      },
    });
    const res = await handleRelay({ rawTx: await signTx() }, 'ip', deps);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ reason: 'send', message: 'insufficient funds for gas * price + value' });
  });

  test('bad bodies are rejected with reason decode', async () => {
    const { deps } = setup();
    for (const body of [null, undefined, {}, { rawTx: 123 }, { rawTx: 'nothex' }, 'str', []]) {
      expect(await handleRelay(body, 'ip', deps)).toEqual({ status: 400, json: { reason: 'decode' } });
    }
  });

  test('validation failures return 400 with the validator reason', async () => {
    const { deps, sent } = setup();
    const res = await handleRelay({ rawTx: await signTx({ value: 1n }) }, 'ip', deps);
    expect(res).toEqual({ status: 400, json: { reason: 'value' } });
    expect(sent).toHaveLength(0);
  });

  test('rejects early when the balance cannot cover gas x maxFeePerGas + value', async () => {
    const need = 70_000n * MAX_FEE;
    const low = setup({}, { getBalance: async () => need - 1n });
    expect(await handleRelay({ rawTx: await signTx() }, 'ip', low.deps)).toEqual({ status: 400, json: { reason: 'balance' } });
    expect(low.sent).toHaveLength(0);
    const exact = setup({}, { getBalance: async () => need });
    expect((await handleRelay({ rawTx: await signTx() }, 'ip', exact.deps)).status).toBe(200);
  });

  test('includes value in the balance check', async () => {
    const raw = await signTx({ to: CARDS, data: paidPullData, value: PULL_PRICE, gas: 150_000n });
    const { deps } = setup({}, { getBalance: async () => 150_000n * MAX_FEE + PULL_PRICE - 1n });
    expect(await handleRelay({ rawTx: raw }, 'ip', deps)).toEqual({ status: 400, json: { reason: 'balance' } });
  });

  test('a failing balance lookup returns 400 send instead of throwing', async () => {
    const { deps } = setup({}, { getBalance: async () => { throw new Error('cache down'); } });
    const res = await handleRelay({ rawTx: await signTx() }, 'ip', deps);
    expect(res).toEqual({ status: 400, json: { reason: 'send', message: 'balance lookup failed' } });
  });

  test('429 after 3 txs per second from one sender, recovers after the window', async () => {
    const { deps, clock } = setup();
    for (let nonce = 0; nonce < 3; nonce++) {
      expect((await handleRelay({ rawTx: await signTx({ nonce }) }, 'ip', deps)).status).toBe(200);
    }
    expect(await handleRelay({ rawTx: await signTx({ nonce: 3 }) }, 'ip', deps)).toEqual({ status: 429, json: { reason: 'rate' } });
    clock.t += 1_001;
    expect((await handleRelay({ rawTx: await signTx({ nonce: 3 }) }, 'ip', deps)).status).toBe(200);
  });

  test('a resend of the same hash is not double counted', async () => {
    const { deps } = setup();
    const raw = await signTx();
    for (let i = 0; i < 6; i++) expect((await handleRelay({ rawTx: raw }, 'ip', deps)).status).toBe(200);
    expect((await handleRelay({ rawTx: await signTx({ nonce: 1 }) }, 'ip', deps)).status).toBe(200);
  });

  test('requests rejected by validation do not consume rate budget', async () => {
    const { deps } = setup();
    for (let i = 0; i < 5; i++) await handleRelay({ rawTx: await signTx({ value: 1n, nonce: i }) }, 'ip', deps);
    for (let nonce = 0; nonce < 3; nonce++) {
      expect((await handleRelay({ rawTx: await signTx({ nonce }) }, 'ip', deps)).status).toBe(200);
    }
  });

  test('429 after 30 txs per second from one IP across senders', async () => {
    const { deps } = setup();
    const signers = Array.from({ length: 11 }, (_, i) => privateKeyToAccount(toHex(i + 1, { size: 32 })));
    let ok = 0;
    for (const signer of signers) {
      for (let nonce = 0; nonce < 3 && ok < 30; nonce++) {
        expect((await handleRelay({ rawTx: await signTx({ signer, nonce }) }, '9.9.9.9', deps)).status).toBe(200);
        ok += 1;
      }
    }
    const blocked = await handleRelay({ rawTx: await signTx({ signer: signers[10]!, nonce: 5 }) }, '9.9.9.9', deps);
    expect(blocked).toEqual({ status: 429, json: { reason: 'rate' } });
    const otherIp = await handleRelay({ rawTx: await signTx({ signer: signers[10]!, nonce: 5 }) }, '8.8.8.8', deps);
    expect(otherIp.status).toBe(200);
  });
});

describe('createRateLimiter', () => {
  test('prunes expired entries so memory stays bounded', () => {
    const clock = { t: 0 };
    const limiter = createRateLimiter(() => clock.t);
    for (let i = 0; i < 200; i++) {
      clock.t = i * 10_000;
      limiter.allow(`sender${i}`, `ip${i}`, `0x${i.toString(16).padStart(64, '0')}` as Hex);
    }
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});
