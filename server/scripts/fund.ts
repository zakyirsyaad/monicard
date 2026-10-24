/**
 * CLI fallback for /fund: fund <address> [amountMON=0.3]
 * Reads MASTER_KEY and RPC_URLS (first URL) from the repo root .env.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, isAddress, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAIN_ID = 10143;
const PRIORITY_FEE_WEI = 2_000_000_000n;
const POLL_MS = 300;
const TIMEOUT_MS = 30_000;
const DEFAULT_AMOUNT_MON = '0.3';
const EXPLORER_TX = 'https://testnet.monadscan.com/tx/';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const MASTER_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function parseEnvValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = parseEnvValue(trimmed.slice(eq + 1).trim());
  }
  return out;
}

function loadEnv(): Record<string, string> {
  const path = fileURLToPath(new URL('../../.env', import.meta.url));
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return fail(`cannot read ${path}`);
  }
}

function parseArgs(): { to: Hex; amountMon: string } {
  const [address, amount = DEFAULT_AMOUNT_MON] = process.argv.slice(2);
  if (!address || !isAddress(address, { strict: false })) fail('usage: fund <address> [amountMON=0.3]');
  try {
    parseEther(amount);
  } catch {
    fail(`invalid amount: ${amount}`);
  }
  return { to: address as Hex, amountMon: amount };
}

async function main(): Promise<void> {
  const { to, amountMon } = parseArgs();
  const env = loadEnv();
  const key = env.MASTER_KEY;
  const rpc = env.RPC_URLS?.split(',')[0]?.trim();
  if (!key) fail('MASTER_KEY missing in .env');
  if (!MASTER_KEY_PATTERN.test(key)) fail('MASTER_KEY in .env is not a 0x-prefixed 32-byte hex key');
  if (!rpc) fail('RPC_URLS missing in .env');

  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain,
    transport: http(rpc),
  });
  const gasPrice = await publicClient.getGasPrice();
  const hash = await wallet.sendTransaction({
    to,
    value: parseEther(amountMon),
    gas: 21_000n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: PRIORITY_FEE_WEI,
  });

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) {
      if (receipt.status !== 'success') fail(`transfer reverted: ${EXPLORER_TX}${hash}`);
      console.log(`funded ${to} ${amountMon} MON tx ${hash}`);
      console.log(`${EXPLORER_TX}${hash}`);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  fail(`no receipt after ${TIMEOUT_MS / 1000}s: ${EXPLORER_TX}${hash}`);
}

main().catch((e: unknown) => fail(`fund failed: ${e instanceof Error ? e.message : String(e)}`));
