-- Southbag Scrobbler: listening history for Southbag accounts, a fee for every track.

CREATE TABLE users (
  id TEXT PRIMARY KEY,              -- Southbag Identity sub
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  identity_picture TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The first login from an origin registers a public PKCE client with Southbag Identity
-- (dynamic client registration) and remembers it here. See src/lib/auth.ts.
CREATE TABLE oauth_clients (
  origin TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT,
  expires_at INTEGER NOT NULL
);

-- Sessions are opaque random tokens; only the hash is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Personal API tokens for ListenBrainz-compatible clients (Authorization: Token ...).
-- Shown once at creation; only the hash is stored.
CREATE TABLE api_tokens (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- One row per scrobbled listen. The per-track fee is charged to the listener's Southbag
-- Online Banking account BEFORE the row is written; fee_cents records what was taken.
CREATE TABLE listens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  listened_at INTEGER NOT NULL,     -- unix seconds
  artist_name TEXT NOT NULL,
  track_name TEXT NOT NULL,
  release_name TEXT,
  additional_info TEXT,             -- JSON, as submitted
  recording_msid TEXT NOT NULL UNIQUE,
  submission_client TEXT,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  inserted_at INTEGER NOT NULL      -- unix seconds
);
CREATE INDEX listens_user_time ON listens(user_id, listened_at DESC);
-- Re-submitting the same listen is a no-op, never a second fee.
CREATE UNIQUE INDEX listens_dedupe ON listens(user_id, listened_at, artist_name, track_name);

-- Ephemeral "listening right now"; never charged, expires on its own.
CREATE TABLE playing_now (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  artist_name TEXT NOT NULL,
  track_name TEXT NOT NULL,
  release_name TEXT,
  additional_info TEXT,
  recording_msid TEXT NOT NULL,
  submission_client TEXT,
  inserted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
