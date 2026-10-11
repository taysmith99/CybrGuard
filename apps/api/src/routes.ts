import {
  accountResponseSchema,
  addressSummarySchema,
  authRefreshSchema,
  authStartSchema,
  authVerifySchema,
  deviceCredentialSchema,
  sessionResponseSchema,
  verificationResponseSchema,
} from '@cybrguard/contracts';
import type { z } from 'zod';
import type { app as application, Bindings } from './index';
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
import { XonProvider } from './providers/xon';

type App = typeof application;
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function input<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  // Bounded body reading also handles requests without a Content-Length header.
  const reader = request.body?.getReader();
  if (!reader) throw new APIError('invalid_request', 400, 'A JSON request is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 4096) {
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

async function account(env: Bindings, userId: string) {
  const row = await env.DB.prepare(
    'SELECT id, encrypted_email, known_breach_count, checked_at FROM monitored_emails WHERE user_id = ?',
  )
    .bind(userId)
    .first<{
      id: string;
      encrypted_email: string;
      known_breach_count: number | null;
      checked_at: string | null;
    }>();
  if (!row) throw new APIError('unauthorised', 401, 'This account is no longer available.');
  return {
    id: row.id,
    email: await decrypt(env.DATA_ENCRYPTION_KEY as string, row.encrypted_email),
    verified: true,
    knownBreachCount: row.known_breach_count,
    checkedAt: row.checked_at,
  };
}

export function registerRoutes(app: App) {
  app.post('/v1/auth/start', async (c) => {
    requireLive(c.env);
    requireEmailConfiguration(c.env);
    const body = await input(c.req.raw, authStartSchema);
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
      `UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ? AND device_hash = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < 5 RETURNING *`,
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
        `INSERT INTO monitored_emails (id, user_id, encrypted_email, email_index, verified_at, consent_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) ON CONFLICT(email_index) DO UPDATE SET consent_at = excluded.consent_at`,
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
        'INSERT INTO sessions (id, user_id, family_id, access_hash, refresh_hash, device_hash, access_expires_at, refresh_expires_at) SELECT ?, user_id, ?, ?, ?, ?, ?, ? FROM monitored_emails WHERE email_index = ?',
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
  app.get('/v1/me', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    return c.json(
      accountResponseSchema.parse({
        userId: session.user_id,
        tier: 'free',
        quota: 1,
        address: await account(c.env, session.user_id),
      }),
    );
  });
  app.get('/v1/addresses', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    return c.json({ addresses: [await account(c.env, session.user_id)] });
  });
  app.get('/v1/addresses/:id/summary', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id);
    if (address.id !== c.req.param('id'))
      throw new APIError('not_found', 404, 'Address not found.');
    return c.json(addressSummarySchema.parse(address));
  });
  app.get('/v1/addresses/:id/findings', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    if ((await account(c.env, session.user_id)).id !== c.req.param('id'))
      throw new APIError('not_found', 404, 'Address not found.');
    throw new APIError(
      'subscription_required',
      403,
      'Breach details require a server-confirmed subscription. Billing is not connected yet.',
    );
  });
  app.post('/v1/addresses/:id/scan', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await account(c.env, session.user_id);
    if (address.id !== c.req.param('id'))
      throw new APIError('not_found', 404, 'Address not found.');
    const now = nowSeconds();
    const locked = await c.env.DB.prepare(
      'UPDATE monitored_emails SET scan_lease_until = ?, last_scan_attempt = ? WHERE id = ? AND user_id = ? AND scan_lease_until <= ? AND last_scan_attempt <= ? RETURNING id',
    )
      .bind(now + 45, now, address.id, session.user_id, now, now - 60)
      .first();
    if (!locked)
      throw new APIError(
        'rate_limited',
        429,
        'A scan is in progress or was just requested. Wait a minute before trying again.',
        60,
      );
    try {
      const slot = await c.env.DB.prepare(
        'UPDATE rate_limits SET window_start = ? WHERE key = ? AND window_start <= ? RETURNING key',
      )
        .bind(Date.now() + 1500, 'xon-global', Date.now())
        .first();
      if (!slot)
        throw new APIError('rate_limited', 429, 'Another scan is running. Try again shortly.', 2);
      const result = await new XonProvider(c.env.XON_API_KEY as string).checkVerifiedEmail(
        address.email,
      );
      const saved = await c.env.DB.prepare(
        'UPDATE monitored_emails SET known_breach_count = ?, checked_at = ? WHERE id = ? AND user_id = ? RETURNING id',
      )
        .bind(result.knownBreachCount, result.checkedAt, address.id, session.user_id)
        .first();
      if (!saved) throw new APIError('unauthorised', 401, 'This account is no longer available.');
      return c.json(addressSummarySchema.parse({ ...address, ...result }));
    } catch (error) {
      if (error instanceof APIError && error.code === 'provider_rate_limited')
        await c.env.DB.prepare(
          'UPDATE rate_limits SET window_start = MAX(window_start, ?) WHERE key = ?',
        )
          .bind(Date.now() + (error.retryAfter ?? 60) * 1000, 'xon-global')
          .run();
      throw error;
    } finally {
      await c.env.DB.prepare('UPDATE monitored_emails SET scan_lease_until = 0 WHERE id = ?')
        .bind(address.id)
        .run();
    }
  });
  app.delete('/v1/me', async (c) => {
    const session = await authenticate(c.req.raw, c.env);
    const address = await c.env.DB.prepare(
      'SELECT email_index FROM monitored_emails WHERE user_id = ?',
    )
      .bind(session.user_id)
      .first<{ email_index: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM email_verifications WHERE email_index = ?').bind(
        address?.email_index ?? '',
      ),
      c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(session.user_id),
    ]);
    return c.body(null, 204);
  });
}
