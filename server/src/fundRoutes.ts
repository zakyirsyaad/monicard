import { Hono } from 'hono';
import { clientIp } from './clientIp';
import { handleFund, type FundDeps } from './fund';

type NodeEnv = { incoming?: { socket?: { remoteAddress?: string } } };

/** POST /fund: thin HTTP wrapper around the pure handleFund. */
export function fundRoutes(deps: FundDeps): Hono {
  const app = new Hono();
  app.post('/fund', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const remote = (c.env as NodeEnv | undefined)?.incoming?.socket?.remoteAddress;
    const { status, json } = await handleFund(body, clientIp(c.req.raw.headers, remote), deps);
    return c.json(json, status);
  });
  return app;
}
