import assert from 'node:assert/strict';
import { test } from 'node:test';

const BASE = process.env.BASE || 'http://localhost:8799';

const json = async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) });

const call = (method, path, { token, cookie, data } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Token ${token}`;
  if (cookie) headers.cookie = `southbag_scrobbler_session=${cookie}`;
  if (data) headers['content-type'] = 'application/json';
  return fetch(BASE + path, { method, headers, body: data ? JSON.stringify(data) : undefined }).then(json);
};

const as = (who) => ({
  get: (path) => call('GET', path, { cookie: `dev-${who}` }),
  post: (path, data) => call('POST', path, { cookie: `dev-${who}`, data }),
  del: (path) => call('DELETE', path, { cookie: `dev-${who}` }),
  tokenGet: (path) => call('GET', path, { token: `dev-token-${who}` }),
  tokenPost: (path, data) => call('POST', path, { token: `dev-token-${who}`, data }),
});

const alice = as('alice'), bob = as('bob'), erin = as('erin'), frank = as('frank');

const listen = (track, artist, ts, extra = {}) => ({
  listened_at: ts,
  track_metadata: { artist_name: artist, track_name: track, ...extra },
});
const T = Math.floor(Date.now() / 1000) - 3600;

test('submit a single listen with an API token, then read it back publicly', async () => {
  const submitted = await alice.tokenPost('/1/submit-listens', {
    listen_type: 'single',
    payload: [listen('Never Gonna Give You Up', 'Rick Astley', T, { release_name: 'Whenever You Need Somebody' })],
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.status, 'ok');
  assert.equal(submitted.body.recorded, 1);

  const list = await call('GET', '/1/user/alice/listens');
  assert.equal(list.status, 200, 'public read needs no auth');
  const first = list.body.payload.listens[0];
  assert.equal(first.track_metadata.track_name, 'Never Gonna Give You Up');
  assert.equal(first.track_metadata.artist_name, 'Rick Astley');
  assert.equal(first.track_metadata.release_name, 'Whenever You Need Somebody');
  assert.equal(first.listened_at, T);
  assert.equal(first.user_name, 'alice');
  assert.ok(first.recording_msid);

  const count = await call('GET', '/1/user/alice/listen-count');
  assert.equal(count.body.payload.count, 1);
});

test('re-submitting the same listen is a no-op, never a second fee', async () => {
  const again = await alice.tokenPost('/1/submit-listens', {
    listen_type: 'single',
    payload: [listen('Never Gonna Give You Up', 'Rick Astley', T)],
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.recorded, 0);
  assert.equal(again.body.duplicates, 1);
  const count = await call('GET', '/1/user/alice/listen-count');
  assert.equal(count.body.payload.count, 1);
});

test('import files several listens and enforces the batch limit', async () => {
  const batch = [1, 2, 3].map((i) => listen(`Track ${i}`, 'The Batch', T - i * 300));
  const imported = await bob.tokenPost('/1/submit-listens', { listen_type: 'import', payload: batch });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.recorded, 3);
  const count = await call('GET', '/1/user/bob/listen-count');
  assert.equal(count.body.payload.count, 3);

  const tooMany = Array.from({ length: 26 }, (_, i) => listen(`X${i}`, 'Too Many', T - i * 60));
  const refused = await bob.tokenPost('/1/submit-listens', { listen_type: 'import', payload: tooMany });
  assert.equal(refused.status, 400);
});

test('max_ts pages backwards', async () => {
  const page1 = await call('GET', '/1/user/bob/listens?count=2');
  assert.equal(page1.body.payload.listens.length, 2);
  const oldest = page1.body.payload.listens[1];
  const page2 = await call('GET', `/1/user/bob/listens?count=2&max_ts=${oldest.listened_at}`);
  assert.equal(page2.body.payload.listens.length, 1);
  assert.equal(page2.body.payload.listens[0].track_metadata.track_name, 'Track 3');
});

test('playing_now is free, shows, and clears', async () => {
  const now = await alice.tokenPost('/1/submit-listens', {
    listen_type: 'playing_now',
    payload: [{ track_metadata: { artist_name: 'Live Artist', track_name: 'Happening Now' } }],
  });
  assert.equal(now.status, 200);
  const playing = await call('GET', '/1/user/alice/playing-now');
  assert.equal(playing.body.payload.count, 1);
  assert.equal(playing.body.payload.listens[0].track_metadata.track_name, 'Happening Now');
  assert.equal(playing.body.payload.listens[0].listened_at, undefined);

  const cleared = await alice.tokenPost('/1/playing-now/delete', {});
  assert.equal(cleared.status, 200);
  const gone = await call('GET', '/1/user/alice/playing-now');
  assert.equal(gone.body.payload.count, 0);

  const count = await call('GET', '/1/user/alice/listen-count');
  assert.equal(count.body.payload.count, 1, 'playing_now never enters the ledger');
});

test('playing_now with a listened_at is rejected', async () => {
  const bad = await alice.tokenPost('/1/submit-listens', {
    listen_type: 'playing_now',
    payload: [listen('Wrong', 'Paperwork', T)],
  });
  assert.equal(bad.status, 400);
});

test('validate-token', async () => {
  const good = await call('GET', '/1/validate-token', { token: 'dev-token-alice' });
  assert.deepEqual(good.body, { code: 200, message: 'Token valid.', valid: true, user_name: 'alice' });
  const bad = await call('GET', '/1/validate-token', { token: 'dev-token-nobody' });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.valid, false);
  const missing = await call('GET', '/1/validate-token');
  assert.equal(missing.status, 400);
});

test('submitting needs auth; bad tokens and strangers get 401/404', async () => {
  const anon = await call('POST', '/1/submit-listens', { listen_type: 'single', payload: [listen('A', 'B', T)] });
  assert.equal(anon.status, 401);
  const bad = await call('POST', '/1/submit-listens', { token: 'wrong' , data: { listen_type: 'single', payload: [listen('A', 'B', T)] } });
  assert.equal(bad.status, 401);
  const ghost = await call('GET', '/1/user/nobody/listens');
  assert.equal(ghost.status, 404);
});

test('a frozen account cannot file (423); unknown status fails closed (503)', async () => {
  const frozen = await erin.tokenPost('/1/submit-listens', { listen_type: 'single', payload: [listen('A', 'B', T)] });
  assert.equal(frozen.status, 423);
  const frozenWeb = await erin.post('/api/scrobble', { artist_name: 'A', track_name: 'B' });
  assert.equal(frozenWeb.status, 423);
  const unknown = await frank.tokenPost('/1/submit-listens', { listen_type: 'single', payload: [listen('A', 'B', T)] });
  assert.equal(unknown.status, 503);
});

test('the fee is charged per track through Banking', async () => {
  const before = await alice.get('/api/me/stats');
  assert.equal(before.body.fees_paid_cents, 5, 'one listen so far');
  const manual = await alice.post('/api/scrobble', { artist_name: 'Manual Entry', track_name: 'By Hand' });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.status, 'recorded');
  assert.equal(manual.body.fee.amount, '$0.05');
  const after = await alice.get('/api/me/stats');
  assert.equal(after.body.listens, 2);
  assert.equal(after.body.fees_paid_cents, 10);
  assert.equal(after.body.fees_paid, '$0.10');
});

test('future listens are rejected', async () => {
  const future = await alice.tokenPost('/1/submit-listens', {
    listen_type: 'single',
    payload: [listen('Tomorrow', 'The Future', Math.floor(Date.now() / 1000) + 3600)],
  });
  assert.equal(future.status, 400);
});

test('website tokens: issue, use, list, revoke', async () => {
  const issued = await bob.post('/api/tokens', { label: 'test client' });
  assert.equal(issued.status, 200);
  assert.ok(issued.body.token.startsWith('sbt_'));

  const works = await call('GET', '/1/validate-token', { token: issued.body.token });
  assert.equal(works.body.valid, true);
  assert.equal(works.body.user_name, 'bob');

  const listed = await bob.get('/api/tokens');
  assert.ok(listed.body.tokens.some((t) => t.id === issued.body.id));

  const revoked = await bob.del(`/api/tokens/${issued.body.id}`);
  assert.equal(revoked.status, 200);
  const dead = await call('GET', '/1/validate-token', { token: issued.body.token });
  assert.equal(dead.body.valid, false);
});

test('delete-listen is refused: fees are final', async () => {
  const refused = await alice.tokenPost('/1/delete-listen', { listened_at: T, recording_msid: 'x' });
  assert.equal(refused.status, 403);
  const count = await call('GET', '/1/user/alice/listen-count');
  assert.equal(count.body.payload.count, 2, 'nothing was deleted');
});

test('/api/me answers signed-out and signed-in', async () => {
  const anon = await call('GET', '/api/me');
  assert.equal(anon.body.authenticated, false);
  const me = await alice.get('/api/me');
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.user.handle, 'alice');
  assert.equal(me.body.fee_per_track_cents, 5);
});
