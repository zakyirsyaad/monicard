import { encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import { ApiError } from '../api';
import { sendCall } from '../actions';
import { actionDeps } from '../player';
import type { Config, RelayResult } from '../types';
import { battleAbi } from './abi';
import { readMatchCount } from './chain';
import { ensureBattleWallet } from './fund';
import type { WalletStep } from './fund';
import { battleMock } from './mock';
import { isBattleMock } from './useMatch';
import type { AgentBattleResult } from './types';

type StepHandler = (step: WalletStep) => void;

/** Gas fallback when `/config` omits the battle limits (BATTLE-SPEC: 300,000 for every function). */
const DEFAULT_GAS = 300_000;
const FAKE_BATTLE: Hex = '0x00000000000000000000000000000000000000b2';

type BattleGasFn = 'createMatch' | 'joinMatch' | 'act' | 'claimTimeout';

type BattleConfig = Config & {
  contracts: Config['contracts'] & { battle?: Hex };
  gasLimits: Config['gasLimits'] & Partial<Record<BattleGasFn, number>>;
};

export class BattleUnavailable extends Error {
  constructor() {
    super('Card Battle is not deployed');
    this.name = 'BattleUnavailable';
  }
}

export function battleAddress(config: Config): Hex {
  if (isBattleMock()) return FAKE_BATTLE;
  const address = (config as BattleConfig).contracts.battle;
  if (!address) throw new BattleUnavailable();
  return address;
}

export function battleAvailable(config: Config | null): boolean {
  if (isBattleMock()) return true;
  return config !== null && (config as BattleConfig).contracts.battle !== undefined;
}

function gasFor(config: Config, fn: BattleGasFn): number {
  return (config as BattleConfig).gasLimits[fn] ?? DEFAULT_GAS;
}

function mockResult(status: 'success' | 'reverted'): RelayResult {
  return {
    hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    status,
    latencyMs: 0,
    blockNumber: String(battleMock.block()),
    events: {},
  };
}

export type CreatedBattle = { id: string | null; result: RelayResult };

/** `createMatch()`; the id comes from the relay's `events.matchId`, else from `matchCount() - 1`. */
export async function createBattle(config: Config, onStep?: StepHandler): Promise<CreatedBattle> {
  if (isBattleMock()) {
    onStep?.('send');
    const { account } = actionDeps(config);
    const id = battleMock.createMatch(account.address);
    return { id, result: mockResult('success') };
  }
  const deps = actionDeps(config);
  await ensureBattleWallet(deps, onStep);
  const to = battleAddress(config);
  const data = encodeFunctionData({ abi: battleAbi, functionName: 'createMatch' });
  const result = await sendCall(deps, {
    fn: 'createMatch',
    to,
    data,
    gas: gasFor(config, 'createMatch'),
  });
  if (result.status !== 'success') throw new ApiError(200, 'createMatch_reverted');
  const events = result.events as { matchId?: string };
  if (events.matchId !== undefined) return { id: events.matchId, result };
  const count = await readMatchCount(to);
  return { id: count > 0 ? String(count - 1) : null, result };
}

function relayBattle(
  config: Config,
  fn: BattleGasFn,
  call: { to: Hex; data: Hex; gas: number },
): Promise<RelayResult> {
  return sendCall(actionDeps(config), { fn, ...call });
}

export async function joinBattle(config: Config, id: string, onStep?: StepHandler): Promise<RelayResult> {
  if (isBattleMock()) {
    onStep?.('send');
    const { account } = actionDeps(config);
    return mockResult(battleMock.joinMatch(id, account.address) ? 'success' : 'reverted');
  }
  const deps = actionDeps(config);
  await ensureBattleWallet(deps, onStep);
  return sendCall(deps, {
    fn: 'joinMatch',
    to: battleAddress(config),
    data: encodeFunctionData({ abi: battleAbi, functionName: 'joinMatch', args: [BigInt(id)] }),
    gas: gasFor(config, 'joinMatch'),
  });
}

export async function actBattle(
  config: Config,
  id: string,
  handIdx: number,
  special: boolean,
  onStep?: StepHandler,
): Promise<RelayResult> {
  if (isBattleMock()) {
    onStep?.('send');
    const { account } = actionDeps(config);
    return mockResult(battleMock.act(id, account.address, handIdx, special).ok ? 'success' : 'reverted');
  }
  const deps = actionDeps(config);
  await ensureBattleWallet(deps, onStep);
  return sendCall(deps, {
    fn: 'act',
    to: battleAddress(config),
    data: encodeFunctionData({
      abi: battleAbi,
      functionName: 'act',
      args: [BigInt(id), handIdx, special],
    }),
    gas: gasFor(config, 'act'),
  });
}

export async function claimBattleTimeout(config: Config, id: string, onStep?: StepHandler): Promise<RelayResult> {
  if (isBattleMock()) {
    onStep?.('send');
    const { account } = actionDeps(config);
    return mockResult(battleMock.claimTimeout(id, account.address).ok ? 'success' : 'reverted');
  }
  const deps = actionDeps(config);
  await ensureBattleWallet(deps, onStep);
  return sendCall(deps, {
    fn: 'claimTimeout',
    to: battleAddress(config),
    data: encodeFunctionData({ abi: battleAbi, functionName: 'claimTimeout', args: [BigInt(id)] }),
    gas: gasFor(config, 'claimTimeout'),
  });
}

/** `POST /agent/battle`: the AI Agent joins an Open match and plays it to the end. */
export async function challengeBattleAgent(config: Config, id: string): Promise<AgentBattleResult> {
  if (isBattleMock()) {
    return battleMock.joinAgent(id) ? { ok: true } : { ok: false, reason: 'not_open' };
  }
  const res = await fetch('/agent/battle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ matchId: id }),
  });
  if (res.ok) return { ok: true };
  const body: unknown = await res.json().catch(() => null);
  const reason =
    body && typeof body === 'object' && 'reason' in body && typeof body.reason === 'string'
      ? body.reason
      : `http_${res.status}`;
  if (res.status === 409 || res.status === 429) return { ok: false, reason };
  throw new ApiError(res.status, reason);
}
