-- User-chosen usernames (first one free, changes carry a fee) and the metered-API ledger.

ALTER TABLE users ADD COLUMN username TEXT;   -- lowercase, 3-20 of [a-z0-9_]; NULL until chosen

CREATE UNIQUE INDEX users_username_unique ON users(username) WHERE username IS NOT NULL;

-- One row per metered API call: the fee taken for serving data over the API.
CREATE TABLE api_fees (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  fee_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX api_fees_user ON api_fees(user_id, created_at DESC);
