// Southbag Scrobbler — one Cloudflare Worker on the free plan.
// Static files in public/ are served by Workers Assets (free, no Worker invocation). Only
// /auth/*, /api/* and /1/* reach this code (see run_worker_first in wrangler.jsonc).

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './env';
import { callback, login, logout, safeReturnTo } from './lib/auth';
import lbapi from './routes/lbapi';
import me from './routes/me';

const app = new Hono<AppEnv>();

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ code: error.status, error: error.message }, error.status);
  console.error(error);
  return c.json({ code: 500, error: 'Something went wrong.' }, 500);
});
app.notFound(c => c.json({ code: 404, error: 'Not found.' }, 404));

// Scrobbling clients are native apps; browser-based ones get a permissive CORS pass on /1/*.
app.use('/1/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': c.req.header('access-control-request-headers') || 'authorization, content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  await next();
  c.res.headers.set('access-control-allow-origin', '*');
});

// ── Auth ──
app.get('/auth/login', c => login(c.req.raw, c.env, safeReturnTo(c.req.query('next'))));
app.get('/auth/callback', c => callback(c.req.raw, c.env));
app.get('/auth/logout', c => logout(c.req.raw, c.env));
app.post('/auth/logout', c => logout(c.req.raw, c.env));

// ── APIs ──
app.route('/1', lbapi);
app.route('/api', me);

export default {
  fetch: app.fetch,
  // Hourly janitor: expired OAuth states, dead sessions and stale playing-now rows.
  async scheduled(_event: ScheduledEvent, env: AppEnv['Bindings'], _ctx: ExecutionContext) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM playing_now WHERE expires_at < ?').bind(now),
    ]);
  },
};
