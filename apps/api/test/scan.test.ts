import {
  accountResponseSchema,
  addressSummarySchema,
  sessionResponseSchema,
} from '@cybrguard/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, type Bindings } from '../src/index';
import { parseXonCount, XonProvider } from '../src/providers/xon';
import { testDatabase } from './database';

const device = 'b'.repeat(64);
const email = 'owned@example.com';
let database: ReturnType<typeof testDatabase>;
let env: Bindings;
let deliveredCode = '';
let providerCalls = 0;
let providerStatus = 200;
let corruptResponse = false;
let failEmail = false;
let clock = 0;

async function post(path: string, body: unknown, token?: string, deviceId = device) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}`, 'X-Device-ID': deviceId } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}
function auth(token: string, deviceId = device) {
  return { headers: { Authorization: `Bearer ${token}`, 'X-Device-ID': deviceId } };
}
async function start(address = email, deviceId = device) {
  const response = await post('/v1/auth/start', { email: address, consent: true, deviceId });
  expect(response.status).toBe(202);
  return ((await response.json()) as { challengeId: string }).challengeId;
}
async function signIn(address = email, deviceId = device) {
  const challengeId = await start(address, deviceId);
  const response = await post('/v1/auth/verify', { challengeId, code: deliveredCode, deviceId });
  expect(response.status).toBe(200);
  return sessionResponseSchema.parse(await response.json());
}
async function me(token: string, deviceId = device) {
  return accountResponseSchema.parse(
    await (await app.request('/v1/me', auth(token, deviceId), env)).json(),
  );
}
function advance(seconds: number) {
  clock += seconds * 1000;
}

beforeEach(() => {
  database = testDatabase();
  deliveredCode = '';
  providerCalls = 0;
  providerStatus = 200;
  corruptResponse = false;
  failEmail = false;
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  env = {
    DB: database.binding,
    APP_ENV: 'test',
    DATA_MODE: 'live',
    XON_API_KEY: 'fictional-test-key',
    DATA_ENCRYPTION_KEY: 'a'.repeat(64),
    EMAIL_BLIND_INDEX_KEY: 'c'.repeat(64),
    EMAIL_TRANSPORT: 'cloudflare-rest',
    EMAIL_FROM: 'security@cybrguard.app',
    CLOUDFLARE_ACCOUNT_ID: 'd'.repeat(32),
    CLOUDFLARE_EMAIL_API_TOKEN: 'fictional-email-key',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init: RequestInit) => {
      if (String(url).startsWith('https://api.cloudflare.com/client/v4/accounts/')) {
        if (failEmail) return Response.json({ success: false }, { status: 403 });
        const message = JSON.parse(String(init.body));
        deliveredCode = message.text.match(/\b\d{3}-\d{3}\b/)[0].replace('-', '');
        return Response.json({ success: true, result: { delivered: [], queued: [message.to] } });
      }
      expect(String(url)).toMatch(/^https:\/\/plus-api\.xposedornot\.com\/v3\/check-email\//);
      expect(init.redirect).toBe('manual');
      expect(init.headers).toMatchObject({ 'x-api-key': 'fictional-test-key' });
      providerCalls++;
      const requestedEmail = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
      if (providerStatus !== 200)
        return Response.json({ detail: { retry_after: 3.2 } }, { status: providerStatus });
      return Response.json({
        status: 'success',
        email: corruptResponse ? 'different@example.com' : requestedEmail,
        breaches: ['FictionalTestBreach', 'FictionalTestBreachTwo'],
      });
    }),
  );
});
afterEach(() => {
  database.raw.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('verified paid scan flow (offline fictional provider and email)', () => {
  it('accepts XXX-XXX codes and rejects eight-digit or malformed codes', async () => {
    const challengeId = await start();
    for (const code of ['12345678', '12-3456', '123-45']) {
      expect((await post('/v1/auth/verify', { challengeId, code, deviceId: device })).status).toBe(
        400,
      );
    }
    const code = `${deliveredCode.slice(0, 3)}-${deliveredCode.slice(3)}`;
    expect((await post('/v1/auth/verify', { challengeId, code, deviceId: device })).status).toBe(
      200,
    );
    expect(providerCalls).toBe(0);
  });

  it('requires consent and delivery configuration, never leaks a code in a response', async () => {
    expect((await post('/v1/auth/start', { email, deviceId: device, consent: false })).status).toBe(
      400,
    );
    const challenge = await start();
    expect(challenge).toMatch(/^[a-f0-9-]{36}$/);
    const rows = database.raw.prepare('SELECT * FROM email_verifications').all();
    expect(JSON.stringify(rows)).not.toContain(email);
    expect(JSON.stringify(rows)).not.toContain(deliveredCode);
    expect(providerCalls).toBe(0);
  });
  it('does not create an account or usable challenge when email sending fails', async () => {
    failEmail = true;
    const response = await post('/v1/auth/start', { email, consent: true, deviceId: device });
    expect(response.status).toBe(503);
    expect(
      database.raw.prepare('SELECT COUNT(*) as count FROM email_verifications').get()?.count,
    ).toBe(0);
    expect(database.raw.prepare('SELECT COUNT(*) as count FROM users').get()?.count).toBe(0);
    expect(providerCalls).toBe(0);
  });
  it('enforces missing email transport instead of substituting a local verification bypass', async () => {
    env.EMAIL_TRANSPORT = 'disabled';
    expect((await post('/v1/auth/start', { email, consent: true, deviceId: device })).status).toBe(
      503,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses unauthenticated scans and accounts before contacting XON', async () => {
    expect((await app.request('/v1/me', {}, env)).status).toBe(401);
    expect((await post('/v1/addresses/unknown/scan', {})).status).toBe(401);
    expect(providerCalls).toBe(0);
  });
  it('locks a challenge after five guesses, even if a correct code is later submitted', async () => {
    const challengeId = await start();
    const correctCode = deliveredCode;
    const wrongCode = correctCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      expect(
        (await post('/v1/auth/verify', { challengeId, code: wrongCode, deviceId: device })).status,
      ).toBe(400);
    expect(
      (await post('/v1/auth/verify', { challengeId, code: correctCode, deviceId: device })).status,
    ).toBe(400);
    expect(providerCalls).toBe(0);
  });
  it('rejects expired codes, device mismatch and replay', async () => {
    const challengeId = await start();
    const body = { challengeId, code: deliveredCode, deviceId: device };
    expect((await post('/v1/auth/verify', { ...body, deviceId: 'e'.repeat(64) })).status).toBe(400);
    expect((await post('/v1/auth/verify', body)).status).toBe(200);
    expect((await post('/v1/auth/verify', body)).status).toBe(400);
    advance(61);
    const expired = await start();
    advance(601);
    expect(
      (
        await post('/v1/auth/verify', {
          challengeId: expired,
          code: deliveredCode,
          deviceId: device,
        })
      ).status,
    ).toBe(400);
  });
  it('verifies ownership, stores an actual provider count, enforces premium gating and rate limits', async () => {
    const tokens = await signIn();
    const account = await me(tokens.accessToken);
    expect(account.address.knownBreachCount).toBeNull();
    const scan = await post(`/v1/addresses/${account.address.id}/scan`, {}, tokens.accessToken);
    expect(scan.status).toBe(200);
    const summary = addressSummarySchema.parse(await scan.json());
    expect(summary.knownBreachCount).toBe(2);
    expect(providerCalls).toBe(1);
    const details = await app.request(
      `/v1/addresses/${account.address.id}/findings`,
      auth(tokens.accessToken),
      env,
    );
    expect(details.status).toBe(403);
    expect(await details.text()).not.toContain('FictionalTestBreach');
    expect(
      (await post(`/v1/addresses/${account.address.id}/scan`, {}, tokens.accessToken)).status,
    ).toBe(429);
    expect((await me(tokens.accessToken)).address.knownBreachCount).toBe(2);
    expect(
      database.raw.prepare('SELECT encrypted_email FROM monitored_emails').get()?.encrypted_email,
    ).not.toContain(email);
  });
  it('prevents another user or device from reading or scanning an address', async () => {
    const first = await signIn();
    const account = await me(first.accessToken);
    const otherDevice = 'f'.repeat(64);
    const second = await signIn('another@example.com', otherDevice);
    expect(
      (await post(`/v1/addresses/${account.address.id}/scan`, {}, second.accessToken, otherDevice))
        .status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/v1/addresses/${account.address.id}/summary`,
          auth(second.accessToken, otherDevice),
          env,
        )
      ).status,
    ).toBe(404);
    expect((await app.request('/v1/me', auth(first.accessToken, otherDevice), env)).status).toBe(
      401,
    );
    expect(providerCalls).toBe(0);
  });
  it.each([401, 404, 429, 500])(
    'preserves prior counts when XON returns HTTP %i',
    async (status) => {
      const tokens = await signIn();
      const account = await me(tokens.accessToken);
      await post(`/v1/addresses/${account.address.id}/scan`, {}, tokens.accessToken);
      advance(61);
      providerStatus = status;
      const response = await post(
        `/v1/addresses/${account.address.id}/scan`,
        {},
        tokens.accessToken,
      );
      expect(response.status).toBe(status === 429 ? 429 : status === 404 ? 502 : 503);
      if (status === 429) expect(response.headers.get('Retry-After')).toBe('4');
      expect((await me(tokens.accessToken)).address.knownBreachCount).toBe(2);
    },
  );
  it('rejects mismatched provider responses and keeps the prior result', async () => {
    const tokens = await signIn();
    const account = await me(tokens.accessToken);
    corruptResponse = true;
    expect(
      (await post(`/v1/addresses/${account.address.id}/scan`, {}, tokens.accessToken)).status,
    ).toBe(502);
    expect((await me(tokens.accessToken)).address.knownBreachCount).toBeNull();
  });
  it('reuses an existing account after independent verification', async () => {
    const first = await signIn();
    const account = await me(first.accessToken);
    advance(61);
    const second = await signIn();
    expect((await me(second.accessToken)).userId).toBe(account.userId);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM users').get()?.count).toBe(1);
  });
  it('rotates sessions and revokes the family when an old refresh token is replayed', async () => {
    const tokens = await signIn();
    const refreshed = await post('/v1/auth/refresh', {
      refreshToken: tokens.refreshToken,
      deviceId: device,
    });
    expect(refreshed.status).toBe(200);
    const next = sessionResponseSchema.parse(await refreshed.json());
    expect((await app.request('/v1/me', auth(tokens.accessToken), env)).status).toBe(401);
    expect((await app.request('/v1/me', auth(next.accessToken), env)).status).toBe(200);
    expect(
      (await post('/v1/auth/refresh', { refreshToken: tokens.refreshToken, deviceId: device }))
        .status,
    ).toBe(401);
    expect((await app.request('/v1/me', auth(next.accessToken), env)).status).toBe(401);
  });
  it('rejects expired access tokens and permits refresh within the family lifetime', async () => {
    const tokens = await signIn();
    advance(901);
    expect((await app.request('/v1/me', auth(tokens.accessToken), env)).status).toBe(401);
    expect(
      (await post('/v1/auth/refresh', { refreshToken: tokens.refreshToken, deviceId: device }))
        .status,
    ).toBe(200);
  });
  it('revokes a session on logout', async () => {
    const tokens = await signIn();
    expect((await post('/v1/auth/logout', {}, tokens.accessToken)).status).toBe(204);
    expect((await app.request('/v1/me', auth(tokens.accessToken), env)).status).toBe(401);
  });
  it('deletes account data and revokes access and refresh credentials', async () => {
    const tokens = await signIn();
    const account = await me(tokens.accessToken);
    expect(
      (await app.request('/v1/me', { ...auth(tokens.accessToken), method: 'DELETE' }, env)).status,
    ).toBe(204);
    for (const table of ['users', 'monitored_emails', 'sessions', 'email_verifications'])
      expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
    expect((await app.request('/v1/me', auth(tokens.accessToken), env)).status).toBe(401);
    expect(
      (await post(`/v1/addresses/${account.address.id}/scan`, {}, tokens.accessToken)).status,
    ).toBe(401);
    expect(
      (await post('/v1/auth/refresh', { refreshToken: tokens.refreshToken, deviceId: device }))
        .status,
    ).toBe(401);
  });
  it('only consumes a code once under concurrent verification requests', async () => {
    const challengeId = await start();
    const body = { challengeId, code: deliveredCode, deviceId: device };
    const results = await Promise.all([
      post('/v1/auth/verify', body),
      post('/v1/auth/verify', body),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM users').get()?.count).toBe(1);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(1);
  });
  it('allows only one concurrent provider request for an address', async () => {
    const session = await signIn();
    const address = (await me(session.accessToken)).address;
    const path = `/v1/addresses/${address.id}/scan`;
    const results = await Promise.all([
      post(path, {}, session.accessToken),
      post(path, {}, session.accessToken),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 429]);
    expect(providerCalls).toBe(1);
  });
  it('does not recreate an account deleted during an in-flight provider request', async () => {
    const session = await signIn();
    const address = (await me(session.accessToken)).address;
    let release: (response: Response) => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(fetch).mockImplementationOnce(async () => {
      entered();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const pending = post(`/v1/addresses/${address.id}/scan`, {}, session.accessToken);
    await started;
    expect(
      (await app.request('/v1/me', { ...auth(session.accessToken), method: 'DELETE' }, env)).status,
    ).toBe(204);
    release(Response.json({ status: 'success', email, breaches: ['FictionalBreach'] }));
    expect((await pending).status).toBe(401);
    expect(
      database.raw.prepare('SELECT COUNT(*) AS count FROM monitored_emails').get()?.count,
    ).toBe(0);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM users').get()?.count).toBe(0);
  });
  it('blocks live configuration in production and rejects oversized requests', async () => {
    env.APP_ENV = 'production';
    expect((await app.request('/v1/health', {}, env)).status).toBe(503);
    env.APP_ENV = 'test';
    expect(
      (await post('/v1/auth/start', { email: 'x'.repeat(5000), consent: true, deviceId: device }))
        .status,
    ).toBe(400);
    expect(providerCalls).toBe(0);
  });
  it('throttles sending to the same mailbox and does not contact XON', async () => {
    await start();
    const response = await post('/v1/auth/start', { email, consent: true, deviceId: device });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(providerCalls).toBe(0);
  });
});

describe('XON defensive parsing', () => {
  it('invokes fetch without binding the provider as its receiver', async () => {
    const fetcher = async function (this: unknown) {
      expect(this).toBeUndefined();
      return Response.json({ status: 'success', email, breaches: [] });
    } as typeof fetch;
    await expect(
      new XonProvider('fictional-key', fetcher).checkVerifiedEmail(email),
    ).resolves.toMatchObject({ knownBreachCount: 0 });
  });

  it('accepts an actual empty success without treating errors as empty results', () => {
    expect(parseXonCount({ status: 'success', email, breaches: [] }, email).knownBreachCount).toBe(
      0,
    );
    for (const breaches of [null, ['duplicate', 'duplicate'], [{}], ['']])
      expect(() => parseXonCount({ status: 'success', email, breaches }, email)).toThrow();
    expect(() => parseXonCount({ status: 'error', email, breaches: [] }, email)).toThrow();
  });
  it('refuses redirects, non-JSON, malformed JSON, and transport failures', async () => {
    for (const response of [
      new Response(null, { status: 302 }),
      new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      const fetcher = vi.fn().mockResolvedValue(response);
      await expect(
        new XonProvider('fictional-key', fetcher).checkVerifiedEmail(email),
      ).rejects.toMatchObject({ code: 'provider_bad_response' });
    }
    await expect(
      new XonProvider(
        'fictional-key',
        vi.fn().mockRejectedValue(new Error('secret URL')),
      ).checkVerifiedEmail(email),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});
