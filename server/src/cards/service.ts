import { ELEMENTS, RARITIES, nadCardsAbi, nadmonFor, type Hex } from '@nad/shared';
import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, parseEventLogs } from 'viem';
import type { PublicClient, TransactionReceipt } from 'viem';
import type { Llm } from '../llm';
import { cardSvg } from './svg';
import { fallbackLore, forgeLore, type CardData, type Lore } from './lore';
import type { CardStore } from './store';

export type CardStatus = 'ready' | 'forging';

/** ERC-721 metadata plus the `nadgacha` block the web client reads (see NadgachaCard in web/src/lib/types.ts). */
export type CardMetadataJson = {
  name: string;
  description: string;
  image: string;
  attributes: { trait_type: string; value: string | number }[];
  nadgacha: CardData & {
    nadmon: { id: string; name: string; stage: 1 | 2 | 3 };
    title: string;
    lore: string;
    status: CardStatus;
  };
};

export type CardService = {
  /** Null when the token does not exist. Rejects on chain read failures (callers must not treat that as 404). */
  metadata(id: number): Promise<CardMetadataJson | null>;
  svg(id: number): Promise<string | null>;
  /** Forges lore for a freshly minted card. Concurrent calls for one id share a single forge. */
  onMint(id: number): Promise<void>;
};

export type CardServiceDeps = {
  readCard(id: number): Promise<CardData | null>;
  store: CardStore;
  llm: Llm | null;
  publicUrl: string;
  now?: () => number;
};

export const NOT_FOUND_TTL_MS = 10_000;

type Resolved = { data: CardData; lore: Lore; status: CardStatus };

function buildMetadata(r: Resolved, publicUrl: string): CardMetadataJson {
  const { data, lore, status } = r;
  const species = nadmonFor(data.element, data.rarity);
  const element = ELEMENTS[data.element] ?? '';
  const rarity = RARITIES[data.rarity] ?? '';
  return {
    name: `${species.name} #${data.id}`,
    description: `${lore.title}. ${rarity} ${element} Nadmon with ${data.atk} ATK and ${data.hp} HP.`,
    image: `${publicUrl}/card/${data.id}/image.svg`,
    attributes: [
      { trait_type: 'Element', value: element },
      { trait_type: 'Rarity', value: rarity },
      { trait_type: 'ATK', value: data.atk },
      { trait_type: 'HP', value: data.hp },
      { trait_type: 'Stage', value: species.stage },
      { trait_type: 'Wins', value: data.wins },
      { trait_type: 'Losses', value: data.losses },
    ],
    nadgacha: {
      ...data,
      nadmon: { id: species.id, name: species.name, stage: species.stage },
      title: lore.title,
      lore: lore.lore,
      status,
    },
  };
}

export function createCardService(deps: CardServiceDeps): CardService {
  const { readCard, store, llm } = deps;
  const publicUrl = deps.publicUrl.replace(/\/+$/, '');
  const now = deps.now ?? Date.now;
  const missingUntil = new Map<number, number>();
  const forging = new Map<number, Promise<void>>();

  function storeQuietly(id: number, lore: Lore): void {
    try {
      store.set(id, lore);
    } catch (err) {
      console.error(`[cards] could not persist lore for card ${id}:`, err);
    }
  }

  function loreFor(data: CardData): Resolved {
    const stored = store.get(data.id);
    if (forging.has(data.id)) return { data, lore: stored ?? fallbackLore(data), status: 'forging' };
    if (stored) return { data, lore: stored, status: 'ready' };
    const lore = fallbackLore(data);
    storeQuietly(data.id, lore);
    return { data, lore, status: 'ready' };
  }

  async function resolve(id: number): Promise<Resolved | null> {
    const until = missingUntil.get(id);
    if (until !== undefined && until > now()) return null;
    const data = await readCard(id);
    if (!data) {
      missingUntil.set(id, now() + NOT_FOUND_TTL_MS);
      return null;
    }
    missingUntil.delete(id);
    return loreFor(data);
  }

  async function forge(id: number): Promise<void> {
    const data = await readCard(id);
    if (!data || store.get(id)?.source === 'ai') return;
    storeQuietly(id, await forgeLore(data, llm));
  }

  return {
    metadata: async (id) => {
      const r = await resolve(id);
      return r ? buildMetadata(r, publicUrl) : null;
    },
    svg: async (id) => {
      const r = await resolve(id);
      return r ? cardSvg(r.data, r.lore, r.status) : null;
    },
    onMint: (id) => {
      const running = forging.get(id);
      if (running) return running;
      missingUntil.delete(id);
      const job = forge(id).finally(() => forging.delete(id));
      forging.set(id, job);
      return job;
    },
  };
}

// ------------------------------------------------------------- chain access

type ChainCaller = { call<T>(fn: (client: PublicClient) => Promise<T>): Promise<T> };

const MISSING_TOKEN_ERROR = 'ERC721NonexistentToken';

/** True only for an ownerOf revert that means "no such token"; RPC trouble (even code -32603) is not a revert. */
const isMissingToken = (err: unknown): boolean =>
  err instanceof BaseError &&
  err.walk(
    (e) =>
      (e instanceof ContractFunctionRevertedError && e.data?.errorName === MISSING_TOKEN_ERROR) ||
      e instanceof ExecutionRevertedError,
  ) !== null;

/** Reads `cards(id)` after `ownerOf(id)`; a revert from `ownerOf` means the token does not exist (null). */
export function createChainCardReader(chain: ChainCaller, cards: Hex): (id: number) => Promise<CardData | null> {
  return async (id) => {
    const tokenId = BigInt(id);
    try {
      await chain.call((c) => c.readContract({ address: cards, abi: nadCardsAbi, functionName: 'ownerOf', args: [tokenId] }));
    } catch (err) {
      if (isMissingToken(err)) return null;
      throw err;
    }
    const card = await chain.call((c) => c.readContract({ address: cards, abi: nadCardsAbi, functionName: 'cards', args: [tokenId] }));
    return {
      id,
      atk: card.atk,
      hp: card.hp,
      element: card.element,
      rarity: card.rarity,
      wins: card.wins,
      losses: card.losses,
      mintedAt: Number(card.mintedAt),
    };
  };
}

type IngestHub = { onIngest(cb: (block: bigint, receipts: TransactionReceipt[]) => void): void };

/** Calls `service.onMint` for every CardMinted log emitted by `cards`. Failures are caught and logged once. */
export function attachCardMinting(hub: IngestHub, service: Pick<CardService, 'onMint'>, cards: Hex): void {
  let errorLogged = false;
  const fail = (err: unknown): void => {
    if (errorLogged) return;
    errorLogged = true;
    console.error('[cards] onMint failed (further failures are not logged):', err);
  };
  hub.onIngest((_block, receipts) => {
    for (const receipt of receipts) {
      const minted = parseEventLogs({ abi: nadCardsAbi, eventName: 'CardMinted', logs: receipt.logs, strict: false });
      for (const log of minted) {
        if (log.address.toLowerCase() !== cards.toLowerCase()) continue;
        const tokenId = log.args.tokenId;
        if (tokenId === undefined) continue;
        try {
          service.onMint(Number(tokenId)).catch(fail);
        } catch (err) {
          fail(err);
        }
      }
    }
  });
}
