# Southbag Scrobbler

Scrobbling, the Southbag way: your listening history, itemised and filed permanently.
A fee of $0.05 is collected from your
[Southbag Online Banking](https://github.com/SouthbagHQ/banking) account for every track.
Kevin gets His cut. Fees are final.

Speaks the **ListenBrainz API**, so existing scrobble clients work against it:

```
POST https://scrobbler.southbag.cc/1/submit-listens
Authorization: Token <your personal API token>
```

Covered endpoints: `POST /1/submit-listens` (single / playing_now / import),
`GET /1/validate-token`, `GET /1/user/:user/listens`, `GET /1/user/:user/listen-count`,
`GET /1/user/:user/playing-now`, `POST /1/playing-now/delete`, and `POST /1/delete-listen`
(refused - Southbag does not delete, and a deleted listen would be a refund).

Differences from ListenBrainz, honestly stated:

- **Every stored listen costs $0.05.** `playing_now` is free and never enters the ledger.
- **Imports arrive in batches of at most 25 listens per request** (each listen's fee is one
  call to the bank, and a Worker invocation can only make so many).
- Re-submitting an identical listen (same track, artist and second) is a no-op, never a
  second fee.
- No MusicBrainz mapping, recommendations or playlists. Paperwork only.

It signs in with **Southbag Identity** and follows the look of the other Southbag products
([Social](https://github.com/SouthbagHQ/social), [Identity](https://github.com/SouthbagHQ/identity)).

## How it runs (Cloudflare free plan)

- **One Worker** (`src/`, [Hono](https://hono.dev)) plus **Workers Assets** for the frontend
  (`public/`, plain ES modules, no build step). Only `/api/*`, `/auth/*` and `/1/*` wake the
  Worker; every other request is a free static file.
- **One D1 database** for users, sessions, personal API tokens and listens.
- **The per-track fee is real (fake) money.** Each listen is charged to the listener's Southbag
  Online Banking account through Banking's `Billing` entrypoint over a service binding
  (`BANKING`; RPC between the two Workers, not reachable from the internet) - see
  `src/lib/banking.ts`. The fee is collected BEFORE the listen is filed; if the bank refuses
  (frozen account) or can't be reached, the listen is not recorded. A deterministic
  idempotency key plus a dedupe index make a retried submission a no-op instead of a second
  debit. Locally there is no bank; `scripts/test.sh` sets `BANKING_DEV=1`, which makes charges
  succeed without one.
- **The account-level freeze is enforced** on every private request, checked fresh against
  Southbag Identity (`src/lib/identity.ts`, fail closed). Public listen reads stay public,
  like ListenBrainz.
- An hourly cron expires OAuth states, sessions and playing-now rows.

## Deploying

```sh
npm install
wrangler d1 create southbag-scrobbler      # put the id in wrangler.jsonc
wrangler secret put IDENTITY_INTERNAL_SECRET   # Scrobbler's entry from Identity's INTERNAL_API_SECRETS (key "southbag-scrobbler")
npm run deploy                              # checks the freeze secret, migrates, deploys
```

## Testing

```sh
npm test        # wrangler dev + local D1 + a mock Identity freeze API; node --test
npm run check   # tsc + syntax-check the frontend
```

Seeded local accounts: `southbag_scrobbler_session=dev-alice` (bob, erin, frank) and API
tokens `dev-token-alice` (…). dev-erin is frozen; dev-frank makes Identity fail, so the
fail-closed path is covered.

Kevin is watching.
