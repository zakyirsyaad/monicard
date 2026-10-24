import { Hono, type Context } from 'hono';
import {
  createAdminActions,
  isAuthorized,
  UNAUTHORIZED,
  type AdminDeps,
  type AdminResult,
} from './admin';

const respond = (c: Context, result: AdminResult) => c.json(result.body, result.status);

/** A missing or malformed JSON body becomes null; the zod schema then answers 400. */
async function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

/**
 * Token-protected admin API. Mounted as `app.route('/admin', adminRoutes(deps))`, so the
 * paths below are relative. Only HTTP mapping lives here; the logic is in `admin.ts`.
 */
export function adminRoutes(deps: AdminDeps): Hono {
  const app = new Hono();
  const actions = createAdminActions(deps);

  app.use('*', async (c, next) => {
    if (!isAuthorized(c.req.header('x-admin-token'), deps.token)) {
      return c.json(UNAUTHORIZED.body, UNAUTHORIZED.status);
    }
    await next();
  });

  app.post('/swarm', async (c) => respond(c, await actions.startSwarm(await jsonBody(c))));
  app.post('/swarm/stop', async (c) => respond(c, await actions.stopSwarm()));
  app.post('/fund', async (c) => respond(c, await actions.setFund(await jsonBody(c))));
  app.post('/featured', async (c) => respond(c, await actions.setFeaturedDuel(await jsonBody(c))));
  app.post('/agent/reserve', async (c) => respond(c, await actions.reserveAgentFor(await jsonBody(c))));
  app.post('/agent/merge-train', async (c) => respond(c, await actions.mergeTrain()));
  app.get('/wallets', async (c) => respond(c, await actions.wallets()));

  return app;
}
