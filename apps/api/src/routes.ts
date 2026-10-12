import {
  accountResponseSchema,
  addressListSchema,
  addressSummarySchema,
  authRefreshSchema,
  authStartSchema,
  authVerifySchema,
  billingStatusSchema,
  deviceCredentialSchema,
  monitoringResponseSchema,
  monitoringUpdateSchema,
  remediationSchema,
  remediationStepUpdateSchema,
  sessionListSchema,
  sessionResponseSchema,
  verificationResponseSchema,
} from '@cybrguard/contracts';
import { z } from 'zod';
import type { app as application, Bindings } from './index';
import { reconcileBilling, requireBillingConfiguration } from './lib/billing';
import {
  addressQuota,
  hasPremium,
  readFindings,
  requireAddressSlot,
  requirePremium,
} from './lib/findings';
import { defaultMonitoring } from './lib/monitoring-default';
import { scanAddress } from './lib/scan';
import {
  APIError,
  decrypt,
  encrypt,
  hash,
  keyedHash,
  randomToken,
  verificationCode,
} from './lib/security';
import { requireEmailConfiguration, sendVerificationEmail } from './providers/email';

type App = typeof application;
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function input<T>(request: Request, schema: z.ZodType<T>, maximum = 4096): Promise<T> {
  // Bounded body reading also handles requests without a Content-Length header.
  const reader = request.body?.getReader();
  if (!reader) throw new APIError('invalid_request', 400, 'A JSON request is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new APIError('invalid_request', 400, 'Request is too large.');
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (result.success) return result.data;
  } catch {
    /* No request data in errors. */
  }
  throw new APIError(
    'invalid_request',
    400,
    'Check the email, consent or verification fields and try again.',
  );
}

function requireLive(env: Bindings) {
  if (
    env.DATA_MODE !== 'live' ||
    !env.DATA_ENCRYPTION_KEY ||
    !env.EMAIL_BLIND_INDEX_KEY ||
    !env.XON_API_KEY
  )
    throw new APIError('configuration_error', 503, 'The scan backend is not configured.');
}

async function limit(env: Bindings, key: string, count: number, window: number) {
  const now = nowSeconds();
  const row =
    await env.DB.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
    window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
    RETURNING count, window_start`)
      .bind(key, now, now - window, now - window)
      .first<{ count: number; window_start: number }>();
  if (!row || row.count > count)
    throw new APIError(
      'rate_limited',
      429,
      'Too many requests. Try again later.',
      Math.max(1, (row?.window_start ?? now) + window - now),
    );
}

type Session = {
  id: string;
  user_id: string;
  family_id: string;
  refresh_expires_at: number;
  revoked_at: number | null;
  device_hash: string;
};
async function authenticate(request: Request, env: Bindings): Promise<Session> {
  requireLive(env);
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const device = request.headers.get('X-Device-ID');
  if (!token || !device || !deviceCredentialSchema.safeParse(device).success)
    throw new APIError('unauthorised', 401, 'Sign in to continue.');
  const session = await env.DB.prepare(
    'SELECT * FROM sessions WHERE access_hash = ? AND device_hash = ? AND revoked_at IS NULL AND access_expires_at > ?',
  )
    .bind(await hash(token), await hash(device), nowSeconds())
    .first<Session>();
  if (!session) throw new APIError('unauthorised', 401, 'Your session expired. Sign in again.');
  return session;
}
async function tokens(device: string, family = crypto.randomUUID()) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  return {
    id: crypto.randomUUID(),
    family,
    accessToken,
    refreshToken,
    accessHash: await hash(accessToken),
    refreshHash: await hash(refreshToken),
    deviceHash: await hash(device),
    accessExpiresAt: nowSeconds() + 900,
    refreshExpiresAt: nowSeconds() + 30 * 86400,
  };
}
const tokenResponse = (token: Awaited<ReturnType<typeof tokens>>) => ({
  accessToken: token.accessToken,
  refreshToken: token.refreshToken,
  expiresAt: token.accessExpiresAt,
});

async function account(env: Bindings, userId: string, addressId?: string) {
  const row = await env.DB.prepare(
    `SELECT id, encrypted_email, known_breach_count, checked_at, is_primary FROM monitored_emails WHERE user_id = ? AND ${addressId ? 'id = ?' : 'is_primary = 1'}`,
  )
    .bind(...(addressId ? [userId, addressId] : [userId]))
    .first<{
      id: string;
      encrypted_email: string;
      is_primary: number;
      known_breach_count: number | null;
      checked_at: string | null;
    }>();
  if (!row)
    throw new APIError(
      addressId ? 'not_found' : 'unauthorised',
      addressId ? 404 : 401,
      addressId ? 'Address not found.' : 'This account is no longer available.',
    );
  return {
    id: row.id,
    email: await decrypt(env.DATA_ENCRYPTION_KEY as string, row.encrypted_email),
    verified: true,
    isPrimary: row.is_primary === 1,
    knownBreachCount: row.known_breach_count,
    checkedAt: row.checked_at,
  };
}

export function registerRoutes(app: App) {
  app.post('/v1/auth/start', async (c) => {
    requireLive(c.env);
    requireEmailConfiguration(c.env);
    const body = await input(c.req.raw, authStartSchema);
    if (c.env.APP_ENV === 'staging') {
      const allowed = (c.env.STAGING_ALLOWED_EMAILS ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase());
      if (!allowed.includes(body.email))
        throw new APIError(
          'forbidden',
          403,
          'This staging service is limited to approved testers.',
        );
    }
    const key = c.env.EMAIL_BLIND_INDEX_KEY as string;
    const index = await keyedHash(key, body.email);
    const deviceHash = await hash(body.deviceId);
    const ipHash = await keyedHash(key, c.req.header('CF-Connecting-IP') ?? 'local');
    await limit(c.env, `send-ip:${ipHash}`, 20, 3600);
    await limit(c.env, `send-device:${deviceHash}`, 10, 3600);
    await limit(c.env, `send-email:${index}`, 5, 3600);
    await limit(c.env, `send-minute:${index}`, 1, 60);
    const now = nowSeconds();
    await c.env.DB.prepare('DELETE FROM email_verifications WHERE expires_at < ?')
      .bind(now - 3600)
      .run();
    await c.env.DB.prepare('DELETE FROM sessions WHERE refresh_expires_at < ?')
      .bind(now - 86400)
      .run();
    await c.env.DB.prepare('DELETE FROM rate_limits WHERE key != ? AND window_start < ?')
      .bind('xon-global', now - 86400)
      .run();
    const challengeId = crypto.randomUUID();
    const code = verificationCode();
    await c.env.DB.prepare(
      'INSERT INTO email_verifications (id, email_index, encrypted_email, code_hash, device_hash, consent_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        challengeId,
        index,
        await encrypt(c.env.DATA_ENCRYPTION_KEY as string, body.email),
        await keyedHash(key, `${challengeId}:${code}`),
        deviceHash,
        now,
        now,
        now + 600,
      )
      .run();
    try {
      await sendVerificationEmail(c.env, body.email, code);
    } catch (error) {
      await c.env.DB.prepare('DELETE FROM email_verifications WHERE id = ?')
        .bind(challengeId)
        .run();
      throw error;
    }
    // New and existing accounts have exactly the same response and email flow.
    return c.json(
      verificationResponseSchema.parse({
        challengeId,
        expiresIn: 600,
        message: 'If delivery is available, a verification code will arrive shortly.',
      }),
      202,
    );
  });

  app.post('/v1/auth/verify', async (c) => {
    requireLive(c.env);
    const body = await input(c.req.raw, authVerifySchema);
    const deviceHash = await hash(body.deviceId);
    await limit(c.env, `verify:${deviceHash}`, 30, 3600);
    const now = nowSeconds();
    // Reserving each attempt atomically makes concurrent guesses share one five-attempt budget.
    const challenge = await c.env.DB.prepare(
      `UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ? AND device_hash = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < 5 AND purpose = 'login' AND user_id IS NULL RETURNING *`,
    )
      .bind(body.challengeId, deviceHash, now)
      .first<{
        code_hash: string;
        email_index: string;
        encrypted_email: string;
        consent_at: number;
      }>();
    const codeHash = await keyedHash(
      c.env.EMAIL_BLIND_INDEX_KEY as string,
      `${body.challengeId}:${body.code}`,
    );
    if (!challenge || challenge.code_hash !== codeHash)
      throw new APIError(
        'invalid_code',
        400,
        'The code is incorrect, expired or already used. Request a new code if needed.',
      );
    const consumed = await c.env.DB.prepare(
      'UPDATE email_verifications SET consumed_at = ? WHERE id = ? AND code_hash = ? AND device_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING id',
    )
      .bind(now, body.challengeId, codeHash, deviceHash, now)
      .first();
    if (!consumed)
      throw new APIError('invalid_code', 400, 'The code is incorrect, expired or already used.');
    const token = await tokens(body.deviceId);
    const userId = crypto.randomUUID();
    const addressId = crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM monitored_emails WHERE email_index = ?)',
      ).bind(userId, now, challenge.email_index),
      c.env.DB.prepare(
        `INSERT INTO monitored_emails (id, user_id, encrypted_email, email_index, verified_at, consent_at, is_primary) SELECT ?, ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) ON CONFLICT(email_index) DO UPDATE SET consent_at = excluded.consent_at`,
      ).bind(
        addressId,
        userId,
        challenge.encrypted_email,
        challenge.email_index,
        now,
        challenge.consent_at,
        userId,
      ),
      c.env.DB.prepare('UPDATE monitored_emails SET consent_at = ? WHERE email_index = ?').bind(
        challenge.consent_at,
        challenge.email_index,
      ),
      c.env.DB.prepare(
        'INSERT INTO sessions (id, user_id, family_id, access_hash, refresh_hash, device_hash, access_expires_at, refresh_expires_at) SELECT ?, user_id, ?, ?, ?, ?, ?, ? FROM monitored_emails WHERE email_index = ? AND is_primary = 1',
      ).bind(
        token.id,
        token.family,
        token.accessHash,
        token.refreshHash,
        token.deviceHash,
        token.accessExpiresAt,
        token.refreshExpiresAt,
        challenge.email_index,
      ),
    ]);
    if (!(await c.env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind(token.id).first()))
      throw new APIError('invalid_code', 400, 'Use your primary sign-in email for this account.');
    return c.json(sessionResponseSchema.parse(tokenResponse(token)));
  });

  app.post('/v1/auth/refresh', async (c) => {
    requireLive(c.env);
    const body = await input(c.req.raw, authRefreshSchema);
    const deviceHash = await hash(body.deviceId);
    await limit(c.env, `refresh:${deviceHash}`, 60, 3600);
    const refreshHash = await hash(body.refreshToken);
    const old = await c.env.DB.prepare(
      'SELECT * FROM sessions WHERE refresh_hash = ? AND device_hash = ?',
    )
      .bind(refreshHash, deviceHash)
      .first<Session>();
    const now = nowSeconds();
    if (!old || old.refresh_expires_at <= now)
      throw new APIError('unauthorised', 401, 'Sign in again.');
    if (old.revoked_at !== null) {
      await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE family_id = ?')
        .bind(now, old.family_id)
        .run();
      throw new APIError('unauthorised', 401, 'This session was revoked. Sign in again.');
    }
    const token = await tokens(body.deviceId, old.family_id);
    // Rotation retains a fixed family expiry; refresh cannot extend a login indefinitely.
    token.refreshExpiresAt = old.refresh_expires_at;
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO sessions (id, user_id, family_id, access_hash, refresh_hash, device_hash, access_expires_at, refresh_expires_at) SELECT ?, user_id, family_id, ?, ?, device_hash, ?, refresh_expires_at FROM sessions WHERE id = ? AND revoked_at IS NULL AND refresh_expires_at > ?',
      ).bind(token.id, token.accessHash, token.refreshHash, token.accessExpiresAt, old.id, now),
      c.env.DB.prepare(
        'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      ).bind(now, old.id),
    ]);
    if (results[0]?.meta.changes !== 1) {
      await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE family_id = ?')
        .bind(now, old.family_id)
        .run();
      throw new APIError('unauthorised', 401, 'Sign in again.');
    }
    return c.json(sessionResponseSchema.parse(tokenResponse(token)));
  });

  app.post('/v1/auth/logout', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    await c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE family_id = ?')
      .bind(nowSeconds(), session.family_id)
      .run();
    return c.body(null, 204);
  });
  app.post('/v1/billing/reconcile', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    await limit(c.env, `billing:${session.user_id}`, 12, 3600);
    await reconcileBilling(c.env, session.user_id);
    return c.body(null, 204);
  });
  app.get('/v1/billing', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const state = await c.env.DB.prepare(
      'SELECT plan, entitlement_expires_at, verified_at FROM billing_state WHERE user_id = ?',
    )
      .bind(session.user_id)
      .first<{ plan: string; entitlement_expires_at: number | null; verified_at: number }>();
    const expired =
      (state?.entitlement_expires_at ?? 0) <= nowSeconds() ||
      (state?.verified_at ?? 0) + 86400 <= nowSeconds();
    return c.json(
      billingStatusSchema.parse({
        configured: !!c.env.REVENUECAT_SECRET_KEY,
        plan: expired ? 'free' : (state?.plan ?? 'free'),
        expiresAt: state?.entitlement_expires_at ?? null,
        verifiedAt: state?.verified_at ?? null,
      }),
    );
  });
  app.post('/v1/billing/revenuecat/webhook', async (c) => {
    requireLive(c.env);
    requireBillingConfiguration(c.env);
    if (
      !c.env.REVENUECAT_WEBHOOK_AUTH ||
      c.env.REVENUECAT_WEBHOOK_AUTH.length < 32 ||
      !c.env.REVENUECAT_APP_ID
    )
      throw new APIError('configuration_error', 503, 'Subscription webhook is not configured.');
    // Compare fixed-size digests without an early mismatch branch.
    const received = await hash(c.req.header('Authorization') ?? '');
    const expected = await hash(c.env.REVENUECAT_WEBHOOK_AUTH);
    let different = 0;
    for (let i = 0; i < expected.length; i++)
      different |= expected.charCodeAt(i) ^ received.charCodeAt(i);
    if (different) throw new APIError('unauthorised', 401, 'Webhook authentication failed.');
    const body = await input(
      c.req.raw,
      z.object({
        event: z.object({
          id: z.string().min(1).max(128),
          type: z.string().min(1).max(80),
          app_id: z.string(),
          environment: z.enum(['SANDBOX', 'PRODUCTION']).optional(),
          app_user_id: z.string().max(256).optional(),
          transferred_from: z.array(z.string().max(256)).max(50).optional(),
          transferred_to: z.array(z.string().max(256)).max(50).optional(),
        }),
      }),
      16384,
    );
    const event = body.event;
    if (
      event.app_id !== c.env.REVENUECAT_APP_ID ||
      (event.type !== 'TEST' && event.environment !== 'SANDBOX')
    )
      throw new APIError('forbidden', 403, 'Webhook app or store environment is not enabled.');
    if (
      await c.env.DB.prepare('SELECT id FROM processed_billing_events WHERE id = ?')
        .bind(event.id)
        .first()
    )
      return c.json({ received: true });
    // Events trigger a fresh server lookup rather than granting from the event
    // payload. Duplicate/delayed/cancel/refund/transfer events share one path.
    const identifiers = new Set([
      event.app_user_id,
      ...(event.transferred_from ?? []),
      ...(event.transferred_to ?? []),
    ]);
    for (const userId of identifiers) {
      if (!userId || !z.uuid().safeParse(userId).success) continue;
      if (await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first())
        await reconcileBilling(c.env, userId);
    }
    await c.env.DB.prepare(
      'INSERT INTO processed_billing_events (id, processed_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING',
    )
      .bind(event.id, nowSeconds())
      .run();
    return c.json({ received: true });
  });
  app.get('/v1/sessions', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const rows =
      await c.env.DB.prepare(`SELECT family_id, MAX(refresh_expires_at) AS expires_at FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND refresh_expires_at > ? GROUP BY family_id ORDER BY family_id`)
        .bind(session.user_id, nowSeconds())
        .all<{ family_id: string; expires_at: number }>();
    return c.json(
      sessionListSchema.parse({
        sessions: rows.results.map((row) => ({
          id: row.family_id,
          current: row.family_id === session.family_id,
          expiresAt: row.expires_at,
        })),
      }),
    );
  });
  app.post('/v1/sessions/revoke-others', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    await c.env.DB.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND family_id != ? AND revoked_at IS NULL',
    )
      .bind(nowSeconds(), session.user_id, session.family_id)
      .run();
    return c.body(null, 204);
  });
  app.delete('/v1/sessions/:id', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const revoked = await c.env.DB.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND family_id = ? AND revoked_at IS NULL RETURNING id',
    )
      .bind(nowSeconds(), session.user_id, c.req.param('id'))
      .first();
    if (!revoked) throw new APIError('not_found', 404, 'Session not found.');
    return c.body(null, 204);
  });
  app.get('/v1/me', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id);
    return c.json(
      accountResponseSchema.parse({
        userId: session.user_id,
        tier: (await hasPremium(c.env, session.user_id, address.email)) ? 'premium' : 'free',
        quota: await addressQuota(c.env, session.user_id, address.email),
        address,
      }),
    );
  });
  app.get('/v1/addresses', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const primary = await account(c.env, session.user_id);
    const rows = await c.env.DB.prepare(
      'SELECT id FROM monitored_emails WHERE user_id = ? ORDER BY is_primary DESC, verified_at, id',
    )
      .bind(session.user_id)
      .all<{ id: string }>();
    return c.json(
      addressListSchema.parse({
        addresses: await Promise.all(
          rows.results.map((row) => account(c.env, session.user_id, row.id)),
        ),
        quota: await addressQuota(c.env, session.user_id, primary.email),
      }),
    );
  });
  app.post('/v1/addresses/verify/start', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    requireEmailConfiguration(c.env);
    const body = await input(c.req.raw, authStartSchema);
    if ((await hash(body.deviceId)) !== session.device_hash)
      throw new APIError('unauthorised', 401, 'Use the signed-in device.');
    const primary = await account(c.env, session.user_id);
    await requirePremium(c.env, session.user_id, primary.email);
    const quota = await addressQuota(c.env, session.user_id, primary.email);
    const count = await c.env.DB.prepare(
      'SELECT COUNT(*) AS count FROM monitored_emails WHERE user_id = ?',
    )
      .bind(session.user_id)
      .first<number>('count');
    if ((count ?? 0) >= quota)
      throw new APIError('subscription_required', 403, 'Your address quota is full.');
    const key = c.env.EMAIL_BLIND_INDEX_KEY as string;
    const index = await keyedHash(key, body.email);
    const ipHash = await keyedHash(key, c.req.header('CF-Connecting-IP') ?? 'local');
    await limit(c.env, `send-ip:${ipHash}`, 20, 3600);
    await limit(c.env, `send-device:${session.device_hash}`, 10, 3600);
    await limit(c.env, `send-email:${index}`, 5, 3600);
    await limit(c.env, `send-minute:${index}`, 1, 60);
    const challengeId = crypto.randomUUID();
    const code = verificationCode();
    const now = nowSeconds();
    const saved = await c.env.DB.prepare(`INSERT INTO email_verifications
      (id, email_index, encrypted_email, code_hash, device_hash, consent_at, created_at, expires_at, purpose, user_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'address', id FROM users WHERE id = ?`)
      .bind(
        challengeId,
        index,
        await encrypt(c.env.DATA_ENCRYPTION_KEY as string, body.email),
        await keyedHash(key, `${challengeId}:${code}`),
        session.device_hash,
        now,
        now,
        now + 600,
        session.user_id,
      )
      .run();
    if (!saved.meta.changes) throw new APIError('unauthorised', 401, 'Sign in again.');
    try {
      await sendVerificationEmail(c.env, body.email, code);
    } catch (error) {
      await c.env.DB.prepare('DELETE FROM email_verifications WHERE id = ?')
        .bind(challengeId)
        .run();
      throw error;
    }
    return c.json(
      verificationResponseSchema.parse({
        challengeId,
        expiresIn: 600,
        message: 'If delivery is available, a verification code will arrive shortly.',
      }),
      202,
    );
  });
  app.post('/v1/addresses/verify/complete', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const body = await input(c.req.raw, authVerifySchema);
    if ((await hash(body.deviceId)) !== session.device_hash)
      throw new APIError('unauthorised', 401, 'Use the signed-in device.');
    await limit(c.env, `verify:${session.device_hash}`, 30, 3600);
    const primary = await account(c.env, session.user_id);
    await requirePremium(c.env, session.user_id, primary.email);
    const quota = await addressQuota(c.env, session.user_id, primary.email);
    const now = nowSeconds();
    const challenge = await c.env.DB.prepare(`UPDATE email_verifications SET attempts = attempts + 1
      WHERE id = ? AND user_id = ? AND purpose = 'address' AND device_hash = ?
      AND consumed_at IS NULL AND expires_at > ? AND attempts < 5 RETURNING *`)
      .bind(body.challengeId, session.user_id, session.device_hash, now)
      .first<{
        code_hash: string;
        email_index: string;
        encrypted_email: string;
        consent_at: number;
      }>();
    const codeHash = await keyedHash(
      c.env.EMAIL_BLIND_INDEX_KEY as string,
      `${body.challengeId}:${body.code}`,
    );
    if (!challenge || challenge.code_hash !== codeHash)
      throw new APIError('invalid_code', 400, 'The code is incorrect, expired or already used.');
    const addressId = crypto.randomUUID();
    // Both statements run in a single transaction. A unique consumed marker binds
    // this insertion to this redemption, while COUNT enforces concurrent quotas.
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE email_verifications SET consumed_at = ? WHERE id = ? AND user_id = ?
        AND consumed_at IS NULL AND expires_at > ? AND code_hash = ?`).bind(
        now,
        body.challengeId,
        session.user_id,
        now,
        codeHash,
      ),
      c.env.DB.prepare(`INSERT INTO monitored_emails
        (id, user_id, encrypted_email, email_index, verified_at, consent_at, is_primary)
        SELECT ?, ?, ?, ?, ?, ?, 0 WHERE changes() = 1
        AND EXISTS (SELECT 1 FROM users WHERE id = ?)
        AND (SELECT COUNT(*) FROM monitored_emails WHERE user_id = ?) < ?
        ON CONFLICT(email_index) DO NOTHING`).bind(
        addressId,
        session.user_id,
        challenge.encrypted_email,
        challenge.email_index,
        now,
        challenge.consent_at,
        session.user_id,
        session.user_id,
        quota,
      ),
      defaultMonitoring(c.env, session.user_id, now),
    ]);
    if (!results[0]?.meta.changes)
      throw new APIError('invalid_code', 400, 'The code is incorrect, expired or already used.');
    if (!results[1]?.meta.changes)
      throw new APIError(
        'invalid_request',
        400,
        'The address could not be added. Check your quota or use another address.',
      );
    return c.json(
      addressSummarySchema.parse(await account(c.env, session.user_id, addressId)),
      201,
    );
  });
  app.delete('/v1/addresses/:id', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id, c.req.param('id'));
    if (address.isPrimary)
      throw new APIError(
        'invalid_request',
        400,
        'Your primary address belongs to your account. Use account deletion to remove it.',
      );
    await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM email_verifications WHERE user_id = ? AND email_index = ?',
      ).bind(
        session.user_id,
        await keyedHash(c.env.EMAIL_BLIND_INDEX_KEY as string, address.email),
      ),
      c.env.DB.prepare(
        'DELETE FROM monitored_emails WHERE id = ? AND user_id = ? AND is_primary = 0',
      ).bind(address.id, session.user_id),
    ]);
    return c.body(null, 204);
  });
  app.get('/v1/addresses/:id/monitoring', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id, c.req.param('id'));
    const row = await c.env.DB.prepare(
      `SELECT monitoring_enabled, last_monitoring_at, next_check_at, last_monitoring_outcome FROM monitored_emails WHERE id = ? AND user_id = ?`,
    )
      .bind(address.id, session.user_id)
      .first<{
        monitoring_enabled: number;
        last_monitoring_at: string | null;
        next_check_at: number | null;
        last_monitoring_outcome: string | null;
      }>();
    let paused = !(await hasPremium(c.env, session.user_id, address.email));
    if (!paused) {
      try {
        await requireAddressSlot(c.env, session.user_id, address.id, address.email);
      } catch (error) {
        if (error instanceof APIError && error.code === 'subscription_required') paused = true;
        else throw error;
      }
    }
    return c.json(
      monitoringResponseSchema.parse({
        enabled: row?.monitoring_enabled === 1,
        paused,
        cadenceHours: 24,
        lastCheckedAt: row?.last_monitoring_at ?? null,
        nextCheckAt: row?.next_check_at ?? null,
        outcome: row?.last_monitoring_outcome ?? null,
        pushAvailable: false,
      }),
    );
  });
  app.patch('/v1/addresses/:id/monitoring', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id, c.req.param('id'));
    const body = await input(c.req.raw, monitoringUpdateSchema);
    if (body.enabled) {
      if (!c.env.MONITORING_QUEUE)
        throw new APIError('configuration_error', 503, 'Scheduled monitoring is not configured.');
      await requirePremium(c.env, session.user_id, address.email);
      await requireAddressSlot(c.env, session.user_id, address.id, address.email);
    }
    await c.env.DB.prepare(`UPDATE monitored_emails SET monitoring_enabled = ?, monitoring_preference_set = 1, monitoring_generation = monitoring_generation + 1,
      next_check_at = ?, last_monitoring_outcome = ? WHERE id = ? AND user_id = ?`)
      .bind(
        body.enabled ? 1 : 0,
        body.enabled ? nowSeconds() : null,
        body.enabled ? 'pending' : 'disabled',
        address.id,
        session.user_id,
      )
      .run();
    return c.body(null, 204);
  });
  app.get('/v1/addresses/:id/summary', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id, c.req.param('id'));
    if (address.id !== c.req.param('id'))
      throw new APIError('not_found', 404, 'Address not found.');
    return c.json(addressSummarySchema.parse(address));
  });
  app.get('/v1/addresses/:id/findings', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id, c.req.param('id'));
    if (address.id !== c.req.param('id'))
      throw new APIError('not_found', 404, 'Address not found.');
    await requirePremium(c.env, session.user_id, address.email);
    await requireAddressSlot(c.env, session.user_id, address.id, address.email);
    return c.json(await readFindings(c.env, address.id));
  });
  app.patch('/v1/addresses/:id/findings/:findingId', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id, c.req.param('id'));
    if (address.id !== c.req.param('id'))
      throw new APIError('not_found', 404, 'Address not found.');
    await requirePremium(c.env, session.user_id, address.email);
    await requireAddressSlot(c.env, session.user_id, address.id, address.email);
    const body = await input(c.req.raw, remediationSchema);
    const saved = await c.env.DB.prepare(
      'UPDATE findings SET is_new = 0, remediated_at = CASE WHEN ? = 1 THEN COALESCE(remediated_at, ?) ELSE NULL END WHERE id = ? AND address_id = ? AND active = 1 RETURNING id',
    )
      .bind(body.remediated ? 1 : 0, new Date().toISOString(), c.req.param('findingId'), address.id)
      .first();
    if (!saved) throw new APIError('not_found', 404, 'Finding not found.');
    return c.json(await readFindings(c.env, address.id));
  });
  app.patch('/v1/addresses/:id/findings/:findingId/actions/:actionId', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id, c.req.param('id'));
    if (address.id !== c.req.param('id'))
      throw new APIError('not_found', 404, 'Address not found.');
    await requirePremium(c.env, session.user_id, address.email);
    await requireAddressSlot(c.env, session.user_id, address.id, address.email);
    const body = await input(c.req.raw, remediationStepUpdateSchema);
    const findings = await readFindings(c.env, address.id);
    const finding = findings.findings.find((item) => item.id === c.req.param('findingId'));
    if (!finding?.remediationSteps.some((step) => step.id === c.req.param('actionId')))
      throw new APIError('not_found', 404, 'Action not found.');
    const saved =
      await c.env.DB.prepare(`INSERT INTO finding_actions (finding_id, action_id, completed_at)
      SELECT id, ?, ? FROM findings WHERE id = ? AND address_id = ? AND active = 1
      ON CONFLICT(finding_id, action_id) DO UPDATE SET completed_at = CASE WHEN excluded.completed_at IS NULL THEN NULL ELSE COALESCE(finding_actions.completed_at, excluded.completed_at) END RETURNING finding_id`)
        .bind(
          c.req.param('actionId'),
          body.completed ? new Date().toISOString() : null,
          finding.id,
          address.id,
        )
        .first();
    if (!saved) throw new APIError('not_found', 404, 'Finding not found.');
    return c.json(await readFindings(c.env, address.id));
  });
  app.post('/v1/addresses/:id/scan', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id, c.req.param('id'));
    if (address.id !== c.req.param('id'))
      throw new APIError('not_found', 404, 'Address not found.');
    await requireAddressSlot(c.env, session.user_id, address.id, address.email);
    return c.json(await scanAddress(c.env, session.user_id, address));
  });
  app.delete('/v1/me', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM email_verifications WHERE email_index IN (SELECT email_index FROM monitored_emails WHERE user_id = ?) OR user_id = ?',
      ).bind(session.user_id, session.user_id),
      c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(session.user_id),
    ]);
    return c.body(null, 204);
  });
}
