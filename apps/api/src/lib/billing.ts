import { z } from 'zod';
import type { Bindings } from '../index';
import { APIError } from './security';

const entitlement = z.object({
  expires_date: z.iso.datetime({ offset: true }).nullable(),
  grace_period_expires_date: z.iso.datetime({ offset: true }).nullable().optional(),
});
const customer = z.object({
  subscriber: z.object({ entitlements: z.record(z.string(), entitlement) }),
});
export type BillingPlan = {
  plan: 'free' | 'personal' | 'family';
  quota: number;
  expiresAt: number | null;
};
export function resolveBilling(payload: unknown, now: number): BillingPlan {
  const result = customer.safeParse(payload);
  if (!result.success)
    throw new APIError('provider_bad_response', 502, 'Subscription status could not be verified.');
  for (const [id, plan, quota] of [
    ['monitoring_family', 'family', 15],
    ['monitoring_personal', 'personal', 3],
  ] as const) {
    const value = result.data.subscriber.entitlements[id];
    if (!value) continue;
    // These are recurring subscriptions: an absent expiry never grants lifetime access.
    const dates = [value.expires_date, value.grace_period_expires_date].filter(
      (date): date is string => !!date,
    );
    if (dates.some((date) => !Number.isFinite(Date.parse(date))))
      throw new APIError(
        'provider_bad_response',
        502,
        'Subscription status could not be verified.',
      );
    const expiry = Math.floor(Math.max(...dates.map((date) => Date.parse(date))) / 1000);
    if (expiry > now) return { plan, quota, expiresAt: expiry };
  }
  return { plan: 'free', quota: 1, expiresAt: null };
}

export function requireBillingConfiguration(env: Bindings) {
  if (!env.REVENUECAT_SECRET_KEY)
    throw new APIError('configuration_error', 503, 'Subscriptions are not configured yet.');
}

export async function reconcileBilling(env: Bindings, userId: string) {
  requireBillingConfiguration(env);
  const now = Math.floor(Date.now() / 1000);
  const token = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO billing_state (user_id) SELECT id FROM users WHERE id = ? ON CONFLICT(user_id) DO NOTHING',
  )
    .bind(userId)
    .run();
  const claimed = await env.DB.prepare(
    'UPDATE billing_state SET lease_token = ?, lease_until = ? WHERE user_id = ? AND lease_until <= ? RETURNING user_id',
  )
    .bind(token, now + 60, userId, now)
    .first();
  if (!claimed) {
    const exists = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!exists) return;
    throw new APIError('rate_limited', 429, 'Subscription verification is already running.', 60);
  }
  try {
    let response: Response;
    try {
      const request = fetch;
      response = await request(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
        {
          headers: {
            Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`,
            Accept: 'application/json',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      throw new APIError(
        'provider_unavailable',
        503,
        'Subscription verification is unavailable. Try again later.',
      );
    }
    if (!response.ok)
      throw new APIError(
        'provider_unavailable',
        503,
        'Subscription verification is unavailable. Try again later.',
      );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new APIError(
        'provider_bad_response',
        502,
        'Subscription status could not be verified.',
      );
    }
    const resolved = resolveBilling(payload, now);
    // Cap offline access at 24 hours; scheduled reconciliation refreshes this
    // snapshot. A provider failure preserves the existing confirmed snapshot.
    const effectiveExpiry = Math.min(resolved.expiresAt ?? 0, now + 86400);
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO premium_entitlements (user_id, expires_at, max_addresses)
        SELECT user_id, ?, ? FROM billing_state WHERE user_id = ? AND lease_token = ?
        ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, max_addresses = excluded.max_addresses`).bind(
        effectiveExpiry,
        resolved.quota,
        userId,
        token,
      ),
      env.DB.prepare(
        'UPDATE billing_state SET plan = ?, entitlement_expires_at = ?, verified_at = ? WHERE user_id = ? AND lease_token = ?',
      ).bind(resolved.plan, resolved.expiresAt, now, userId, token),
    ]);
    if (!results[0]?.meta.changes)
      throw new APIError('unauthorised', 401, 'This account is no longer available.');
    return resolved;
  } finally {
    await env.DB.prepare(
      'UPDATE billing_state SET lease_token = NULL, lease_until = ? WHERE user_id = ? AND lease_token = ?',
    )
      .bind(Math.floor(Date.now() / 1000), userId, token)
      .run();
  }
}

export async function reconcileDueBilling(env: Bindings) {
  if (!env.REVENUECAT_SECRET_KEY || env.APP_ENV === 'production' || env.DATA_MODE !== 'live')
    return;
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(
    'SELECT user_id FROM billing_state WHERE verified_at < ? AND lease_until <= ? ORDER BY lease_until, verified_at LIMIT 25',
  )
    .bind(now - 21600, now)
    .all<{ user_id: string }>();
  for (const row of due.results) {
    try {
      await reconcileBilling(env, row.user_id);
    } catch {
      /* Preserve snapshot; retry next Cron. No payloads or identifiers logged. */
    }
  }
  await env.DB.prepare('DELETE FROM processed_billing_events WHERE processed_at < ?')
    .bind(now - 30 * 86400)
    .run();
}
