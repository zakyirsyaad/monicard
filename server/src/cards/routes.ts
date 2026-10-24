import { Hono } from 'hono';
import type { CardService } from './service';

const SVG_HEADERS = {
  'content-type': 'image/svg+xml; charset=utf-8',
  'cache-control': 'public, max-age=60',
} as const;

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
    console.error('[cards] request failed:', err);
    return c.json({ reason: 'unavailable' }, 503);
  });

  app.get('/card/:id{[0-9]+}', async (c) => {
    const id = parseId(c.req.param('id'));
    const meta = id === null ? null : await service.metadata(id);
    return meta ? c.json(meta) : notFound(c);
  });

  app.get('/card/:id{[0-9]+}/image.svg', async (c) => {
    const id = parseId(c.req.param('id'));
    const svg = id === null ? null : await service.svg(id);
    return svg ? c.body(svg, 200, SVG_HEADERS) : notFound(c);
  });

  return app;
}
