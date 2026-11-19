// The ListenBrainz-compatible API (https://listenbrainz.readthedocs.io/en/latest/users/api/),
// so existing scrobble clients file their paperwork with Southbag instead. Covered endpoints:
//   POST /1/submit-listens          single / playing_now / import (import capped, see below)
//   GET  /1/validate-token
//   GET  /1/user/:user_name/listens
//   GET  /1/user/:user_name/listen-count
//   GET  /1/user/:user_name/playing-now
//   GET  /1/user/:user_name/charts          itemised listening over time (a fee applies)
//   POST /1/playing-now/delete
//   POST /1/delete-listen           refused: Southbag does not delete, and fees are final.
//
// Auth: `Authorization: Token <personal API token>` (created on the website), the website
// session cookie, or a Southbag Identity access token as `Bearer …`.

import { Hono } from 'hono';
import type { AppEnv, Env, SessionUser } from '../env';
import { session } from '../lib/auth';
import { API_FETCH_FEE_CENTS, CHART_FEE_CENTS, meter } from '../lib/banking';
import { body, fail } from '../lib/http';
import { centralStatus, FROZEN_TEXT, STATUS_UNKNOWN_TEXT } from '../lib/identity';
import { sha256 } from '../lib/ids';
import { cleanListen, listenJson, recordListen, type ListenRow, type RecordOutcome, type SubmittedListen } from '../lib/listens';

// A Worker invocation may make only so many subrequests and every listen's fee is one RPC to
// the bank, so imports arrive in batches. Clients that send more get a clear 400 and retry
// with smaller paperwork.
export const MAX_LISTENS_PER_REQUEST = 25;

const PLAYING_NOW_TTL_MS = 15 * 60 * 1000;

const app = new Hono<AppEnv>();

const lbError = (status: number, error: string) => Response.json({ code: status, error }, { status });

/** `Authorization: Token …`, like ListenBrainz. */
async function userForToken(env: Env, token: string): Promise<SessionUser | null> {
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT users.id, users.handle, users.username, users.name, users.email, users.identity_picture, api_tokens.last_used_at
     FROM api_tokens JOIN users ON users.id = api_tokens.user_id
     WHERE api_tokens.token_hash = ? AND api_tokens.revoked_at IS NULL`).bind(hash)
    .first<SessionUser>();
  if (!row) return null;
  await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?')
    .bind(Date.now(), hash).run();
  const { last_used_at: _, ...user } = row as SessionUser & { last_used_at?: number };
  return user;
}

/** Any of the three accepted credentials, or null. */
export async function resolveUser(request: Request, env: Env): Promise<SessionUser | null> {
  const tokenAuth = request.headers.get('authorization')?.match(/^Token (.+)$/i)?.[1];
  if (tokenAuth) return userForToken(env, tokenAuth.trim());
  return session(request, env);
}

/** The signed-in user with a fresh central freeze answer enforced, or the refusal thrown. */
async function requireFreshUser(request: Request, env: Env): Promise<SessionUser> {
  const user = await resolveUser(request, env);
  if (!user) fail(401, 'A valid user token is required.');
  const central = await centralStatus(env, user.id);
  if (central === 'unknown') fail(503, STATUS_UNKNOWN_TEXT);
  if (central !== 'off' && central.frozen) fail(423, FROZEN_TEXT);
  return user;
}

async function userByName(env: Env, name: string): Promise<{ id: string; handle: string; username: string | null } | null> {
  const lower = name.toLowerCase();
  return env.DB.prepare(
    'SELECT id, handle, username FROM users WHERE username = ? OR (username IS NULL AND handle = ?)')
    .bind(lower, lower).first<{ id: string; handle: string; username: string | null }>();
}

/** The public API name: the chosen username, or the Identity handle until one is chosen. */
const apiName = (user: { handle: string; username?: string | null }) => user.username ?? user.handle;

// ── Submitting ──

app.post('/submit-listens', async c => {
  const user = await requireFreshUser(c.req.raw, c.env);
  const doc = await body<{ listen_type?: string; payload?: SubmittedListen[] }>(c);
  const type = doc.listen_type;
  if (type !== 'single' && type !== 'playing_now' && type !== 'import')
    return lbError(400, 'listen_type must be one of single, playing_now, import.');
  if (!Array.isArray(doc.payload) || doc.payload.length === 0)
    return lbError(400, 'payload must be a non-empty array of listens.');
  if ((type === 'single' || type === 'playing_now') && doc.payload.length !== 1)
    return lbError(400, `listen_type ${type} carries exactly one listen.`);
  if (doc.payload.length > MAX_LISTENS_PER_REQUEST)
    return lbError(400, `A request may carry at most ${MAX_LISTENS_PER_REQUEST} listens. Southbag processes paperwork in batches of ${MAX_LISTENS_PER_REQUEST}.`);

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  if (type === 'playing_now') {
    const raw = doc.payload[0];
    if (raw?.listened_at !== undefined && raw.listened_at !== null)
      return lbError(400, 'listened_at must be omitted from a playing_now submission.');
    const clean = cleanListen(raw, nowSec);
    if (typeof clean === 'string') return lbError(400, clean);
    const msid = crypto.randomUUID();
    await c.env.DB.prepare(`INSERT INTO playing_now
      (user_id, artist_name, track_name, release_name, additional_info, recording_msid, submission_client, inserted_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET artist_name = excluded.artist_name, track_name = excluded.track_name,
        release_name = excluded.release_name, additional_info = excluded.additional_info,
        recording_msid = excluded.recording_msid, submission_client = excluded.submission_client,
        inserted_at = excluded.inserted_at, expires_at = excluded.expires_at`)
      .bind(user.id, clean.artist, clean.track, clean.release, clean.additionalInfo, msid,
        clean.submissionClient, nowSec, nowMs + PLAYING_NOW_TTL_MS).run();
    const wantMsid = new URL(c.req.url).searchParams.get('return_msid') === 'true';
    return c.json(wantMsid ? { status: 'ok', recording_msid: msid } : { status: 'ok' });
  }

  let recorded = 0;
  let duplicates = 0;
  for (const raw of doc.payload) {
    const clean = cleanListen(raw, nowSec);
    if (typeof clean === 'string') return lbError(400, clean);
    let outcome: RecordOutcome;
    try {
      outcome = await recordListen(c.env, user, clean);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('frozen')) return lbError(403, FROZEN_TEXT);
      console.error('scrobble charge failed', error);
      return lbError(503, 'Southbag Online Banking could not collect the fee, so the listen was not recorded. Try again shortly.');
    }
    if (outcome.status === 'recorded') recorded++;
    else duplicates++;
  }
  return c.json({ status: 'ok', recorded, duplicates });
});

app.post('/playing-now/delete', async c => {
  const user = await requireFreshUser(c.req.raw, c.env);
  const doc = await body<{ client?: string }>(c);
  if (doc.client) {
    const existing = await c.env.DB.prepare('SELECT submission_client FROM playing_now WHERE user_id = ?')
      .bind(user.id).first<{ submission_client: string | null }>();
    if (!existing || existing.submission_client !== doc.client)
      return lbError(404, 'The current playing_now was not submitted by that client.');
  }
  await c.env.DB.prepare('DELETE FROM playing_now WHERE user_id = ?').bind(user.id).run();
  return c.json({ status: 'ok' });
});

// Kevin has banned refunds, and a deleted listen would be one.
app.post('/delete-listen', c =>
  c.json({ code: 403, error: "Deletion isn't available. Fees are final. Kevin knows what you listened to." }, 403));

// ── Tokens ──

app.get('/validate-token', async c => {
  const token = c.req.header('authorization')?.match(/^Token (.+)$/i)?.[1]?.trim()
    || c.req.query('token') || '';
  if (!token) return c.json({ code: 400, error: 'No token was sent to the endpoint.' }, 400);
  const user = await userForToken(c.env, token);
  if (!user) return c.json({ code: 200, message: 'Token invalid.', valid: false });
  return c.json({ code: 200, message: 'Token valid.', valid: true, user_name: apiName(user) });
});

// ── Fetching (public, like ListenBrainz) ──

// Reading data over the API costs the reader a small fee, collected when the request
// carries a credential (session or token). Anonymous reads stay free, like ListenBrainz.
async function meterRead(request: Request, env: Env, endpoint: string, amount: number) {
  const caller = await resolveUser(request, env);
  if (!caller) return;
  await meter(env, caller, endpoint, amount);
}

app.get('/user/:user_name/listens', async c => {
  const name = c.req.param('user_name');
  const user = await userByName(c.env, name);
  if (!user) return lbError(404, `user ${name} not found`);

  await meterRead(c.req.raw, c.env, `/1/user/${apiName(user)}/listens`, API_FETCH_FEE_CENTS);
  const countParam = Number(c.req.query('count'));
  const count = Number.isInteger(countParam) && countParam > 0 ? Math.min(countParam, 100) : 25;
  const maxTs = Number(c.req.query('max_ts'));
  const minTs = Number(c.req.query('min_ts'));

  // Listens are always returned newest first. max_ts pages backwards from it; min_ts bounds
  // how new a listen must be (both at once is rejected, like ListenBrainz).
  if (Number.isFinite(minTs) && minTs > 0 && Number.isFinite(maxTs) && maxTs > 0)
    return lbError(400, 'Specify only one of max_ts or min_ts.');
  let rows: ListenRow[];
  if (Number.isFinite(minTs) && minTs > 0) {
    rows = (await c.env.DB.prepare(
      `SELECT * FROM listens WHERE user_id = ? AND listened_at > ? ORDER BY listened_at DESC LIMIT ?`)
      .bind(user.id, Math.floor(minTs), count).all<ListenRow>()).results;
  } else {
    const ceiling = Number.isFinite(maxTs) && maxTs > 0 ? Math.floor(maxTs) : Number.MAX_SAFE_INTEGER;
    rows = (await c.env.DB.prepare(
      `SELECT * FROM listens WHERE user_id = ? AND listened_at < ? ORDER BY listened_at DESC LIMIT ?`)
      .bind(user.id, ceiling, count).all<ListenRow>()).results;
  }
  return c.json({
    payload: {
      count: rows.length,
      user_id: apiName(user),
      listens: rows.map(row => listenJson(row, apiName(user))),
    },
  });
});

app.get('/user/:user_name/listen-count', async c => {
  const name = c.req.param('user_name');
  const user = await userByName(c.env, name);
  if (!user) return lbError(404, `user ${name} not found`);
  await meterRead(c.req.raw, c.env, `/1/user/${apiName(user)}/listen-count`, API_FETCH_FEE_CENTS);
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM listens WHERE user_id = ?')
    .bind(user.id).first<{ count: number }>();
  return c.json({ payload: { count: row?.count ?? 0 } });
});

app.get('/user/:user_name/playing-now', async c => {
  const name = c.req.param('user_name');
  const user = await userByName(c.env, name);
  if (!user) return lbError(404, `user ${name} not found`);
  await meterRead(c.req.raw, c.env, `/1/user/${apiName(user)}/playing-now`, API_FETCH_FEE_CENTS);
  const row = await c.env.DB.prepare('SELECT * FROM playing_now WHERE user_id = ? AND expires_at > ?')
    .bind(user.id, Date.now()).first<ListenRow & { expires_at: number }>();
  const listens = row
    ? [(() => {
        const json = listenJson(row, apiName(user)) as Record<string, unknown>;
        delete json.listened_at;
        return json;
      })()]
    : [];
  return c.json({
    payload: { count: listens.length, user_id: apiName(user), playing_now: true, listens },
  });
});

// Charts: listening, itemised over time. Premium paperwork - a larger fee applies.
const RANGES: Record<string, { seconds: number; monthly?: boolean }> = {
  week: { seconds: 7 * 86400 },
  month: { seconds: 30 * 86400 },
  year: { seconds: 365 * 86400 },
  all_time: { seconds: 0, monthly: true },
};

app.get('/user/:user_name/charts', async c => {
  const name = c.req.param('user_name');
  const user = await userByName(c.env, name);
  if (!user) return lbError(404, `user ${name} not found`);
  const range = RANGES[c.req.query('range') ?? ''] ?? RANGES.month;
  const rangeName = RANGES[c.req.query('range') ?? ''] ? (c.req.query('range') as string) : 'month';
  await meterRead(c.req.raw, c.env, `/1/user/${apiName(user)}/charts`, CHART_FEE_CENTS);

  let buckets: { period: string; listen_count: number }[];
  if (range.monthly) {
    buckets = (await c.env.DB.prepare(
      `SELECT strftime('%Y-%m', listened_at, 'unixepoch') AS period, COUNT(*) AS listen_count
       FROM listens WHERE user_id = ? GROUP BY period ORDER BY period ASC`).bind(user.id).all()).results as typeof buckets;
  } else {
    const since = Math.floor(Date.now() / 1000) - range.seconds;
    const rows = (await c.env.DB.prepare(
      `SELECT date(listened_at, 'unixepoch') AS period, COUNT(*) AS listen_count
       FROM listens WHERE user_id = ? AND listened_at > ? GROUP BY period ORDER BY period ASC`)
      .bind(user.id, since).all()).results as { period: string; listen_count: number }[];
    // Zero-fill the days with nothing on file; an itemised record accounts for quiet days too.
    const byDay = new Map(rows.map(r => [r.period, r.listen_count]));
    buckets = [];
    const dayMs = 86400 * 1000;
    const start = new Date((Math.floor(Date.now() / 1000) - range.seconds) * 1000);
    for (let t = Math.floor(start.getTime() / dayMs) * dayMs; t <= Date.now(); t += dayMs) {
      const day = new Date(t).toISOString().slice(0, 10);
      buckets.push({ period: day, listen_count: byDay.get(day) ?? 0 });
    }
  }
  return c.json({
    payload: {
      user_id: apiName(user),
      range: rangeName,
      fee: 'This chart was not free.',
      buckets,
    },
  });
});

export default app;
