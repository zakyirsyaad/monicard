import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Hex } from 'viem';

/** Repo root: `server/src/env.ts` -> `server/src` -> `server` -> repo. */
export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  // Node's parser handles quoted values (EVENT_NAME contains spaces). Never shell-source .env.
  process.loadEnvFile(envPath);
}

const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x followed by 64 hex characters');
const optionalHexKey = z.preprocess(emptyToUndefined, hexKey.optional());

const boolFromEnv = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const text = String(value).toLowerCase();
    return text === 'true' || text === '1' || text === 'yes';
  }, z.boolean());

const envSchema = z.object({
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65_535).default(8080)),
  DEPLOYMENT: z.preprocess(emptyToUndefined, z.enum(['testnet', 'anvil', 'mainnet']).default('testnet')),
  PUBLIC_URL: optionalString,
  BATCH_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(1000)),
  DATA_DIR: optionalString,
  RPC_URLS: z.string().min(1),
  MASTER_KEY: hexKey,
  OPERATOR_KEY: hexKey,
  AGENT_KEY: hexKey,
  ADMIN_TOKEN: z.string().min(1),
  FUND_ENABLED: boolFromEnv(false),
  FUND_BUDGET_MON: z.preprocess(emptyToUndefined, z.coerce.number().nonnegative().default(3)),
  EVENT_NAME: z.preprocess(emptyToUndefined, z.string().min(1).default('NadGacha BlitzArena')),
  EVENT_SPONSOR: optionalString,
  LLM_BASE_URL: optionalString,
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  ETHERSCAN_API_KEY: optionalString,
  MAINNET_RPC_URL: optionalString,
  MAINNET_DEPLOYER_KEY: optionalHexKey,
});

const deploymentSchema = z.object({
  chainId: z.number().int().positive(),
  cards: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  arena: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  deployBlock: z.number().int().nonnegative().optional(),
  gasLimits: z.object({
    freePull: z.number().int().positive(),
    paidPull: z.number().int().positive(),
    createDuel: z.number().int().positive(),
    joinDuel: z.number().int().positive(),
    attack: z.number().int().positive(),
    settle: z.number().int().positive(),
  }),
});

export type GasLimits = z.infer<typeof deploymentSchema>['gasLimits'];

export type Env = {
  PORT: number;
  DEPLOYMENT: 'testnet' | 'anvil' | 'mainnet';
  PUBLIC_URL?: string;
  BATCH_MS: number;
  DATA_DIR: string;
  RPC_URLS: string[];
  MASTER_KEY: Hex;
  OPERATOR_KEY: Hex;
  AGENT_KEY: Hex;
  ADMIN_TOKEN: string;
  FUND_ENABLED: boolean;
  FUND_BUDGET_MON: number;
  EVENT_NAME: string;
  EVENT_SPONSOR?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  ETHERSCAN_API_KEY?: string;
  MAINNET_RPC_URL?: string;
  MAINNET_DEPLOYER_KEY?: Hex;
  ROOT: string;
  chainId: number;
  cards: Hex;
  arena: Hex;
  gasLimits: GasLimits;
};

function parseRpcUrls(raw: string): string[] {
  const urls = raw
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (urls.length === 0) throw new Error('RPC_URLS must list at least one RPC endpoint');
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`RPC_URLS contains an invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`RPC_URLS must use http or https: ${url}`);
    }
  }
  return urls;
}

function buildEnv(): Env {
  const parsed = envSchema.parse(process.env);
  const rpcUrls = parseRpcUrls(parsed.RPC_URLS);

  const deploymentPath = join(ROOT, 'deployments', `${parsed.DEPLOYMENT}.json`);
  let deploymentRaw: unknown;
  try {
    deploymentRaw = JSON.parse(readFileSync(deploymentPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read deployment ${deploymentPath}: ${(error as Error).message}`);
  }
  const deployment = deploymentSchema.parse(deploymentRaw);

  return {
    ...parsed,
    RPC_URLS: rpcUrls,
    DATA_DIR: parsed.DATA_DIR ? resolve(ROOT, parsed.DATA_DIR) : join(ROOT, 'data'),
    MASTER_KEY: parsed.MASTER_KEY as Hex,
    OPERATOR_KEY: parsed.OPERATOR_KEY as Hex,
    AGENT_KEY: parsed.AGENT_KEY as Hex,
    MAINNET_DEPLOYER_KEY: parsed.MAINNET_DEPLOYER_KEY as Hex | undefined,
    ROOT,
    chainId: deployment.chainId,
    cards: deployment.cards as Hex,
    arena: deployment.arena as Hex,
    gasLimits: deployment.gasLimits,
  };
}

let cached: Env | null = null;

/** Parses `.env` + the deployment file on first use, so importing a module for tests needs no secrets. */
export function loadEnv(): Env {
  if (!cached) cached = buildEnv();
  return cached;
}

export const env: Env = new Proxy({} as Env, {
  get(_target, property) {
    return Reflect.get(loadEnv(), property);
  },
});