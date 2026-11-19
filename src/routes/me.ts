// The website's own API: who you are, your paperwork totals, and personal API tokens for
// ListenBrainz-compatible clients.

import { Hono } from 'hono';
import type { AppEnv, Env, SessionUser } from '../env';
import { session } from '../lib/auth';
import { body, fail, str } from '../lib/http';
import { centralStatus, FROZEN_TEXT, STATUS_UNKNOWN_TEXT } from '../lib/identity';
import { newId, randomToken, sha256 } from '../lib/ids';
import { cleanListen, recordListen, SCROBBLE_FEE_CENTS, type RecordOutcome } from '../lib/listens';
import { money } from '../lib/banking';

const app = new Hono<AppEnv>();

/** Session user with the central freeze answer enforced fresh. */
async function requireFreshUser(request: Request, env: Env): Promise<SessionUser> {
  const user = await session(request, env);
  if (!user) fail(401, 'Log in to do that.');
  const central = await centralStatus(env, user.id);
  if (central === 'unknown') fail(503, STATUS_UNKNOWN_TEXT);
  if (central !== 'off' && central.frozen) fail(423, FROZEN_TEXT);
  return user;
}

app.get('/me', async c => {
  const user = await session(c.req.raw, c.env);
  if (!user) return c.json({ authenticated: false });
  return c.json({
    authenticated: true,
    user: { id: user.id, handle: user.handle, name: user.name, email: user.email },
    fee_per_track_cents: SCROBBLE_FEE_CENTS,
  });
});

app.get('/me/stats', async c => {
  const user = await requireFreshUser(c.req.raw, c.env);
  const db = c.env.DB;
  const totals = await db.prepare(
    'SELECT COUNT(*) AS listens, COALESCE(SUM(fee_cents), 0) AS fees_paid_cents FROM listens WHERE user_id = ?')
    .bind(user.id).first<{ listens: number; fees_paid_cents: number }>();
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const topArtists = (await db.prepare(
    `SELECT artist_name AS name, COUNT(*) AS plays FROM listens WHERE user_id = ?
     GROUP BY artist_name ORDER BY plays DESC, name ASC LIMIT 10`).bind(user.id).all()).results;
  const topTracks = (await db.prepare(
    `SELECT artist_name AS artist, track_name AS track, COUNT(*) AS plays FROM listens WHERE user_id = ?
     GROUP BY artist_name, track_name ORDER BY plays DESC, track ASC LIMIT 10`).bind(user.id).all()).results;
  const weekArtists = (await db.prepare(
    `SELECT artist_name AS name, COUNT(*) AS plays FROM listens WHERE user_id = ? AND listened_at > ?
     GROUP BY artist_name ORDER BY plays DESC, name ASC LIMIT 10`).bind(user.id, since).all()).results;
  return c.json({
    listens: totals?.listens ?? 0,
    fees_paid_cents: totals?.fees_paid_cents ?? 0,
    fees_paid: money(totals?.fees_paid_cents ?? 0),
    fee_per_track_cents: SCROBBLE_FEE_CENTS,
    top_artists: topArtists,
    top_tracks: topTracks,
    top_artists_week: weekArtists,
  });
});

/** File one listen by hand from the website. The usual fee applies. */
app.post('/scrobble', async c => {
  const user = await requireFreshUser(c.req.raw, c.env);
  const doc = await body<{ artist_name?: string; track_name?: string; release_name?: string }>(c);
  const nowSec = Math.floor(Date.now() / 1000);
  const clean = cleanListen({
    listened_at: nowSec,
    track_metadata: {
      artist_name: doc.artist_name,
      track_name: doc.track_name,
      release_name: doc.release_name,
      additional_info: { submission_client: 'Southbag Scrobbler web' },
    },
  }, nowSec);
  if (typeof clean === 'string') fail(400, clean);
  let outcome: RecordOutcome;
  try {
    outcome = await recordListen(c.env, user, clean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('frozen')) fail(423, FROZEN_TEXT);
    console.error('manual scrobble charge failed', error);
    fail(503, 'Southbag Online Banking could not collect the fee, so the listen was not recorded. Try again shortly.');
  }
  return c.json({
    status: outcome.status,
    fee: { amount_cents: SCROBBLE_FEE_CENTS, amount: money(SCROBBLE_FEE_CENTS) },
    balance: outcome.status === 'recorded' && outcome.balance !== null ? money(outcome.balance) : null,
  });
});

// ── Personal API tokens (for ListenBrainz-compatible clients) ──

app.get('/tokens', async c => {
  const user = await requireFreshUser(c.req.raw, c.env);
  const rows = (await c.env.DB.prepare(
    `SELECT id, label, created_at, last_used_at FROM api_tokens
     WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).bind(user.id).all()).results;
  return c.json({ tokens: rows });
});

app.post('/tokens', async c => {
  const user = await requireFreshUser(c.req.raw, c.env);
  const doc = await body<{ label?: string }>(c);
  const live = await c.env.DB.prepare(
    'SELECT COUNT(*) AS count FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL')
    .bind(user.id).first<{ count: number }>();
  if ((live?.count ?? 0) >= 10) fail(409, 'Ten active tokens is enough paperwork. Revoke one first.');
  const token = 'sbt_' + randomToken();
  const id = newId();
  await c.env.DB.prepare(
    'INSERT INTO api_tokens (token_hash, id, user_id, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), id, user.id, str(doc.label, 100) || 'Scrobbling client', Date.now()).run();
  return c.json({
    id,
    token,
    notice: 'This token is shown once. Southbag does not keep a copy it will show you again.',
  });
});

app.delete('/tokens/:id', async c => {
  const user = await requireFreshUser(c.req.raw, c.env);
  const result = await c.env.DB.prepare(
    'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(Date.now(), c.req.param('id'), user.id).run();
  if (!result.meta.changes) fail(404, 'No such token.');
  return c.json({ revoked: true });
});

export default app;
