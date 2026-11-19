// Southbag Scrobbler — the whole frontend. Plain ES modules, no build step.

const app = document.getElementById('app');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const api = {
  async request(method, path, data) {
    const response = await fetch(path, {
      method,
      headers: data ? { 'content-type': 'application/json' } : undefined,
      body: data ? JSON.stringify(data) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  },
  get(path) { return this.request('GET', path); },
  post(path, data) { return this.request('POST', path, data); },
  del(path) { return this.request('DELETE', path); },
};

const cents = (n) => `${n < 0 ? '-' : ''}$${(Math.abs(n) / 100).toFixed(2)}`;

const when = (unixSec) => {
  const date = new Date(unixSec * 1000);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return date.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
};

const WORDMARK = `<h1 class="wordmark">Southbag <span class="blue">Scrobbler</span></h1>`;
const FOOTER = `<footer class="end"><span>Southbag Institutional Services Ltd.</span><span>Kevin is watching.</span></footer>`;

function signedOut(reason) {
  app.innerHTML = `
    ${WORDMARK}
    <p class="tagline">The listening record of the Southbag Global Enterprise Network.</p>
    ${reason ? `<div class="error">${esc(reason)}</div>` : ''}
    <div class="panel">
      <h2>What this is</h2>
      <p>Every track you play is itemised and filed, permanently. A fee of $0.05 is collected
      for every track. Kevin gets His cut.</p>
      <ul class="plain">
        <li>Your full listening history, kept forever. Deletion isn't available.</li>
        <li>Works with ListenBrainz-compatible scrobbling clients.</li>
        <li>Fees are collected from your Southbag Online Banking account. Fees are final.</li>
      </ul>
      <p class="fine">Sign in with Southbag Identity. You already have an account.</p>
      <p><a class="button" href="/auth/login">Log in</a></p>
    </div>
    ${FOOTER}`;
}

function header(user) {
  return `<header class="top">
    <strong>Southbag Scrobbler</strong>
    <span class="who">@${esc(user.handle)} &middot; <a href="/auth/logout">Sign out</a></span>
  </header>`;
}

async function signedIn(user, { welcome }) {
  app.innerHTML = `${header(user)}
    ${welcome ? `<div class="notice">Your account has been opened. Your listening will be itemised from now on.</div>` : ''}
    <p class="muted">Loading your paperwork…</p>${FOOTER}`;

  const [statsRes, listensRes, nowRes, tokensRes] = await Promise.all([
    api.get('/api/me/stats'),
    api.get(`/1/user/${encodeURIComponent(user.handle)}/listens?count=25`),
    api.get(`/1/user/${encodeURIComponent(user.handle)}/playing-now`),
    api.get('/api/tokens'),
  ]);
  if (statsRes.status === 423 || statsRes.status === 503) {
    app.innerHTML = `${header(user)}<div class="error">${esc(statsRes.body.error)}</div>${FOOTER}`;
    return;
  }
  const stats = statsRes.body;
  const listens = listensRes.body?.payload?.listens ?? [];
  const playing = nowRes.body?.payload?.listens?.[0] ?? null;
  const tokens = tokensRes.body?.tokens ?? [];

  const listenRows = listens.map((l) => `<tr>
      <td class="fine">${esc(when(l.listened_at))}</td>
      <td>${esc(l.track_metadata.track_name)}</td>
      <td>${esc(l.track_metadata.artist_name)}</td>
      <td class="muted">${esc(l.track_metadata.release_name || '')}</td>
    </tr>`).join('');

  const topList = (items, label) => (items && items.length)
    ? `<table><tr><th>${label}</th><th>Plays</th></tr>${
        items.map((i) => `<tr><td>${esc(i.name ?? `${i.track} — ${i.artist}`)}</td><td>${i.plays}</td></tr>`).join('')}</table>`
    : `<p class="fine">Nothing on file yet.</p>`;

  app.innerHTML = `
    ${header(user)}
    ${welcome ? `<div class="notice">Your account has been opened. Your listening will be itemised from now on.</div>` : ''}

    <div class="panel">
      <div class="stats">
        <div class="stat"><div class="n">${stats.listens}</div><div class="l">Listens on file</div></div>
        <div class="stat"><div class="n">${esc(stats.fees_paid)}</div><div class="l">Fees remitted to date</div></div>
        <div class="stat"><div class="n">${cents(stats.fee_per_track_cents)}</div><div class="l">Standard fee per track</div></div>
      </div>
    </div>

    ${playing ? `<div class="panel"><h2>Now playing</h2>
      <p>${esc(playing.track_metadata.track_name)} — ${esc(playing.track_metadata.artist_name)}</p>
    </div>` : ''}

    <div class="panel">
      <h2>File a listen</h2>
      <form id="file-listen">
        <label for="f-track">Track</label><input id="f-track" type="text" required>
        <label for="f-artist">Artist</label><input id="f-artist" type="text" required>
        <label for="f-album">Album (optional)</label><input id="f-album" type="text">
        <p style="margin-top:12px"><button type="submit">File listen</button></p>
        <p class="fine">Filing this listen costs ${cents(stats.fee_per_track_cents)}, collected from your
        Southbag Online Banking account. Kevin gets His cut.</p>
      </form>
      <div id="file-result"></div>
    </div>

    <div class="panel">
      <h2>Recent listens</h2>
      ${listens.length
        ? `<table><tr><th>Filed</th><th>Track</th><th>Artist</th><th>Album</th></tr>${listenRows}</table>`
        : `<p class="fine">Nothing on file yet. Play something.</p>`}
    </div>

    <div class="panel">
      <h2>Top artists, all time</h2>
      ${topList(stats.top_artists, 'Artist')}
      <h2 style="margin-top:16px">Top tracks, all time</h2>
      ${topList(stats.top_tracks, 'Track')}
    </div>

    <div class="panel">
      <h2>Connect a scrobbling client</h2>
      <p>Southbag Scrobbler speaks the ListenBrainz API. Point any compatible client here:</p>
      <pre>POST https://scrobbler.southbag.cc/1/submit-listens
Authorization: Token &lt;your token&gt;</pre>
      <form id="new-token">
        <label for="t-label">New token label</label><input id="t-label" type="text" placeholder="e.g. phone, navidrome">
        <p style="margin-top:10px"><button type="submit">Issue token</button></p>
      </form>
      <div id="token-result"></div>
      ${tokens.length
        ? `<table><tr><th>Label</th><th>Issued</th><th>Last used</th><th></th></tr>${tokens.map((t) => `<tr>
            <td>${esc(t.label)}</td>
            <td class="fine">${esc(when(t.created_at / 1000))}</td>
            <td class="fine">${t.last_used_at ? esc(when(t.last_used_at / 1000)) : 'never'}</td>
            <td><a href="#" data-revoke="${esc(t.id)}">Revoke</a></td>
          </tr>`).join('')}</table>`
        : `<p class="fine">No tokens issued.</p>`}
    </div>

    <div class="panel">
      <h2>Your account with the bank</h2>
      <p>Fees are collected per track from <a href="https://banking.southbag.cc">Southbag Online Banking</a>.
      The ledger there is the authoritative record. Fees are final. Kevin hates refunds.</p>
    </div>

    ${FOOTER}`;

  document.getElementById('file-listen').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = document.getElementById('file-result');
    result.innerHTML = '';
    const { status, body } = await api.post('/api/scrobble', {
      track_name: document.getElementById('f-track').value,
      artist_name: document.getElementById('f-artist').value,
      release_name: document.getElementById('f-album').value || undefined,
    });
    if (status === 200 && body.status === 'recorded') {
      result.innerHTML = `<div class="notice">Filed. Fee collected: ${esc(body.fee.amount)}.</div>`;
      setTimeout(() => signedIn(user, { welcome: false }), 1200);
    } else if (status === 200 && body.status === 'duplicate') {
      result.innerHTML = `<div class="notice">Already on file. No further fee was collected.</div>`;
    } else {
      result.innerHTML = `<div class="error">${esc(body.error || 'Filing failed.')}</div>`;
    }
  });

  document.getElementById('new-token').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = document.getElementById('token-result');
    const { status, body } = await api.post('/api/tokens', {
      label: document.getElementById('t-label').value || undefined,
    });
    if (status === 200) {
      result.innerHTML = `<div class="notice">Token issued. ${esc(body.notice)}</div>
        <div class="tokenbox">${esc(body.token)}</div>`;
      setTimeout(() => signedIn(user, { welcome: false }), 15000);
    } else {
      result.innerHTML = `<div class="error">${esc(body.error || 'Could not issue a token.')}</div>`;
    }
  });

  for (const link of document.querySelectorAll('[data-revoke]')) {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      await api.del(`/api/tokens/${encodeURIComponent(link.dataset.revoke)}`);
      signedIn(user, { welcome: false });
    });
  }
}

async function main() {
  const params = new URLSearchParams(location.search);
  const { body } = await api.get('/api/me');
  if (!body.authenticated) {
    const reason = params.get('login_error');
    signedOut(reason ? `Sign-in did not complete (${reason}). Try again.` : null);
    return;
  }
  await signedIn(body.user, { welcome: params.get('welcome') === '1' });
}

main().catch((error) => {
  console.error(error);
  app.innerHTML = `${WORDMARK}<div class="error">Something went wrong. Kevin has been notified.</div>${FOOTER}`;
});
