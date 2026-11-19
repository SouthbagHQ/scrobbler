// Recording listens and taking Kevin's cut.
//
// Every stored listen costs SCROBBLE_FEE_CENTS, charged to the listener's Southbag Online
// Banking account BEFORE the row is written (Kevin does not extend credit). A charge that the
// bank refuses - a frozen account, or the bank unreachable - means the listen is not recorded;
// scrobbling clients retry, and the deterministic idempotency key plus the dedupe index make a
// retry of the same logical listen a no-op instead of a second fee.

import type { Env, SessionUser } from '../env';
import { charge } from './banking';
import { newId, sha256 } from './ids';

export const SCROBBLE_FEE_CENTS = 5;

export interface SubmittedListen {
  listened_at?: unknown;
  track_metadata?: {
    artist_name?: unknown;
    track_name?: unknown;
    release_name?: unknown;
    additional_info?: unknown;
  };
}

export interface CleanListen {
  listenedAt: number; // unix seconds
  artist: string;
  track: string;
  release: string | null;
  additionalInfo: string; // JSON
  submissionClient: string | null;
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/** Validates and normalizes one submitted listen, or returns a problem string. */
export function cleanListen(raw: SubmittedListen, nowSec: number): CleanListen | string {
  const meta = raw?.track_metadata;
  if (!meta || typeof meta !== 'object') return 'listen is missing track_metadata';
  const artist = text(meta.artist_name, 500);
  const track = text(meta.track_name, 500);
  if (!artist) return 'track_metadata.artist_name is required';
  if (!track) return 'track_metadata.track_name is required';
  const release = text(meta.release_name, 500) || null;

  let listenedAt = nowSec;
  if (raw.listened_at !== undefined && raw.listened_at !== null) {
    const ts = Number(raw.listened_at);
    if (!Number.isFinite(ts) || ts <= 0) return 'listened_at must be a UNIX epoch timestamp';
    listenedAt = Math.floor(ts);
  }
  if (listenedAt > nowSec + 300) return 'listened_at may not be in the future';

  let additionalInfo = '{}';
  if (meta.additional_info && typeof meta.additional_info === 'object' && !Array.isArray(meta.additional_info)) {
    additionalInfo = JSON.stringify(meta.additional_info).slice(0, 4000);
  }
  let submissionClient: string | null = null;
  try {
    const info = JSON.parse(additionalInfo) as { submission_client?: unknown };
    submissionClient = text(info.submission_client, 200) || null;
  } catch { /* keep null */ }

  return { listenedAt, artist, track, release, additionalInfo, submissionClient };
}

export type RecordOutcome =
  | { status: 'recorded'; msid: string; balance: number | null }
  | { status: 'duplicate' };

/**
 * Charges the per-track fee and files the listen. Throws when the bank cannot or will not
 * charge (frozen account, outage) - the caller turns that into a refusal and the client retries.
 */
export async function recordListen(env: Env, user: SessionUser, listen: CleanListen): Promise<RecordOutcome> {
  // Paperwork already on file? Filing it again changes nothing and costs nothing.
  const existing = await env.DB.prepare(
    'SELECT id FROM listens WHERE user_id = ? AND listened_at = ? AND artist_name = ? AND track_name = ?')
    .bind(user.id, listen.listenedAt, listen.artist, listen.track).first();
  if (existing) return { status: 'duplicate' };

  // Deterministic key: a retried submission of the same listen dedupes at the bank too.
  const key = 'scrobbler-' + await sha256(`${user.id}|${listen.listenedAt}|${listen.artist}|${listen.track}`);
  const description = `Scrobble fee: ${listen.track} - ${listen.artist}`.slice(0, 110);
  const result = await charge(env, user, SCROBBLE_FEE_CENTS, description, key);

  const msid = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO listens
      (id, user_id, listened_at, artist_name, track_name, release_name, additional_info,
       recording_msid, submission_client, fee_cents, inserted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), user.id, listen.listenedAt, listen.artist, listen.track, listen.release,
        listen.additionalInfo, msid, listen.submissionClient, SCROBBLE_FEE_CENTS, Math.floor(Date.now() / 1000))
      .run();
  } catch (error) {
    // A twin request beat us to the same listen; the bank deduped the charge (same key).
    if (String(error).includes('UNIQUE')) return { status: 'duplicate' };
    throw error;
  }
  return { status: 'recorded', msid, balance: result.balance };
}

export interface ListenRow {
  id: string;
  user_id: string;
  listened_at: number;
  artist_name: string;
  track_name: string;
  release_name: string | null;
  additional_info: string | null;
  recording_msid: string;
  submission_client: string | null;
  inserted_at: number;
}

/** The ListenBrainz JSON shape for one stored listen. */
export function listenJson(row: ListenRow, handle: string) {
  let info: Record<string, unknown> = {};
  try { info = row.additional_info ? JSON.parse(row.additional_info) : {}; } catch { /* keep {} */ }
  if (row.submission_client && !info.submission_client) info.submission_client = row.submission_client;
  const metadata: Record<string, unknown> = {
    artist_name: row.artist_name,
    track_name: row.track_name,
  };
  if (row.release_name) metadata.release_name = row.release_name;
  if (Object.keys(info).length) metadata.additional_info = info;
  return {
    listened_at: row.listened_at,
    recording_msid: row.recording_msid,
    user_name: handle,
    track_metadata: metadata,
    inserted_at: row.inserted_at,
  };
}
