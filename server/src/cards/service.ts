import { ELEMENTS, RARITIES, nadCardsAbi, nadmonFor, type Hex } from '@nad/shared';
import { parseEventLogs } from 'viem';
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

export type CardSvg = { svg: string; status: CardStatus };

export type CardService = {
  /** Null when the token does not exist. Rejects on chain read failures (callers must not treat that as 404). */
  metadata(id: number): Promise<CardMetadataJson | null>;
  /** The card svg plus its status, so callers can avoid caching a placeholder that is still forging. */
  svg(id: number): Promise<CardSvg | null>;
  /** Forges AI lore for a freshly minted card; a no-op without an LLM. Concurrent calls for one id share one forge. */
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
/** How long one chain read of a card is reused; concurrent reads of an id always share one call. */
export const CARD_CACHE_MS = 2_000;

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

/**
 * Production passes `llm: null`: template lore is final (it is deterministic, computed on demand and never stored).
 * With an LLM, only AI lore is stored, and `onMint` forges it while the card reports `forging`.
 */
export function createCardService(deps: CardServiceDeps): CardService {
  const { readCard, store, llm } = deps;
  const publicUrl = deps.publicUrl.replace(/\/+$/, '');
  const now = deps.now ?? Date.now;
  const missingUntil = new Map<number, number>();
  const cached = new Map<number, { data: CardData; until: number }>();
  const reads = new Map<number, Promise<CardData | null>>();
  const forging = new Map<number, Promise<void>>();

  function prune(): void {
    const t = now();
    for (const [id, until] of missingUntil) if (until <= t) missingUntil.delete(id);
    for (const [id, entry] of cached) if (entry.until <= t) cached.delete(id);
  }

  function readOnce(id: number): Promise<CardData | null> {
    const hit = cached.get(id);
    if (hit && hit.until > now()) return Promise.resolve(hit.data);
    const running = reads.get(id);
    if (running) return running;
    const job = readCard(id)
      .then((data) => {
        prune();
        if (data) cached.set(id, { data, until: now() + CARD_CACHE_MS });
        return data;
      })
      .finally(() => reads.delete(id));
    reads.set(id, job);
    return job;
  }

  function loreFor(data: CardData): Resolved {
    const stored = store.get(data.id);
    if (forging.has(data.id)) return { data, lore: stored ?? fallbackLore(data), status: 'forging' };
    return { data, lore: stored ?? fallbackLore(data), status: 'ready' };
  }

  async function resolve(id: number): Promise<Resolved | null> {
    const until = missingUntil.get(id);
    if (until !== undefined && until > now()) return null;
    const data = await readOnce(id);
    if (!data) {
      prune();
      missingUntil.set(id, now() + NOT_FOUND_TTL_MS);
      return null;
    }
    missingUntil.delete(id);
    return loreFor(data);
  }

  async function forge(id: number, llmClient: Llm): Promise<void> {
    const data = await readOnce(id);
    if (!data || store.get(id)?.source === 'ai') return;
    const lore = await forgeLore(data, llmClient);
    if (lore.source !== 'ai') return;
    try {
      store.set(id, lore);
    } catch (err) {
      console.error(`[cards] could not persist lore for card ${id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  return {
    metadata: async (id) => {
      const r = await resolve(id);
      return r ? buildMetadata(r, publicUrl) : null;
    },
    svg: async (id) => {
      const r = await resolve(id);
      return r ? { svg: cardSvg(r.data, r.lore, r.status), status: r.status } : null;
    },
    onMint: (id) => {
      if (!llm) return Promise.resolve();
      const running = forging.get(id);
      if (running) return running;
      missingUntil.delete(id);
      cached.delete(id);
      const job = forge(id, llm).finally(() => forging.delete(id));
      forging.set(id, job);
      return job;
    },
  };
}

// ------------------------------------------------------------- chain access

type ChainCaller = { call<T>(fn: (client: PublicClient) => Promise<T>): Promise<T> };

/**
 * One `cards(id)` read: the custom view never reverts and returns an all-zero struct for unknown ids,
 * and a minted card always has `mintedAt` > 0 (its block number), so `mintedAt === 0` means no such token.
 */
export function createChainCardReader(chain: ChainCaller, cards: Hex): (id: number) => Promise<CardData | null> {
  return async (id) => {
    const card = await chain.call((c) =>
      c.readContract({ address: cards, abi: nadCardsAbi, functionName: 'cards', args: [BigInt(id)] }),
    );
    if (card.mintedAt === 0n) return null;
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
