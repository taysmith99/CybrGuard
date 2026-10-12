import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app, type Bindings } from '../src/index';
import { reconcileBilling, resolveBilling, resolveV2Billing } from '../src/lib/billing';
import { addressQuota, requireAddressSlot, requirePremium } from '../src/lib/findings';
import { hash } from '../src/lib/security';
import { testDatabase } from './database';

let db: ReturnType<typeof testDatabase>;
let env: Bindings;
let payload: unknown;
let calls: number;
const user = '86c199c2-82a3-4683-9514-c3c75c365651';
const now = 1791800000;
const future = (offset: number) => new Date((now + offset) * 1000).toISOString();
const snapshot = (entitlements: Record<string, unknown>) => ({ subscriber: { entitlements } });
beforeEach(() => {
  db = testDatabase();
  db.raw.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run(user, now);
  env = {
    DB: db.binding,
    APP_ENV: 'test',
    DATA_MODE: 'live',
    XON_API_KEY: 'fictional',
    DATA_ENCRYPTION_KEY: 'a'.repeat(64),
    EMAIL_BLIND_INDEX_KEY: 'b'.repeat(64),
    REVENUECAT_SECRET_KEY: 'fictional-secret',
    REVENUECAT_WEBHOOK_AUTH: 'Bearer fictional-webhook-credential-long-enough',
    REVENUECAT_APP_ID: 'fictional-app',
  };
  calls = 0;
  payload = snapshot({ monitoring_personal: { expires_date: future(30 * 86400) } });
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, options: RequestInit) => {
      calls++;
      expect(String(url)).toBe(`https://api.revenuecat.com/v1/subscribers/${user}`);
      expect(options.redirect).toBe('manual');
      expect(options.headers).toMatchObject({ Authorization: 'Bearer fictional-secret' });
      return Response.json(payload);
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.raw.close();
});

it('resolves family priority, grace periods, expiry and cancellation without event-derived grants', () => {
  expect(
    resolveBilling(
      snapshot({
        monitoring_family: { expires_date: future(100) },
        monitoring_personal: { expires_date: future(200) },
      }),
      now,
    ),
  ).toEqual({ plan: 'family', quota: 15, expiresAt: now + 100 });
  expect(
    resolveBilling(
      snapshot({
        monitoring_personal: { expires_date: future(-1), grace_period_expires_date: future(100) },
      }),
      now,
    ).plan,
  ).toBe('personal');
  expect(
    resolveBilling(snapshot({ monitoring_personal: { expires_date: future(-1) } }), now).plan,
  ).toBe('free');
  expect(resolveBilling(snapshot({ monitoring_personal: { expires_date: null } }), now).plan).toBe(
    'free',
  );
  expect(() =>
    resolveBilling(snapshot({ monitoring_personal: { expires_date: 'invalid' } }), now),
  ).toThrow();
  expect(() => resolveBilling({ subscriber: {} }, now)).toThrow();
});
it('caps access freshness, reconciles family downgrade and removes refund access', async () => {
  await reconcileBilling(env, user);
  expect(
    db.raw.prepare('SELECT expires_at, max_addresses FROM premium_entitlements').get(),
  ).toMatchObject({ expires_at: now + 86400, max_addresses: 3 });
  payload = snapshot({ monitoring_family: { expires_date: future(86400) } });
  await reconcileBilling(env, user);
  expect(
    db.raw.prepare('SELECT max_addresses FROM premium_entitlements').get()?.max_addresses,
  ).toBe(15);
  payload = snapshot({ monitoring_personal: { expires_date: future(86400) } });
  await reconcileBilling(env, user);
  expect(
    db.raw.prepare('SELECT max_addresses FROM premium_entitlements').get()?.max_addresses,
  ).toBe(3);
  payload = snapshot({});
  await reconcileBilling(env, user);
  expect(
    db.raw.prepare('SELECT expires_at, max_addresses FROM premium_entitlements').get(),
  ).toMatchObject({ expires_at: 0, max_addresses: 1 });
});
it('preserves the confirmed snapshot when upstream lookup fails or returns malformed data', async () => {
  await reconcileBilling(env, user);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 503 }));
  await expect(reconcileBilling(env, user)).rejects.toThrow();
  payload = { subscriber: {} };
  await expect(reconcileBilling(env, user)).rejects.toThrow();
  expect(db.raw.prepare('SELECT expires_at FROM premium_entitlements').get()?.expires_at).toBe(
    now + 86400,
  );
  expect(db.raw.prepare('SELECT lease_until FROM billing_state').get()?.lease_until).toBe(now);
});
it('does not recreate entitlements after account deletion during lookup', async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => {
    db.raw.prepare('DELETE FROM users WHERE id = ?').run(user);
    return Response.json(payload);
  });
  await expect(reconcileBilling(env, user)).rejects.toThrow();
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM premium_entitlements').get()?.count).toBe(0);
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM billing_state').get()?.count).toBe(0);
});
async function webhook(id: string, extra = {}, credential = env.REVENUECAT_WEBHOOK_AUTH) {
  return app.request(
    '/v1/billing/revenuecat/webhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: credential ?? '' },
      body: JSON.stringify({
        event: {
          id,
          type: 'RENEWAL',
          app_id: 'fictional-app',
          environment: 'SANDBOX',
          app_user_id: user,
          ...extra,
        },
      }),
    },
    env,
  );
}
it('authenticates and scopes webhooks, deduplicates IDs and reconciles delayed events against current state', async () => {
  expect((await webhook('event-1', {}, 'wrong')).status).toBe(401);
  expect((await webhook('event-1', { app_id: 'different' })).status).toBe(403);
  expect((await webhook('event-1', { environment: 'PRODUCTION' })).status).toBe(403);
  expect(calls).toBe(0);
  expect((await webhook('event-1')).status).toBe(200);
  expect((await webhook('event-1')).status).toBe(200);
  expect(calls).toBe(1);
  payload = snapshot({});
  expect(
    (
      await webhook('event-2', {
        type: 'INITIAL_PURCHASE',
        expiration_at_ms: (now + 9999999) * 1000,
      })
    ).status,
  ).toBe(200);
  expect(db.raw.prepare('SELECT expires_at FROM premium_entitlements').get()?.expires_at).toBe(0);
});
it('does not acknowledge failed reconciliation and processes a provider retry', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 503 }));
  expect((await webhook('retry')).status).toBe(503);
  expect(
    db.raw.prepare('SELECT COUNT(*) AS count FROM processed_billing_events').get()?.count,
  ).toBe(0);
  expect((await webhook('retry')).status).toBe(200);
  expect(
    db.raw.prepare('SELECT COUNT(*) AS count FROM processed_billing_events').get()?.count,
  ).toBe(1);
});

it('serialises concurrent reconciliation and applies downgrade quotas without removing addresses', async () => {
  const addresses = Array.from({ length: 4 }, () => crypto.randomUUID());
  for (const [i, id] of addresses.entries()) {
    db.raw
      .prepare(`INSERT INTO monitored_emails (id, user_id, encrypted_email, email_index, verified_at, consent_at, is_primary)
    VALUES (?, ?, 'offline-ciphertext', ?, ?, 1, ?)`)
      .run(id, user, `offline-index-${i}`, i + 1, i === 0 ? 1 : 0);
  }
  payload = snapshot({ monitoring_family: { expires_date: future(86400) } });
  const results = await Promise.allSettled([
    reconcileBilling(env, user),
    reconcileBilling(env, user),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(calls).toBe(1);
  await expect(requireAddressSlot(env, user, addresses[3] as string, '')).resolves.toBeUndefined();
  payload = snapshot({ monitoring_personal: { expires_date: future(86400) } });
  await reconcileBilling(env, user);
  await expect(requireAddressSlot(env, user, addresses[3] as string, '')).rejects.toThrow();
  await expect(requireAddressSlot(env, user, addresses[0] as string, '')).resolves.toBeUndefined();
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM monitored_emails').get()?.count).toBe(4);
});
it('reconciles v2 renewal and expiry webhooks, fails closed at expiry and retains extra addresses', async () => {
  env.REVENUECAT_PROJECT_ID = 'fictional-project';
  env.REVENUECAT_PRO_ENTITLEMENT_ID = 'fictional-pro';
  const addresses = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const [i, id] of addresses.entries()) {
    db.raw
      .prepare(`INSERT INTO monitored_emails (id, user_id, encrypted_email, email_index, verified_at, consent_at, is_primary)
      VALUES (?, ?, 'offline-ciphertext', ?, ?, 1, ?)`)
      .run(id, user, `offline-v2-${i}`, i + 1, i === 0 ? 1 : 0);
  }
  payload = { items: [{ entitlement_id: 'fictional-pro', expires_at: (now + 300) * 1000 }] };
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    calls++;
    expect(String(url)).toBe(
      `https://api.revenuecat.com/v2/projects/fictional-project/customers/${user}/active_entitlements`,
    );
    expect(options?.redirect).toBe('manual');
    return Response.json(payload);
  });
  expect((await webhook('v2-initial', { type: 'INITIAL_PURCHASE' })).status).toBe(200);
  expect(await addressQuota(env, user, '')).toBe(3);
  await expect(requireAddressSlot(env, user, addresses[2] as string, '')).resolves.toBeUndefined();

  vi.mocked(Date.now).mockReturnValue((now + 301) * 1000);
  payload = { items: [{ entitlement_id: 'fictional-pro', expires_at: (now + 600) * 1000 }] };
  expect((await webhook('v2-renewal', { type: 'RENEWAL' })).status).toBe(200);
  expect(db.raw.prepare('SELECT entitlement_expires_at FROM billing_state').get()).toMatchObject({
    entitlement_expires_at: now + 600,
  });
  await expect(requirePremium(env, user, '')).resolves.toBeUndefined();

  // Access expires even if the expiration webhook is delayed or absent.
  vi.mocked(Date.now).mockReturnValue((now + 601) * 1000);
  await expect(requirePremium(env, user, '')).rejects.toThrow();
  expect(await addressQuota(env, user, '')).toBe(1);
  await expect(requireAddressSlot(env, user, addresses[0] as string, '')).resolves.toBeUndefined();
  await expect(requireAddressSlot(env, user, addresses[2] as string, '')).rejects.toThrow();

  payload = { items: [] };
  expect((await webhook('v2-expiration', { type: 'EXPIRATION' })).status).toBe(200);
  expect(
    db.raw.prepare('SELECT plan, entitlement_expires_at FROM billing_state').get(),
  ).toMatchObject({ plan: 'free', entitlement_expires_at: null });
  expect(
    db.raw.prepare('SELECT expires_at, max_addresses FROM premium_entitlements').get(),
  ).toMatchObject({ expires_at: 0, max_addresses: 1 });
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM monitored_emails').get()?.count).toBe(3);
  expect((await webhook('v2-expiration', { type: 'EXPIRATION' })).status).toBe(200);
  expect(calls).toBe(3);
});
it('reconciles both sides of a transfer rather than trusting claimed entitlements', async () => {
  const other = crypto.randomUUID();
  db.raw.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run(other, now);
  vi.mocked(fetch).mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith(other)
        ? snapshot({ monitoring_family: { expires_date: future(86400) } })
        : snapshot({}),
    ),
  );
  expect(
    (
      await webhook('transfer', {
        type: 'TRANSFER',
        app_user_id: undefined,
        transferred_from: [user],
        transferred_to: [other],
      })
    ).status,
  ).toBe(200);
  expect(
    db.raw.prepare('SELECT expires_at FROM premium_entitlements WHERE user_id = ?').get(user)
      ?.expires_at,
  ).toBe(0);
  expect(
    db.raw.prepare('SELECT max_addresses FROM premium_entitlements WHERE user_id = ?').get(other)
      ?.max_addresses,
  ).toBe(15);
});

it('reconciles only the authenticated account even if a client sends another user or premium flag', async () => {
  const access = 'a'.repeat(64),
    refresh = 'b'.repeat(64),
    device = 'c'.repeat(64);
  db.raw
    .prepare(`INSERT INTO sessions (id, user_id, family_id, access_hash, refresh_hash, device_hash, access_expires_at, refresh_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      crypto.randomUUID(),
      user,
      crypto.randomUUID(),
      await hash(access),
      await hash(refresh),
      await hash(device),
      now + 900,
      now + 86400,
    );
  const response = await app.request(
    '/v1/billing/reconcile',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'X-Device-ID': device,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: crypto.randomUUID(), premium: true }),
    },
    env,
  );
  expect(response.status).toBe(204);
  expect(calls).toBe(1);
  expect(db.raw.prepare('SELECT user_id FROM premium_entitlements').get()?.user_id).toBe(user);
  delete env.REVENUECAT_SECRET_KEY;
  expect(
    (
      await app.request(
        '/v1/billing',
        { headers: { Authorization: `Bearer ${access}`, 'X-Device-ID': device } },
        env,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        '/v1/billing/reconcile',
        { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'X-Device-ID': device } },
        env,
      )
    ).status,
  ).toBe(503);
});

it('maps the configured cybrguard_pro entitlement for weekly, monthly and yearly products', async () => {
  for (const product_identifier of ['weekly', 'monthly', 'yearly']) {
    payload = snapshot({ cybrguard_pro: { expires_date: future(86400), product_identifier } });
    expect(resolveBilling(payload, now)).toEqual({
      plan: 'personal',
      quota: 3,
      expiresAt: now + 86400,
    });
    await reconcileBilling(env, user);
    expect(
      db.raw.prepare('SELECT max_addresses FROM premium_entitlements').get()?.max_addresses,
    ).toBe(3);
  }
});

it('verifies modern v2 active entitlements with trusted project and Pro entitlement IDs', async () => {
  env.REVENUECAT_PROJECT_ID = 'project-test';
  env.REVENUECAT_PRO_ENTITLEMENT_ID = 'entitlement-pro';
  vi.mocked(fetch).mockImplementation(async (url) => {
    expect(String(url)).toBe(
      `https://api.revenuecat.com/v2/projects/project-test/customers/${user}/active_entitlements`,
    );
    return Response.json({
      items: [{ entitlement_id: 'entitlement-pro', expires_at: (now + 300) * 1000 }],
      next_page: null,
    });
  });
  await reconcileBilling(env, user);
  expect(
    db.raw.prepare('SELECT expires_at, max_addresses FROM premium_entitlements').get(),
  ).toMatchObject({ expires_at: now + 300, max_addresses: 3 });
  expect(
    resolveV2Billing(
      { items: [{ entitlement_id: 'unrelated', expires_at: (now + 300) * 1000 }] },
      'entitlement-pro',
      now,
    ).plan,
  ).toBe('free');
  expect(
    resolveV2Billing(
      { items: [{ entitlement_id: 'entitlement-pro', expires_at: now * 1000 }] },
      'entitlement-pro',
      now,
    ).plan,
  ).toBe('free');
  expect(() =>
    resolveV2Billing({ items: [], next_page: '/another-page' }, 'entitlement-pro', now),
  ).toThrow();
});
