import { MIN_FUND_WEI, createDuel, ensureFunds, freePull, mustSucceed, paidPull } from './actions';
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

/** Funds if needed, pulls a card (free or paid) and returns the minted token id. */
export async function pullCard(deps: ActionDeps, { paid }: { paid: boolean }): Promise<string> {
  const price = BigInt(deps.config.pullPrice);
  const minWei = paid ? price + MIN_FUND_WEI : MIN_FUND_WEI;
  const account = await ensureFunds(deps, deps.account.address, minWei);
  if (BigInt(account.balance) < minWei) throw new InsufficientFundsError();

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
