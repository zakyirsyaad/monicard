import { Hono } from 'hono';
import type { CardService } from './service';

const SVG_TYPE = 'image/svg+xml; charset=utf-8';
const CACHE_READY = 'public, max-age=60';
/** A card still forging shows a placeholder, so it must not be cached by browsers or proxies. */
const CACHE_FORGING = 'no-store';

/** Parses a decimal path segment; null when it does not fit a JS safe integer. */
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * `GET /card/:id{[0-9]+}` and `GET /card/:id{[0-9]+}/image.svg`.
 * Never use `/card/:id.svg`: in Hono 4 it also matches `/card/5` and `id` becomes undefined.
 */
export function cardRoutes(service: CardService): Hono {
  const app = new Hono();
  const notFound = (c: { json: (body: unknown, status: 404) => Response }): Response => c.json({ reason: 'not_found' }, 404);

  app.onError((err, c) => {
    // Never log the whole error: viem errors embed the RPC URL.
    console.error('[cards] request failed:', (err as { shortMessage?: string }).shortMessage ?? err.message);
    return c.json({ reason: 'unavailable' }, 503);
  });

  app.get('/card/:id{[0-9]+}', async (c) => {
    const id = parseId(c.req.param('id'));
    const meta = id === null ? null : await service.metadata(id);
    return meta ? c.json(meta) : notFound(c);
  });

  app.get('/card/:id{[0-9]+}/image.svg', async (c) => {
    const id = parseId(c.req.param('id'));
    const card = id === null ? null : await service.svg(id);
    if (!card) return notFound(c);
    const cache = card.status === 'forging' ? CACHE_FORGING : CACHE_READY;
    return c.body(card.svg, 200, { 'content-type': SVG_TYPE, 'cache-control': cache });
  });

  return app;
}
