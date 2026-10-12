import {
  accountResponseSchema,
  addressSummarySchema,
  findingsResponseSchema,
  sessionResponseSchema,
} from '@cybrguard/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, type Bindings } from '../src/index';
import { processMonitoring, scheduleMonitoring } from '../src/jobs/monitoring';
import { hasPremium } from '../src/lib/findings';
import { parseXonCount, parseXonDetails, XonProvider } from '../src/providers/xon';
import { testDatabase } from './database';

const device = 'b'.repeat(64);
const email = 'owned@example.com';
let database: ReturnType<typeof testDatabase>;
let env: Bindings;
let deliveredCode = '';
let providerCalls = 0;
let providerBreaches: string[] = [];
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
  providerBreaches = ['FictionalTestBreach', 'FictionalTestBreachTwo'];
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
        breaches:
          new URL(url).searchParams.get('detailed') === 'true'
            ? providerBreaches.map((id, i) => ({
                breach_id: id,
                breached_date: '2020-01-01T00:00:00+00:00',
                domain: null,
                password_risk: i === 0 ? 'plaintext' : 'unknown',
                xposed_data: i === 0 ? 'Email addresses;Passwords' : 'Email addresses',
                xposure_desc: null,
              }))
            : providerBreaches,
      });
    }),
  );
});
afterEach(() => {
  database.raw.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('scheduled monitoring', () => {
  async function setup() {
    const session = await signIn();
    const user = await me(session.accessToken);
    database.raw
      .prepare('INSERT INTO premium_entitlements (user_id, expires_at) VALUES (?, ?)')
      .run(user.userId, Math.floor(clock / 1000) + 10 * 86400);
    const jobs: string[] = [];
    env.MONITORING_QUEUE = {
      send: async (message: { jobId: string }) => {
        jobs.push(message.jobId);
      },
    } as unknown as Queue<{ jobId: string }>;
    const patch = (enabled: boolean) =>
      app.request(
        `/v1/addresses/${user.address.id}/monitoring`,
        {
          ...auth(session.accessToken),
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        },
        env,
      );
    expect((await patch(true)).status).toBe(204);
    return { session, user, jobs, patch };
  }
  it('baselines historical findings, flags only newly observed IDs and deduplicates repeated delivery', async () => {
    const { user, jobs } = await setup();
    await scheduleMonitoring(env);
    await scheduleMonitoring(env);
    expect(jobs).toHaveLength(1);
    const firstJob = jobs[0] as string;
    await processMonitoring(env, firstJob);
    expect(database.raw.prepare('SELECT SUM(is_new) AS count FROM findings').get()?.count).toBe(0);
    await processMonitoring(env, firstJob);
    expect(providerCalls).toBe(1);
    advance(86401);
    providerBreaches.push('FictionalNewBreach');
    await scheduleMonitoring(env);
    await processMonitoring(env, jobs[1] as string);
    expect(database.raw.prepare('SELECT SUM(is_new) AS count FROM findings').get()?.count).toBe(1);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM findings').get()?.count).toBe(3);
    advance(86401);
    await scheduleMonitoring(env);
    await processMonitoring(env, jobs[2] as string);
    expect(database.raw.prepare('SELECT SUM(is_new) AS count FROM findings').get()?.count).toBe(1);
    expect(
      database.raw
        .prepare('SELECT last_monitoring_outcome FROM monitored_emails WHERE id = ?')
        .get(user.address.id)?.last_monitoring_outcome,
    ).toBe('success');
  });
  it('preserves successful results on failure, retries and stops after eight attempts', async () => {
    const { jobs } = await setup();
    await scheduleMonitoring(env);
    await processMonitoring(env, jobs[0] as string);
    advance(86401);
    await scheduleMonitoring(env);
    providerStatus = 503;
    for (let i = 0; i < 7; i++) {
      await expect(processMonitoring(env, jobs[1] as string)).rejects.toBeDefined();
      advance(61);
    }
    await processMonitoring(env, jobs[1] as string);
    expect(
      database.raw
        .prepare('SELECT status, attempts FROM monitoring_jobs WHERE id = ?')
        .get(jobs[1] as string),
    ).toMatchObject({ status: 'failed', attempts: 8 });
    expect(
      database.raw.prepare('SELECT known_breach_count FROM monitored_emails').get()
        ?.known_breach_count,
    ).toBe(2);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM findings').get()?.count).toBe(2);
  });
  it('ignores disabled/deleted addresses and pauses expired entitlements without provider calls', async () => {
    const { user, jobs, patch } = await setup();
    await scheduleMonitoring(env);
    expect((await patch(false)).status).toBe(204);
    await processMonitoring(env, jobs[0] as string);
    expect(providerCalls).toBe(0);
    expect((await patch(true)).status).toBe(204);
    await scheduleMonitoring(env);
    database.raw.prepare('UPDATE premium_entitlements SET expires_at = 0').run();
    await processMonitoring(env, jobs[1] as string);
    expect(providerCalls).toBe(0);
    database.raw.prepare('DELETE FROM users WHERE id = ?').run(user.userId);
    await processMonitoring(env, jobs[1] as string);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM monitoring_jobs').get()?.count).toBe(
      0,
    );
  });
  it('keeps monitoring opt-in, enforces ownership and allows disabling after expiry', async () => {
    const { session, user, patch } = await setup();
    let response = await app.request(
      `/v1/addresses/${user.address.id}/monitoring`,
      auth(session.accessToken),
      env,
    );
    expect(await response.json()).toMatchObject({
      enabled: true,
      cadenceHours: 24,
      pushAvailable: false,
      paused: false,
    });
    const other = await signIn('other@example.com', 'e'.repeat(64));
    expect(
      (
        await app.request(
          `/v1/addresses/${user.address.id}/monitoring`,
          auth(other.accessToken, 'e'.repeat(64)),
          env,
        )
      ).status,
    ).toBe(404);
    database.raw.prepare('UPDATE premium_entitlements SET expires_at = 0').run();
    expect((await patch(false)).status).toBe(204);
    expect((await patch(true)).status).toBe(403);
    response = await app.request(
      `/v1/addresses/${user.address.id}/monitoring`,
      auth(session.accessToken),
      env,
    );
    expect(await response.json()).toMatchObject({
      enabled: false,
      paused: true,
      nextCheckAt: null,
    });
  });
  it('discards in-flight results if monitoring is disabled during the provider request', async () => {
    const { user, jobs } = await setup();
    await scheduleMonitoring(env);
    const original = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementationOnce(async (...args) => {
      database.raw
        .prepare(
          'UPDATE monitored_emails SET monitoring_enabled = 0, monitoring_generation = monitoring_generation + 1 WHERE id = ?',
        )
        .run(user.address.id);
      if (!original) throw new Error('Missing fixture');
      return original(...args);
    });
    await processMonitoring(env, jobs[0] as string);
    expect(
      database.raw.prepare('SELECT known_breach_count FROM monitored_emails').get()
        ?.known_breach_count,
    ).toBe(null);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM findings').get()?.count).toBe(0);
  });
});

describe('session management', () => {
  it('lists active families, revokes other devices, and rejects their access and refresh', async () => {
    const first = await signIn();
    advance(61);
    const second = await signIn(email, 'e'.repeat(64));
    const response = await app.request('/v1/sessions', auth(first.accessToken), env);
    const list = (await response.json()) as { sessions: { id: string; current: boolean }[] };
    expect(list.sessions).toHaveLength(2);
    expect(list.sessions.filter((s) => s.current)).toHaveLength(1);
    expect((await post('/v1/sessions/revoke-others', {}, first.accessToken)).status).toBe(204);
    expect(
      (await app.request('/v1/me', auth(second.accessToken, 'e'.repeat(64)), env)).status,
    ).toBe(401);
    expect(
      (
        await post('/v1/auth/refresh', {
          refreshToken: second.refreshToken,
          deviceId: 'e'.repeat(64),
        })
      ).status,
    ).toBe(401);
    expect((await app.request('/v1/me', auth(first.accessToken), env)).status).toBe(200);
  });
  it('does not allow another account to revoke a session family', async () => {
    const first = await signIn();
    const second = await signIn('other@example.com', 'e'.repeat(64));
    const list = (await (
      await app.request('/v1/sessions', auth(first.accessToken), env)
    ).json()) as { sessions: { id: string }[] };
    const id = list.sessions[0]?.id;
    expect(
      (
        await app.request(
          `/v1/sessions/${id}`,
          { ...auth(second.accessToken, 'e'.repeat(64)), method: 'DELETE' },
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/v1/sessions/${id}`,
          { ...auth(first.accessToken), method: 'DELETE' },
          env,
        )
      ).status,
    ).toBe(204);
    expect((await app.request('/v1/me', auth(first.accessToken), env)).status).toBe(401);
  });
});

describe('additional verified addresses', () => {
  async function premium(quota = 3) {
    const session = await signIn();
    const user = await me(session.accessToken);
    database.raw
      .prepare(
        'INSERT INTO premium_entitlements (user_id, expires_at, max_addresses) VALUES (?, ?, ?)',
      )
      .run(user.userId, Math.floor(clock / 1000) + 86400, quota);
    return { ...session, user };
  }
  async function challenge(token: string, address: string) {
    const response = await post(
      '/v1/addresses/verify/start',
      { email: address, consent: true, deviceId: device },
      token,
    );
    expect(response.status).toBe(202);
    return {
      challengeId: ((await response.json()) as { challengeId: string }).challengeId,
      code: deliveredCode,
      deviceId: device,
    };
  }
  it('requires independent verification, preserves primary login, and supports removal', async () => {
    const session = await premium();
    const proof = await challenge(session.accessToken, 'second@example.com');
    expect(providerCalls).toBe(0);
    expect((await post('/v1/auth/verify', proof)).status).toBe(400);
    const added = await post('/v1/addresses/verify/complete', proof, session.accessToken);
    expect(added.status).toBe(201);
    const address = addressSummarySchema.parse(await added.json());
    expect(address.isPrimary).toBe(false);
    expect((await post('/v1/addresses/verify/complete', proof, session.accessToken)).status).toBe(
      400,
    );
    expect((await me(session.accessToken)).address.id).toBe(session.user.address.id);
    advance(61);
    const login = await start('second@example.com');
    expect(
      (await post('/v1/auth/verify', { challengeId: login, code: deliveredCode, deviceId: device }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/v1/addresses/${address.id}`,
          { ...auth(session.accessToken), method: 'DELETE' },
          env,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(
          `/v1/addresses/${session.user.address.id}`,
          { ...auth(session.accessToken), method: 'DELETE' },
          env,
        )
      ).status,
    ).toBe(400);
  });
  it('enforces quota across concurrent completions and pauses excess on downgrade', async () => {
    const session = await premium(2);
    const first = await challenge(session.accessToken, 'first@example.com');
    const second = await challenge(session.accessToken, 'second@example.com');
    const results = await Promise.all(
      [first, second].map((proof) =>
        post('/v1/addresses/verify/complete', proof, session.accessToken),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    const address = addressSummarySchema.parse(await results.find((r) => r.status === 201)?.json());
    expect(
      (
        await post(
          '/v1/addresses/verify/start',
          { email: 'third@example.com', consent: true, deviceId: device },
          session.accessToken,
        )
      ).status,
    ).toBe(403);
    database.raw.prepare('UPDATE premium_entitlements SET expires_at = 0').run();
    expect((await post(`/v1/addresses/${address.id}/scan`, {}, session.accessToken)).status).toBe(
      403,
    );
    expect((await me(session.accessToken)).quota).toBe(1);
    expect(
      (
        await app.request(
          `/v1/addresses/${address.id}`,
          { ...auth(session.accessToken), method: 'DELETE' },
          env,
        )
      ).status,
    ).toBe(204);
  });
  it('binds challenges to the account, device, consent and expiry', async () => {
    const session = await premium();
    const proof = await challenge(session.accessToken, 'second@example.com');
    const other = await signIn('other@example.com', 'd'.repeat(64));
    expect(
      (await post('/v1/addresses/verify/complete', proof, other.accessToken, 'd'.repeat(64)))
        .status,
    ).toBe(401);
    expect(
      (
        await post(
          '/v1/addresses/verify/start',
          { email: 'no@example.com', consent: false, deviceId: device },
          session.accessToken,
        )
      ).status,
    ).toBe(400);
    advance(601);
    expect((await post('/v1/addresses/verify/complete', proof, session.accessToken)).status).toBe(
      400,
    );
    expect(providerCalls).toBe(0);
  });
  it('rejects another account on the same device without consuming the owner challenge', async () => {
    const session = await premium();
    const proof = await challenge(session.accessToken, 'second@example.com');
    const other = await signIn('other@example.com');
    const otherAccount = await me(other.accessToken);
    database.raw
      .prepare('INSERT INTO premium_entitlements (user_id, expires_at) VALUES (?, ?)')
      .run(otherAccount.userId, Math.floor(clock / 1000) + 86400);
    expect((await post('/v1/addresses/verify/complete', proof, other.accessToken)).status).toBe(
      400,
    );
    expect((await post('/v1/addresses/verify/complete', proof, session.accessToken)).status).toBe(
      201,
    );
  });
  it('shares a five-attempt budget and cannot reclaim an email belonging to another account', async () => {
    const session = await premium();
    const proof = await challenge(session.accessToken, 'second@example.com');
    const wrong = { ...proof, code: proof.code === '000000' ? '111111' : '000000' };
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await post('/v1/addresses/verify/complete', wrong, session.accessToken)).status).toBe(
        400,
      );
    expect((await post('/v1/addresses/verify/complete', proof, session.accessToken)).status).toBe(
      400,
    );
    await signIn('other@example.com');
    advance(61);
    const occupied = await challenge(session.accessToken, 'other@example.com');
    expect(
      (await post('/v1/addresses/verify/complete', occupied, session.accessToken)).status,
    ).toBe(400);
    expect(
      database.raw.prepare('SELECT COUNT(*) AS count FROM monitored_emails').get()?.count,
    ).toBe(2);
  });
  it('cascades pending account-bound challenges when the account is deleted', async () => {
    const session = await premium();
    await challenge(session.accessToken, 'second@example.com');
    expect(
      (await app.request('/v1/me', { ...auth(session.accessToken), method: 'DELETE' }, env)).status,
    ).toBe(204);
    expect(
      database.raw.prepare('SELECT COUNT(*) AS count FROM email_verifications').get()?.count,
    ).toBe(0);
  });
  it('requires premium and authentication before sending additional codes', async () => {
    const session = await signIn();
    const body = { email: 'second@example.com', consent: true, deviceId: device };
    expect((await post('/v1/addresses/verify/start', body)).status).toBe(401);
    expect((await post('/v1/addresses/verify/start', body, session.accessToken)).status).toBe(403);
  });
});

describe('verified paid scan flow (offline fictional provider and email)', () => {
  it('persists individual action progress without claiming remediation, preserves it on rescan, and cascades deletion', async () => {
    const session = await signIn();
    const owner = await me(session.accessToken);
    database.raw
      .prepare('INSERT INTO premium_entitlements (user_id, expires_at) VALUES (?, ?)')
      .run(owner.userId, Math.floor(clock / 1000) + 1000);
    await post(`/v1/addresses/${owner.address.id}/scan`, {}, session.accessToken);
    const list = async () =>
      findingsResponseSchema.parse(
        await (
          await app.request(
            `/v1/addresses/${owner.address.id}/findings`,
            auth(session.accessToken),
            env,
          )
        ).json(),
      );
    const first = (await list()).findings[0];
    if (!first) throw new Error('Expected finding');
    expect(first.remediationSteps.map((step) => step.id)).toContain('change-password');
    const update = (completed: boolean, actionId = 'change-password') =>
      app.request(
        `/v1/addresses/${owner.address.id}/findings/${first.id}/actions/${actionId}`,
        {
          method: 'PATCH',
          headers: { ...auth(session.accessToken).headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ completed }),
        },
        env,
      );
    expect((await update(true)).status).toBe(200);
    const marked = (await list()).findings[0]?.remediationSteps.find(
      (step) => step.id === 'change-password',
    )?.completedAt;
    expect(marked).toBeTruthy();
    expect((await list()).findings[0]?.remediatedAt).toBeNull();
    advance(61);
    await post(`/v1/addresses/${owner.address.id}/scan`, {}, session.accessToken);
    expect((await update(true)).status).toBe(200);
    expect(
      (await list()).findings[0]?.remediationSteps.find((step) => step.id === 'change-password')
        ?.completedAt,
    ).toBe(marked);
    expect((await update(false)).status).toBe(200);
    expect(
      (await list()).findings[0]?.remediationSteps.find((step) => step.id === 'change-password')
        ?.completedAt,
    ).toBeNull();
    expect((await update(true, 'invented-action')).status).toBe(404);
    database.raw.prepare('UPDATE premium_entitlements SET expires_at = 0').run();
    expect((await update(true)).status).toBe(403);
    expect(
      (await app.request('/v1/me', { ...auth(session.accessToken), method: 'DELETE' }, env)).status,
    ).toBe(204);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM finding_actions').get()?.count).toBe(
      0,
    );
  });

  it('limits staging premium overrides to the configured staging testers', async () => {
    const session = await signIn();
    const account = await me(session.accessToken);
    env.STAGING_PREMIUM_EMAILS = email;
    expect(await hasPremium(env, account.userId, email)).toBe(false);
    env.APP_ENV = 'staging';
    expect(await hasPremium(env, account.userId, email)).toBe(true);
    expect(await hasPremium(env, 'another-user', 'another@example.com')).toBe(false);
    env.APP_ENV = 'production';
    expect(await hasPremium(env, account.userId, email)).toBe(false);
  });
  it("prevents a premium user reading or updating another user's findings and cascades account deletion", async () => {
    const session = await signIn();
    const owner = await me(session.accessToken);
    database.raw
      .prepare('INSERT INTO premium_entitlements (user_id, expires_at) VALUES (?, ?)')
      .run(owner.userId, Math.floor(clock / 1000) + 1000);
    expect(
      (await post(`/v1/addresses/${owner.address.id}/scan`, {}, session.accessToken)).status,
    ).toBe(200);
    const finding = database.raw.prepare('SELECT id FROM findings LIMIT 1').get();
    if (!finding) throw new Error('Expected finding');
    const attacker = await signIn('another@example.com', 'e'.repeat(64));
    const other = await me(attacker.accessToken, 'e'.repeat(64));
    database.raw
      .prepare('INSERT INTO premium_entitlements (user_id, expires_at) VALUES (?, ?)')
      .run(other.userId, Math.floor(clock / 1000) + 1000);
    expect(
      (
        await app.request(
          `/v1/addresses/${owner.address.id}/findings`,
          auth(attacker.accessToken, 'e'.repeat(64)),
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/v1/addresses/${other.address.id}/findings/${finding.id}`,
          {
            method: 'PATCH',
            headers: {
              ...auth(attacker.accessToken, 'e'.repeat(64)).headers,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ remediated: true }),
          },
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request('/v1/me', { ...auth(session.accessToken), method: 'DELETE' }, env)).status,
    ).toBe(204);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM findings').get()?.count).toBe(0);
    expect(
      database.raw
        .prepare('SELECT COUNT(*) AS count FROM premium_entitlements WHERE user_id = ?')
        .get(owner.userId)?.count,
    ).toBe(0);
  });

  it('requests details only with premium access, encrypts them, preserves remediation on rescan, and revokes access on expiry', async () => {
    const session = await signIn();
    const account = await me(session.accessToken);
    const address = account.address;
    const scan = () => post(`/v1/addresses/${address.id}/scan`, {}, session.accessToken);
    const list = () =>
      app.request(`/v1/addresses/${address.id}/findings`, auth(session.accessToken), env);
    expect((await scan()).status).toBe(200);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM findings').get()?.count).toBe(0);
    expect((await list()).status).toBe(403);
    database.raw
      .prepare('INSERT INTO premium_entitlements (user_id, expires_at) VALUES (?, ?)')
      .run(account.userId, Math.floor(clock / 1000) + 1000);
    advance(61);
    expect((await scan()).status).toBe(200);
    let result = (await (await list()).json()) as {
      findings: {
        id: string;
        breachId: string;
        passwordRiskHighlighted: boolean;
        remediatedAt: string | null;
      }[];
    };
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.passwordRiskHighlighted).toBe(true);
    expect(result.findings[1]?.passwordRiskHighlighted).toBe(false);
    expect(JSON.stringify(database.raw.prepare('SELECT * FROM findings').all())).not.toContain(
      'FictionalTestBreach',
    );
    const finding = result.findings[0];
    if (!finding) throw new Error('Expected a finding');
    const update = (remediated: boolean, findingId = finding.id, addressId = address.id) =>
      app.request(
        `/v1/addresses/${addressId}/findings/${findingId}`,
        {
          ...auth(session.accessToken),
          method: 'PATCH',
          headers: { ...auth(session.accessToken).headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ remediated }),
        },
        env,
      );
    expect((await update(true)).status).toBe(200);
    advance(61);
    expect((await scan()).status).toBe(200);
    result = (await (await list()).json()) as typeof result;
    expect(result.findings[0]?.id).toBe(finding.id);
    expect(result.findings[0]?.remediatedAt).not.toBeNull();
    expect((await update(false)).status).toBe(200);
    expect((await update(true, crypto.randomUUID())).status).toBe(404);
    expect((await update(true, finding.id, crypto.randomUUID())).status).toBe(404);
    providerStatus = 500;
    advance(61);
    expect((await scan()).status).toBe(503);
    expect(
      database.raw.prepare('SELECT COUNT(*) AS count FROM findings WHERE active = 1').get()?.count,
    ).toBe(2);
    database.raw.prepare('UPDATE premium_entitlements SET expires_at = 0').run();
    expect((await list()).status).toBe(403);
    expect((await update(true)).status).toBe(403);
    expect((await me(session.accessToken)).tier).toBe('free');
  });

  it('requires staging configuration and HTTPS, limits sign-in to testers, and keeps auth enforced', async () => {
    env.APP_ENV = 'staging';
    const origin = 'https://api.cybrguard.app';
    expect((await app.request(`${origin}/v1/health`, {}, env)).status).toBe(503);
    env.STAGING_ALLOWED_EMAILS = email;
    expect((await app.request('http://api.cybrguard.app/v1/health', {}, env)).status).toBe(503);
    expect((await app.request('https://other.example.com/v1/health', {}, env)).status).toBe(503);
    const health = await app.request(`${origin}/v1/health`, {}, env);
    expect(health.status).toBe(200);
    expect(health.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(await health.json()).toMatchObject({ environment: 'staging' });
    const send = (address: string) =>
      app.request(
        `${origin}/v1/auth/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: address, consent: true, deviceId: device }),
        },
        env,
      );
    expect((await send('unapproved@example.com')).status).toBe(403);
    expect(deliveredCode).toBe('');
    expect(
      database.raw.prepare('SELECT COUNT(*) AS count FROM email_verifications').get()?.count,
    ).toBe(0);
    expect((await send(email)).status).toBe(202);
    expect(deliveredCode).toMatch(/^\d{6}$/);
    expect((await app.request(`${origin}/v1/me`, {}, env)).status).toBe(401);
    expect(providerCalls).toBe(0);
  });

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
  it('validates detailed fields and does not interpret missing or unknown risk as safe', () => {
    const breach = {
      breach_id: 'Fictional',
      breached_date: null,
      domain: null,
      xposed_data: null,
      xposure_desc: null,
      password_risk: null,
    };
    for (const risk of [null, 'unknown', 'hardtocrack', 'plaintext', 'easytocrack']) {
      const result = parseXonDetails(
        { status: 'success', email, breaches: [{ ...breach, password_risk: risk }] },
        email,
      );
      expect(result.findings[0]?.passwordRiskHighlighted).toBe(
        risk === 'plaintext' || risk === 'easytocrack',
      );
    }
    expect(() =>
      parseXonDetails({ status: 'success', email, breaches: [{ breach_id: 'Fictional' }] }, email),
    ).toThrow();
    expect(() =>
      parseXonDetails({ status: 'success', email, breaches: [breach, breach] }, email),
    ).toThrow();
    expect(() =>
      parseXonDetails(
        { status: 'success', email: 'different@example.com', breaches: [breach] },
        email,
      ),
    ).toThrow();
  });

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
