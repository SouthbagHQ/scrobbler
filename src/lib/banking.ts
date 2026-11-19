// Southbag Online Banking, through a service binding (BANKING in wrangler.jsonc) to its Billing
// entrypoint - RPC between Workers, not reachable from the internet. See ../banking/worker.js.
// Banking opens an account for anyone who doesn't have one. Local dev and tests have no bank:
// with BANKING_DEV=1 (scripts/test.sh) a stand-in answers instead (charges succeed).

import type { Env } from '../env';
import { newId } from './ids';

export interface Customer { userId: string; email: string | null; name: string }

export interface BankingBilling {
  charge(input: Customer & { amount: number; product: string; description: string; idempotencyKey?: string }): Promise<{ balance: number; opened: boolean; duplicate?: boolean }>;
}

export const API_FETCH_FEE_CENTS = 1;   // any authenticated data fetch over the API
export const CHART_FEE_CENTS = 10;      // charts are premium paperwork

export const money = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

const dev = (env: Env) => String(env.BANKING_DEV ?? '') === '1';

/**
 * Takes `amount` cents from the user's Southbag Online Banking account. Throws if the bank
 * can't be reached or refuses (frozen account). An idempotencyKey makes a retried charge a
 * no-op (duplicate: true) instead of a second debit - Banking dedupes on it.
 */
export async function charge(env: Env, user: { id: string; email: string | null; name: string }, amount: number, description: string, idempotencyKey?: string) {
  if (dev(env)) return { balance: null, opened: false, duplicate: false };
  if (!env.BANKING) throw new Error('BANKING is not bound');
  const result = await env.BANKING.charge({
    userId: user.id,
    email: user.email,
    name: user.name,
    amount,
    product: 'Southbag Scrobbler',
    description,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  return { balance: result.balance as number | null, opened: result.opened, duplicate: result.duplicate ?? false };
}

/**
 * Takes a fee for serving one API request, then records it in the api_fees ledger so the
 * dashboard can total everything Kevin has taken. Throws if the bank refuses (frozen) or
 * can't be reached - the request then fails rather than being served for free.
 */
export async function meter(env: Env, user: { id: string; email: string | null; name: string }, endpoint: string, amount: number) {
  await charge(env, user, amount, `API fee: ${endpoint}`);
  await env.DB.prepare('INSERT INTO api_fees (id, user_id, endpoint, fee_cents, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newId(), user.id, endpoint, amount, Date.now()).run();
}
