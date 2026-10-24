import { Hono } from 'hono';
import { clientIp } from './clientIp';
import { handleRelay, type RelayDeps } from './relay';

type NodeEnv = { incoming?: { socket?: { remoteAddress?: string } } };

/** Mounts POST /relay; the client IP is resolved like /fund (x-real-ip set by nginx, never the forgeable first XFF). */
export function relayRoutes(deps: RelayDeps) {
  return new Hono().post('/relay', async (c) => {
    const remote = (c.env as NodeEnv | undefined)?.incoming?.socket?.remoteAddress;
    const body: unknown = await c.req.json().catch(() => null);
    const { status, json } = await handleRelay(body, clientIp(c.req.raw.headers, remote), deps);
    return c.json(json, status);
  });
}
