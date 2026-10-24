import {
  FundError,
  MIN_FUND_WEI,
  TX_GAP_MS,
  createDuel,
  defaultSleep,
  ensureFunds,
  freePull,
  msSinceLastTx,
  mustSucceed,
  paidPull,
} from './actions';
import type { ActionDeps } from './actions';

/** The balance is still under pull price + reserve after funding. */
export class InsufficientFundsError extends Error {
  constructor() {
    super('Not enough test MON');
    this.name = 'InsufficientFundsError';
  }
}

function requireEvent(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Relay result has no ${name}`);
  return value;
}

/** ensureFunds; for a paid pull a refused top-up (limits, budget) just means the balance is short. */
async function fundFor(deps: ActionDeps, minWei: bigint, paid: boolean) {
  try {
    return await ensureFunds(deps, deps.account.address, minWei);
  } catch (err) {
    if (paid && err instanceof FundError && err.reason !== 'disabled') throw new InsufficientFundsError();
    throw err;
  }
}

/** Funds if needed, pulls a card (free or paid) and returns the minted token id. */
export async function pullCard(deps: ActionDeps, { paid }: { paid: boolean }): Promise<string> {
  const price = BigInt(deps.config.pullPrice);
  const minWei = paid ? price + MIN_FUND_WEI : MIN_FUND_WEI;
  const account = await fundFor(deps, minWei, paid);
  if (BigInt(account.balance) < minWei) throw new InsufficientFundsError();

  // Reserve balance: a value tx must be the first tx in 3 blocks.
  const gap = Math.max(0, TX_GAP_MS - msSinceLastTx(deps.now));
  if (paid && gap > 0) await (deps.sleep ?? defaultSleep)(gap);

  const fn = paid ? 'paidPull' : 'freePull';
  const result = mustSucceed(await (paid ? paidPull(deps, price) : freePull(deps)), fn);
  return requireEvent(result.events.tokenId, 'tokenId');
}

/** Funds if needed, creates a duel with `cardId` and returns the duel id. */
export async function startDuel(deps: ActionDeps, cardId: string): Promise<string> {
  await ensureFunds(deps, deps.account.address);
  const result = mustSucceed(await createDuel(deps, cardId), 'createDuel');
  return requireEvent(result.events.duelId, 'duelId');
}
