import { addressSummarySchema } from '@cybrguard/contracts';
import type { Bindings } from '../index';
import { XonProvider } from '../providers/xon';
import { hasPremium, requireAddressSlot, requirePremium } from './findings';
import { APIError, encrypt, keyedHash } from './security';

export async function scanAddress(
  env: Bindings,
  userId: string,
  address: {
    id: string;
    email: string;
    verified: boolean;
    isPrimary: boolean;
    knownBreachCount: number | null;
    checkedAt: string | null;
  },
  generation?: number,
) {
  const now = Math.floor(Date.now() / 1000);
  const locked = await env.DB.prepare(
    'UPDATE monitored_emails SET scan_lease_until = ?, last_scan_attempt = ? WHERE id = ? AND user_id = ? AND scan_lease_until <= ? AND last_scan_attempt <= ? RETURNING id',
  )
    .bind(now + 45, now, address.id, userId, now, now - 60)
    .first();
  if (!locked)
    throw new APIError(
      'rate_limited',
      429,
      'A scan is in progress or was just requested. Wait a minute before trying again.',
      60,
    );
  try {
    const slot = await env.DB.prepare(
      'UPDATE rate_limits SET window_start = ? WHERE key = ? AND window_start <= ? RETURNING key',
    )
      .bind(Date.now() + 1500, 'xon-global', Date.now())
      .first();
    if (!slot)
      throw new APIError('rate_limited', 429, 'Another scan is running. Try again shortly.', 2);
    const result = await new XonProvider(env.XON_API_KEY as string).checkVerifiedEmail(
      address.email,
      await hasPremium(env, userId, address.email),
    );
    if (generation !== undefined) {
      await requirePremium(env, userId, address.email);
      await requireAddressSlot(env, userId, address.id, address.email);
      const current = await env.DB.prepare(
        'SELECT id FROM monitored_emails WHERE id = ? AND monitoring_enabled = 1 AND monitoring_generation = ?',
      )
        .bind(address.id, generation)
        .first();
      if (!current) throw new APIError('not_found', 404, 'Monitoring is no longer enabled.');
    }
    const baseline = await env.DB.prepare(
      'SELECT details_checked_at FROM monitored_emails WHERE id = ?',
    )
      .bind(address.id)
      .first<string | null>('details_checked_at');
    const guard =
      generation === undefined
        ? 'scan_lease_until = ?'
        : 'scan_lease_until = ? AND monitoring_enabled = 1 AND monitoring_generation = ?';
    const guardArgs = generation === undefined ? [now + 45] : [now + 45, generation];
    const statements = [
      env.DB.prepare(
        `UPDATE monitored_emails SET known_breach_count = ?, checked_at = ? WHERE id = ? AND user_id = ? AND ${guard}`,
      ).bind(result.knownBreachCount, result.checkedAt, address.id, userId, ...guardArgs),
    ];
    if (result.findings) {
      statements.push(
        env.DB.prepare(
          `UPDATE monitored_emails SET details_checked_at = ? WHERE id = ? AND ${guard}`,
        ).bind(result.checkedAt, address.id, ...guardArgs),
      );
      statements.push(
        env.DB.prepare(
          `UPDATE findings SET active = 0 WHERE address_id = ? AND EXISTS (SELECT 1 FROM monitored_emails WHERE id = ? AND ${guard})`,
        ).bind(address.id, address.id, ...guardArgs),
      );
      for (const finding of result.findings) {
        statements.push(
          env.DB.prepare(`INSERT INTO findings (id, address_id, breach_index, encrypted_details, first_seen_at, last_seen_at, is_new)
            SELECT ?, id, ?, ?, ?, ?, ? FROM monitored_emails WHERE id = ? AND user_id = ? AND ${guard}
            ON CONFLICT(address_id, breach_index) DO UPDATE SET encrypted_details = excluded.encrypted_details, last_seen_at = excluded.last_seen_at, active = 1`).bind(
            crypto.randomUUID(),
            await keyedHash(
              env.EMAIL_BLIND_INDEX_KEY as string,
              `${address.id}:${finding.breachId}`,
            ),
            await encrypt(env.DATA_ENCRYPTION_KEY as string, JSON.stringify(finding)),
            result.checkedAt,
            result.checkedAt,
            baseline ? 1 : 0,
            address.id,
            userId,
            ...guardArgs,
          ),
        );
      }
    }
    const saved = await env.DB.batch(statements);
    if (!saved[0]?.meta.changes)
      throw new APIError('unauthorised', 401, 'This account is no longer available.');
    return addressSummarySchema.parse({
      ...address,
      checkedAt: result.checkedAt,
      knownBreachCount: result.knownBreachCount,
    });
  } catch (error) {
    if (error instanceof APIError && error.code === 'provider_rate_limited')
      await env.DB.prepare(
        'UPDATE rate_limits SET window_start = MAX(window_start, ?) WHERE key = ?',
      )
        .bind(Date.now() + (error.retryAfter ?? 60) * 1000, 'xon-global')
        .run();
    throw error;
  } finally {
    await env.DB.prepare(
      'UPDATE monitored_emails SET scan_lease_until = 0 WHERE id = ? AND scan_lease_until = ?',
    )
      .bind(address.id, now + 45)
      .run();
  }
}
