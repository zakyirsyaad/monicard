import { ensureFunds } from '../actions';
import type { ActionDeps } from '../actions';

/** 0.03 MON: enough gas for a battle turn; below this the burner is topped up through /fund. */
export const BATTLE_MIN_WEI = 30_000_000_000_000_000n;

export type WalletStep = 'wallet' | 'send';

/**
 * Tops the burner up before every battle tx. `ensureFunds` waits out the N9 settle window
 * (1.5 s, about five Monad blocks) after a successful /fund receipt before the first tx.
 */
export async function ensureBattleWallet(deps: ActionDeps, onStep?: (step: WalletStep) => void): Promise<void> {
  onStep?.('wallet');
  await ensureFunds(deps, deps.account.address, BATTLE_MIN_WEI);
  onStep?.('send');
}