import { nadCardsAbi } from '@nad/shared';
import type { Hex } from 'viem';
import type { ChainLike } from './chainTypes';

export type AccountView = {
  nonce: number;
  balance: bigint;
  cardId: bigint | null;
  hasPulled: boolean;
};

export type AccountReader = {
  read(address: Hex): Promise<AccountView>;
};

export type AccountReaderDeps = {
  chain: ChainLike;
  cards: Hex;
  cacheMs?: number;
  now?: () => number;
};

export const ACCOUNT_CACHE_MS = 1000;

/**
 * Reads the account snapshot the client needs after a reload. `cardOf` is
 * "last pulled", not ownership, so the card id is dropped when `ownerOf`
 * shows the token has been transferred away.
 */
export function createAccountReader(deps: AccountReaderDeps): AccountReader {
  const cacheMs = deps.cacheMs ?? ACCOUNT_CACHE_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; view: AccountView }>();

  return {
    async read(address) {
      const key = address.toLowerCase();
      const cached = cache.get(key);
      if (cached && now() - cached.at < cacheMs) return cached.view;

      const view = await deps.chain.call(async (client) => {
        const [nonce, balance, cardId, hasPulled] = await Promise.all([
          client.getTransactionCount({ address, blockTag: 'pending' }),
          client.getBalance({ address }),
          client.readContract({
            address: deps.cards,
            abi: nadCardsAbi,
            functionName: 'cardOf',
            args: [address],
          }),
          client.readContract({
            address: deps.cards,
            abi: nadCardsAbi,
            functionName: 'hasPulled',
            args: [address],
          }),
        ]);

        if (cardId === 0n) return { nonce, balance, cardId: null, hasPulled };

        const owner = await client.readContract({
          address: deps.cards,
          abi: nadCardsAbi,
          functionName: 'ownerOf',
          args: [cardId],
        });
        return {
          nonce,
          balance,
          cardId: owner.toLowerCase() === key ? cardId : null,
          hasPulled,
        };
      });

      cache.set(key, { at: now(), view });
      return view;
    },
  };
}