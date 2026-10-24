import { Hono } from 'hono';
import { handleRelay, type RelayDeps } from './relay';

/** Mounts POST /relay; the client IP is the first x-forwarded-for entry (nginx sits in front). */
export function relayRoutes(deps: RelayDeps) {
  return new Hono().post('/relay', async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const body: unknown = await c.req.json().catch(() => null);
    const { status, json } = await handleRelay(body, ip, deps);
    return c.json(json, status);
  });
}
