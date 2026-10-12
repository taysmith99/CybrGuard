import { breachDetailsSchema, findingSchema, findingsResponseSchema } from '@cybrguard/contracts';
import type { Bindings } from '../index';
import { remediationSteps } from './remediation';
import { APIError, decrypt, keyedHash } from './security';

export async function hasPremium(env: Bindings, userId: string, _email: string) {
  if (env.APP_ENV === 'staging' && env.STAGING_PREMIUM_EMAILS) {
    const primaryIndex = await env.DB.prepare(
      'SELECT email_index FROM monitored_emails WHERE user_id = ? AND is_primary = 1',
    )
      .bind(userId)
      .first<string>('email_index');
    for (const allowed of env.STAGING_PREMIUM_EMAILS.split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)) {
      if (primaryIndex === (await keyedHash(env.EMAIL_BLIND_INDEX_KEY as string, allowed)))
        return true;
    }
  }
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
    'SELECT id, encrypted_details, first_seen_at, last_seen_at, remediated_at, is_new FROM findings WHERE address_id = ? AND active = 1 ORDER BY first_seen_at, id',
  )
    .bind(addressId)
    .all<{
      id: string;
      encrypted_details: string;
      first_seen_at: string;
      last_seen_at: string;
      remediated_at: string | null;
      is_new: number;
    }>();
  const actions = await env.DB.prepare(
    'SELECT a.finding_id, a.action_id, a.completed_at FROM finding_actions a JOIN findings f ON f.id = a.finding_id WHERE f.address_id = ? AND f.active = 1',
  )
    .bind(addressId)
    .all<{ finding_id: string; action_id: string; completed_at: string | null }>();
  const completed = new Map(
    actions.results.map((row) => [`${row.finding_id}:${row.action_id}`, row.completed_at]),
  );
  const findings = await Promise.all(
    rows.results.map(async (row) => {
      const details = breachDetailsSchema.parse(
        JSON.parse(await decrypt(env.DATA_ENCRYPTION_KEY as string, row.encrypted_details)),
      );
      return findingSchema.parse({
        ...details,
        id: row.id,
        isNew: row.is_new === 1,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        remediatedAt: row.remediated_at,
        remediationSteps: remediationSteps(details).map((step) => ({
          ...step,
          completedAt: completed.get(`${row.id}:${step.id}`) ?? null,
        })),
      });
    }),
  );
  findings.sort(
    (a, b) =>
      Number(b.passwordRiskHighlighted) - Number(a.passwordRiskHighlighted) ||
      a.breachId.localeCompare(b.breachId),
  );
  return findingsResponseSchema.parse({ findings, checkedAt: checkedAt ?? null });
}

export async function addressQuota(env: Bindings, userId: string, email: string) {
  if (!(await hasPremium(env, userId, email))) return 1;
  const quota = await env.DB.prepare(
    'SELECT max_addresses FROM premium_entitlements WHERE user_id = ? AND expires_at > ?',
  )
    .bind(userId, Math.floor(Date.now() / 1000))
    .first<number>('max_addresses');
  return quota ?? 3;
}
export async function requireAddressSlot(
  env: Bindings,
  userId: string,
  addressId: string,
  email: string,
) {
  const quota = await addressQuota(env, userId, email);
  const rows = await env.DB.prepare(
    'SELECT id FROM monitored_emails WHERE user_id = ? ORDER BY is_primary DESC, verified_at, id LIMIT ?',
  )
    .bind(userId, quota)
    .all<{ id: string }>();
  if (!rows.results.some((row) => row.id === addressId))
    throw new APIError(
      'subscription_required',
      403,
      'This address is paused because it is above your current plan quota. Remove an extra address or restore premium access.',
    );
}
