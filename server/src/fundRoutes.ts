import { Hono } from 'hono';
import { clientIp } from './clientIp';
import { handleFund, type FundDeps } from './fund';

/** POST /fund: thin HTTP wrapper around the pure handleFund. */
export function fundRoutes(deps: FundDeps): Hono {
  const app = new Hono();
  app.post('/fund', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const { status, json } = await handleFund(body, clientIp(c.req.raw.headers), deps);
    return c.json(json, status);
  });
  return app;
}
