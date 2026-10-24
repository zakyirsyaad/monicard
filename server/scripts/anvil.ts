import { spawn, type ChildProcess } from 'node:child_process';
import { battleBytecode, blitzArenaBytecode, nadCardsBytecode, stakeVaultBytecode } from '@nad/shared/bytecode';
import { battleAbi, blitzArenaAbi, nadCardsAbi, stakeVaultAbi, type Hex } from '@nad/shared';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  toHex,
  TransactionReceiptNotFoundError,
  type Account,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

export const ANVIL_CHAIN_ID = 10143;
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const DEFAULT_PORT = 8546;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;
const RECEIPT_POLL_MS = 25;
const RECEIPT_TIMEOUT_MS = 30_000;
const SEND_GAS = 500_000n;
const PRIORITY_FEE = 2_000_000_000n;
const GAS_PRICE_HEADROOM = 2n;
const OUTPUT_TAIL_CHARS = 2_000;

// viem caches getBlockNumber for cacheTime (default 4 s): always create clients with cacheTime: 0 against anvil.
export const anvilChain = defineChain({
  id: ANVIL_CHAIN_ID,
  name: 'anvil',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${DEFAULT_PORT}`] } },
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Deployer account from the default anvil mnemonic (no raw key in source). */
export const anvilDeployer = (): Account => mnemonicToAccount(ANVIL_MNEMONIC);

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export type AnvilHandle = { rpcUrl: string; mine(blocks: number): Promise<void>; stop(): void };

async function waitUntilReady(child: ChildProcess, rpcUrl: string, output: () => string, exited: () => boolean) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited()) throw new Error(`anvil exited before it was ready:\n${output()}`);
    // Anvil prints "Listening on" once bound; this keeps us from talking to a foreign process on the port.
    if (output().includes('Listening on')) {
      try {
        await rpc(rpcUrl, 'eth_chainId', []);
        return;
      } catch {
        // not answering yet
      }
    }
    await sleep(READY_POLL_MS);
  }
  child.kill('SIGTERM');
  throw new Error(`anvil not ready after ${READY_TIMEOUT_MS} ms:\n${output()}`);
}

export type StartAnvilOptions = {
  /** Mine on a timer (`--block-time <n>`, fractions allowed) instead of the default `--no-mining`. */
  blockTimeSec?: number;
};

/** Start `anvil --no-mining` (or `--block-time n`) on chain id 10143 and resolve once it answers JSON-RPC. */
export async function startAnvil(port = DEFAULT_PORT, options: StartAnvilOptions = {}): Promise<AnvilHandle> {
  const miningArgs = options.blockTimeSec === undefined ? ['--no-mining'] : ['--block-time', String(options.blockTimeSec)];
  const child = spawn('anvil', ['--chain-id', String(ANVIL_CHAIN_ID), ...miningArgs, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  let exited = false;
  const append = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', (error) => {
    buffer += `\nspawn error: ${error.message}`;
    exited = true;
  });
  const killOnExit = () => child.kill('SIGTERM');
  process.on('exit', killOnExit);

  const rpcUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilReady(child, rpcUrl, () => buffer, () => exited);
  } catch (error) {
    process.off('exit', killOnExit);
    child.kill('SIGTERM');
    throw error;
  }
  return {
    rpcUrl,
    async mine(blocks: number) {
      await rpc(rpcUrl, 'anvil_mine', [toHex(blocks)]);
    },
    stop() {
      process.off('exit', killOnExit);
      child.kill('SIGTERM');
    },
  };
}

export async function fundAccount(rpcUrl: string, address: Hex, wei: bigint): Promise<void> {
  await rpc(rpcUrl, 'anvil_setBalance', [address, toHex(wei)]);
}

/**
 * Poll for a receipt every ~25 ms (viem's default 4 s polling is far too slow for 300 ms blocks).
 * Only "receipt not found" is retried; any other error (connection refused, ...) is rethrown at once.
 */
export async function waitForReceipt(client: PublicClient, hash: Hex): Promise<TransactionReceipt> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  let lastNotFound: unknown;
  while (Date.now() < deadline) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      lastNotFound = error;
      await sleep(RECEIPT_POLL_MS);
    }
  }
  throw new Error(`receipt for ${hash} not found after ${RECEIPT_TIMEOUT_MS} ms`, { cause: lastNotFound });
}

export type DeployedGame = { cards: Hex; arena: Hex; battle: Hex; stakeVault: Hex };

/**
 * Deploy NadCards, BlitzArena, CardBattle and StakeVault and wire the arena.
 * Each tx is mined explicitly with `mine(1)`; the order fixes the throwaway anvil addresses recorded in
 * `deployments/anvil.json` (engine nonce 0..3).
 */
export async function deployGame(
  rpcUrl: string,
  deployer: Account,
  mine: (blocks: number) => Promise<void>,
): Promise<DeployedGame> {
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: anvilChain, transport, cacheTime: 0 });
  const wallet = createWalletClient({ chain: anvilChain, transport, account: deployer });

  const minedReceipt = async (label: string, send: () => Promise<Hex>): Promise<TransactionReceipt> => {
    const hash = await send();
    await mine(1);
    const receipt = await waitForReceipt(publicClient, hash);
    if (receipt.status !== 'success') throw new Error(`deployGame: ${label} did not succeed`);
    return receipt;
  };
  const addressOf = (label: string, receipt: TransactionReceipt): Hex => {
    if (!receipt.contractAddress) throw new Error(`deployGame: ${label} receipt has no contract address`);
    return receipt.contractAddress;
  };

  const cards = addressOf(
    'NadCards',
    await minedReceipt('NadCards deploy', () => wallet.deployContract({ abi: nadCardsAbi, bytecode: nadCardsBytecode })),
  );
  const arena = addressOf(
    'BlitzArena',
    await minedReceipt('BlitzArena deploy', () =>
      wallet.deployContract({ abi: blitzArenaAbi, bytecode: blitzArenaBytecode, args: [cards] }),
    ),
  );
  const battle = addressOf(
    'CardBattle',
    await minedReceipt('CardBattle deploy', () =>
      wallet.deployContract({ abi: battleAbi, bytecode: battleBytecode }),
    ),
  );
  const stakeVault = addressOf(
    'StakeVault',
    await minedReceipt('StakeVault deploy', () =>
      wallet.deployContract({ abi: stakeVaultAbi, bytecode: stakeVaultBytecode, args: [arena] }),
    ),
  );
  await minedReceipt('setArena', () =>
    wallet.writeContract({ address: cards, abi: nadCardsAbi, functionName: 'setArena', args: [arena] }),
  );
  return { cards, arena, battle, stakeVault };
}

export type AnvilSender = {
  address: Hex;
  send(data: Hex, value?: bigint): Promise<TransactionReceipt>;
};

/**
 * Sender with a local nonce (advanced only after the node accepted the raw tx, resynced from chain on error).
 * It does not mine: the caller runs a miner or calls `mine(1)` itself.
 */
export async function createAnvilSender(rpcUrl: string, account: Account, to: Hex): Promise<AnvilSender> {
  const client = createPublicClient({ chain: anvilChain, transport: http(rpcUrl), cacheTime: 0 });
  const gasPrice = await client.getGasPrice();
  // The max() keeps maxFee >= tip when anvil's base fee has decayed below 1 gwei.
  const maxFeePerGas = gasPrice * GAS_PRICE_HEADROOM > PRIORITY_FEE ? gasPrice * GAS_PRICE_HEADROOM : PRIORITY_FEE;
  const address = account.address;
  const sign = account.signTransaction;
  if (!sign) throw new Error('createAnvilSender: account cannot sign transactions');

  const syncNonce = () => client.getTransactionCount({ address, blockTag: 'pending' });
  let nonce = await syncNonce();
  let queue: Promise<unknown> = Promise.resolve();

  const submit = async (data: Hex, value: bigint): Promise<Hex> => {
    try {
      const serializedTransaction = await sign({
        type: 'eip1559',
        chainId: ANVIL_CHAIN_ID,
        to,
        data,
        value,
        nonce,
        gas: SEND_GAS,
        maxFeePerGas,
        maxPriorityFeePerGas: PRIORITY_FEE,
      });
      const hash = await client.sendRawTransaction({ serializedTransaction });
      nonce += 1;
      return hash;
    } catch (error) {
      // Resync from chain, but never let a failing resync hide the original send error.
      try {
        nonce = await syncNonce();
      } catch {
        // keep the local nonce; the next send will fail loudly if it is wrong
      }
      throw error;
    }
  };

  return {
    address,
    async send(data, value = 0n) {
      // Serialize nonce use per sender; receipt waiting happens outside the queue.
      const pending = queue.then(() => submit(data, value));
      queue = pending.catch(() => undefined);
      return waitForReceipt(client, await pending);
    },
  };
}

export type Miner = {
  /** Stops the loop and waits for it. Never throws: check `failure()` afterwards. */
  stop(): Promise<void>;
  /** The error that made the miner give up (the loop stops at the first failing `mine`), else null. */
  failure(): Error | null;
};

/**
 * Sequential interval miner: never overlaps `mine` calls. A failing `mine` ends the loop and is
 * remembered (and passed to `onError`) instead of surfacing as an unhandled rejection.
 */
export function startMiner(
  mine: (blocks: number) => Promise<void>,
  intervalMs: number,
  blocksPerTick = 1,
  onError?: (error: Error) => void,
): Miner {
  let running = true;
  let failure: Error | null = null;
  const loop = (async () => {
    while (running) {
      try {
        await mine(blocksPerTick);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        running = false;
        onError?.(failure);
        return;
      }
      await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
    },
    failure: () => failure,
  };
}
