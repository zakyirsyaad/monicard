import { describe, expect, test } from 'vitest';
import { parseEther, type Account, type Hex, type PublicClient } from 'viem';
import { createWalletQueue, type WalletChain } from '../src/walletQueue';

const USER = '0x1111111111111111111111111111111111111111' as Hex;
const TO = '0x2222222222222222222222222222222222222222' as Hex;
const DATA = '0xdeadbeef' as Hex;

type SignedTx = {
  chainId: number;
  type: string;
  nonce: number;
  to: Hex;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

function fakeAccount(): { account: Account; signed: SignedTx[] } {
  const signed: SignedTx[] = [];
  const account = {
    address: USER,
    signTransaction: async (tx: SignedTx): Promise<Hex> => {
      signed.push(tx);
      return `0x02${'ab'.repeat(64)}` as Hex;
    },
  } as unknown as Account;
  return { account, signed };
}

type SendFailure = { error: Error; nextNonce?: number };

type FakeChainOptions = {
  signed: SignedTx[];
  startNonce?: number;
  balance?: bigint;
  gasPrice?: bigint;
  block?: bigint;
  failSend?: (nonce: number) => SendFailure | null;
  beforeSend?: (nonce: number) => Promise<void>;
};

type FakeChain = WalletChain & {
  sends: number[];
  events: string[];
  pendingNonce(): number;
};

function fakeChain(opts: FakeChainOptions): FakeChain {
  let pending = opts.startNonce ?? 7;
  let block = opts.block ?? 100n;
  const sends: number[] = [];
  const events: string[] = [];

  const client = {
    getTransactionCount: async () => {
      events.push(`nonce:${pending}`);
      return pending;
    },
    getBalance: async () => opts.balance ?? 0n,
    getBlockNumber: async () => {
      const current = block;
      block += 1n;
      return current;
    },
    sendRawTransaction: async () => {
      const nonce = opts.signed[opts.signed.length - 1]?.nonce;
      if (nonce === undefined) throw new Error('sendRawTransaction called before signTransaction');
      sends.push(nonce);
      events.push(`send:${nonce}:start`);
      await opts.beforeSend?.(nonce);
      const failure = opts.failSend?.(nonce) ?? null;
      if (failure) {
        if (failure.nextNonce !== undefined) pending = failure.nextNonce;
        events.push(`send:${nonce}:error`);
        throw failure.error;
      }
      pending = Math.max(pending, nonce + 1);
      events.push(`send:${nonce}:ok`);
      return `0x${'cd'.repeat(32)}` as Hex;
    },
  } as unknown as PublicClient;

  return {
    chainId: 10143,
    client,
    call: async (fn) => fn(client),
    getGasPrice: async () => opts.gasPrice ?? 100_000_000_000n,
    sends,
    events,
    pendingNonce: () => pending,
  };
}

const tx = { to: TO, data: DATA, gas: 100_000n };

describe('wallet queue', () => {
  test('sends sequentially with increasing nonces', async () => {
    const { account, signed } = fakeAccount();
    const chain = fakeChain({ signed });
    const queue = createWalletQueue(account, chain);

    await Promise.all([queue.send(tx), queue.send(tx), queue.send(tx)]);

    expect(signed.map((t) => t.nonce)).toEqual([7, 8, 9]);
    expect(chain.sends).toEqual([7, 8, 9]);
    expect(queue.address).toBe(USER);
  });

  test('serializes resyncNonce behind an in-flight send', async () => {
    const { account, signed } = fakeAccount();
    let reached!: () => void;
    const reachedGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = fakeChain({
      signed,
      startNonce: 7,
      beforeSend: async () => {
        reached();
        await sendGate;
      },
    });
    const queue = createWalletQueue(account, chain);

    const first = queue.send(tx);
    await reachedGate; // the send now holds the queue inside sendRawTransaction

    let resynced = false;
    const resync = queue.resyncNonce().then(() => {
      resynced = true;
    });
    await Promise.resolve();
    expect(resynced).toBe(false);
    expect(chain.events).toEqual(['nonce:7', 'send:7:start']);

    release();
    await first;
    await resync;

    // The resync read the chain only after the send finished, not while it was in flight.
    expect(chain.events).toEqual(['nonce:7', 'send:7:start', 'send:7:ok', 'nonce:8']);

    await queue.send(tx);
    expect(signed.map((t) => t.nonce)).toEqual([7, 8]);
  });

  test('resyncs nonce after a nonce error and retries once', async () => {
    const { account, signed } = fakeAccount();
    const chain = fakeChain({
      signed,
      // Another tx from this wallet landed while ours was rejected.
      failSend: (nonce) =>
        nonce === 7 ? { error: new Error('nonce too low'), nextNonce: 9 } : null,
    });
    const queue = createWalletQueue(account, chain);

    await queue.send(tx);

    expect(signed.map((t) => t.nonce)).toEqual([7, 9]);
    expect(chain.sends).toEqual([7, 9]);
  });

  test('retries a nonce error only once', async () => {
    const { account, signed } = fakeAccount();
    const chain = fakeChain({
      signed,
      failSend: (nonce) => ({ error: new Error('nonce too low'), nextNonce: nonce + 1 }),
    });
    const queue = createWalletQueue(account, chain);

    await expect(queue.send(tx)).rejects.toThrow(/nonce too low/);
    expect(chain.sends).toEqual([7, 8]);
  });

  test('failed send does not leave a nonce gap', async () => {
    const { account, signed } = fakeAccount();
    let failed = false;
    const chain = fakeChain({
      signed,
      failSend: (nonce) => {
        if (nonce !== 8 || failed) return null;
        failed = true;
        return { error: new Error('insufficient funds for gas * price + value') };
      },
    });
    const queue = createWalletQueue(account, chain);

    await queue.send(tx);
    await expect(queue.send(tx)).rejects.toThrow(/insufficient funds/);
    await queue.send(tx);

    expect(signed.map((t) => t.nonce)).toEqual([7, 8, 8]);
    expect(chain.sends).toEqual([7, 8, 8]);
  });

  test('signs EIP-1559 fees from the chain gas price', async () => {
    const { account, signed } = fakeAccount();
    const chain = fakeChain({ signed, gasPrice: 100_000_000_000n });
    await createWalletQueue(account, chain).send(tx);

    expect(signed[0]).toMatchObject({
      chainId: 10143,
      type: 'eip1559',
      nonce: 7,
      to: TO,
      data: DATA,
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 200_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
  });

  test('value tx from a sub-10-MON wallet waits three blocks (N9)', async () => {
    const { account, signed } = fakeAccount();
    const chain = fakeChain({ signed, balance: parseEther('5'), block: 100n });
    const sleeps: number[] = [];
    const queue = createWalletQueue(account, chain, {
      pollMs: 300,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    // First tx is free (no value): it only records the block.
    await queue.send(tx);
    expect(sleeps).toEqual([]);

    await queue.send({ ...tx, value: parseEther('0.1') });

    // Blocks 101 and 102 are too soon; 103 (lastTxBlock + 3) is the first allowed.
    expect(sleeps).toEqual([300, 300]);
    expect(signed.map((t) => t.nonce)).toEqual([7, 8]);
  });

  test('value tx from a wallet at or above 10 MON does not wait', async () => {
    const { account, signed } = fakeAccount();
    const chain = fakeChain({ signed, balance: parseEther('10'), block: 100n });
    const sleeps: number[] = [];
    const queue = createWalletQueue(account, chain, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await queue.send(tx);
    await queue.send({ ...tx, value: parseEther('0.1') });

    expect(sleeps).toEqual([]);
  });

  test('a zero-value tx from a low-balance wallet never waits', async () => {
    const { account, signed } = fakeAccount();
    const chain = fakeChain({ signed, balance: 1n, block: 100n });
    const sleeps: number[] = [];
    const queue = createWalletQueue(account, chain, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await queue.send(tx);
    await queue.send(tx);

    expect(sleeps).toEqual([]);
  });
});