import { Hono } from 'hono';
import { clientIp } from '../clientIp';
import { handleChallenge, type ChallengeDeps } from './challenge';

type NodeEnv = { incoming?: { socket?: { remoteAddress?: string } } };

/** POST /challenge: thin HTTP wrapper around the pure handleChallenge. */
export function agentRoutes(deps: ChallengeDeps): Hono {
  const app = new Hono();
  app.post('/challenge', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const remote = (c.env as NodeEnv | undefined)?.incoming?.socket?.remoteAddress;
    const { status, json } = await handleChallenge(body, clientIp(c.req.raw.headers, remote), deps);
    return c.json(json, status);
  });
  return app;
}