import { breachDetailsSchema, findingSchema, findingsResponseSchema } from '@cybrguard/contracts';
import type { Bindings } from '../index';
import { APIError, decrypt } from './security';

export async function hasPremium(env: Bindings, userId: string, email: string) {
  if (
    env.APP_ENV === 'staging' &&
    (env.STAGING_PREMIUM_EMAILS ?? '')
      .split(',')
      .some((value) => value.trim().toLowerCase() === email)
  )
    return true;
  const entitlement = await env.DB.prepare(
    'SELECT user_id FROM premium_entitlements WHERE user_id = ? AND expires_at > ?',
  )
    .bind(userId, Math.floor(Date.now() / 1000))
    .first();
  return !!entitlement;
}
export async function requirePremium(env: Bindings, userId: string, email: string) {
  if (!(await hasPremium(env, userId, email)))
    throw new APIError(
      'subscription_required',
      403,
      'Breach details and remediation require premium access.',
    );
}
export async function readFindings(env: Bindings, addressId: string) {
  const checkedAt = await env.DB.prepare(
    'SELECT details_checked_at FROM monitored_emails WHERE id = ?',
  )
    .bind(addressId)
    .first<string | null>('details_checked_at');
  const rows = await env.DB.prepare(
    'SELECT id, encrypted_details, first_seen_at, last_seen_at, remediated_at FROM findings WHERE address_id = ? AND active = 1 ORDER BY first_seen_at, id',
  )
    .bind(addressId)
    .all<{
      id: string;
      encrypted_details: string;
      first_seen_at: string;
      last_seen_at: string;
      remediated_at: string | null;
    }>();
  const findings = await Promise.all(
    rows.results.map(async (row) =>
      findingSchema.parse({
        ...breachDetailsSchema.parse(
          JSON.parse(await decrypt(env.DATA_ENCRYPTION_KEY as string, row.encrypted_details)),
        ),
        id: row.id,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        remediatedAt: row.remediated_at,
      }),
    ),
  );
  findings.sort(
    (a, b) =>
      Number(b.passwordRiskHighlighted) - Number(a.passwordRiskHighlighted) ||
      a.breachId.localeCompare(b.breachId),
  );
  return findingsResponseSchema.parse({ findings, checkedAt: checkedAt ?? null });
}
