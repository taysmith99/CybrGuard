import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatResult, runSmokeTests } from '../lib/xon-test-client.mjs';

const key = 'offline-fixture-secret';
const breachId = 'FictionalFixture';
const detail = {
  breach_id: breachId,
  breached_date: '2019-01-01T00:00:00+00:00',
  logo: 'https://example.com/fictional.png',
  password_risk: 'plaintext',
  searchable: 'Yes',
  xposed_data: 'Email addresses;Passwords',
  xposed_records: 42,
  xposure_desc: 'Fictional test data.',
  domain: null,
};

function fixture(index, url) {
  const email = decodeURIComponent(url.pathname.split('/').at(-1));
  if (index < 3) {
    return {
      status: 200,
      body: {
        status: 'success',
        email,
        breaches: index === 0 ? [breachId] : index === 1 ? [{ ...detail }] : [],
      },
    };
  }
  if (index === 4) {
    return {
      status: 422,
      body: {
        detail: [{ loc: ['header', 'x-api-key'], msg: 'Field required', type: 'missing' }],
      },
    };
  }
  return {
    status: index === 3 ? 404 : 401,
    body: { detail: { status: 'error', message: 'Fictional validation error.' } },
  };
}

function harness(change = () => {}) {
  let index = 0;
  const fetchImpl = vi.fn(async (url, options) => {
    const current = index++;
    const response = fixture(current, url);
    change(response, current, url, options);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });
  const sleepImpl = vi.fn(async () => {});
  const onResult = vi.fn();
  return { fetchImpl, sleepImpl, onResult };
}

afterEach(() => vi.useRealTimers());

describe('XON smoke tests (offline fixtures only)', () => {
  it('runs only six sequential restricted requests, with consistent simple and detailed results', async () => {
    const dependencies = harness();
    const summary = await runSmokeTests(key, dependencies);
    expect(summary).toMatchObject({ passed: 6, failed: 0, stopped: false });
    expect(dependencies.fetchImpl).toHaveBeenCalledTimes(6);
    expect(dependencies.sleepImpl.mock.calls).toEqual(Array.from({ length: 5 }, () => [1_500]));
    const calls = dependencies.fetchImpl.mock.calls;
    for (const [index, [url, options]] of calls.entries()) {
      expect(url.origin).toBe('https://plus-api.xposedornot.com');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(url.searchParams.get('detailed')).toBe(index === 1 ? 'true' : 'false');
      expect(options).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store' });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const email = decodeURIComponent(url.pathname.split('/').at(-1));
      if (index === 2) {
        expect(email).toMatch(/^[0-9a-f-]{36}@example\.com$/);
      } else {
        expect(email).toBe(index === 3 ? 'invalid-email' : 'test@example.com');
      }
      expect(url.pathname).toBe(`/v3/check-email/${encodeURIComponent(email)}`);
      if (index === 4) expect(options.headers).not.toHaveProperty('x-api-key');
      else if (index === 5) expect(options.headers['x-api-key']).not.toBe(key);
      else expect(options.headers['x-api-key']).toBe(key);
      if (index > 0) {
        expect(dependencies.onResult.mock.invocationCallOrder[index - 1]).toBeLessThan(
          dependencies.sleepImpl.mock.invocationCallOrder[index - 1],
        );
        expect(dependencies.sleepImpl.mock.invocationCallOrder[index - 1]).toBeLessThan(
          dependencies.fetchImpl.mock.invocationCallOrder[index],
        );
      }
    }
  });

  it('accepts documented nullable metadata', async () => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index === 1) {
          response.body.breaches = [
            Object.fromEntries(
              Object.keys(detail).map((field) => [field, field === 'breach_id' ? breachId : null]),
            ),
          ];
        }
      }),
    );
    expect(summary.failed).toBe(0);
  });

  it.each([
    ['missing field', (value) => delete value.logo],
    ['empty ID', (value) => (value.breach_id = '')],
    ['numeric risk', (value) => (value.password_risk = 1)],
    ['array data classes', (value) => (value.xposed_data = ['Email addresses'])],
    ['fractional count', (value) => (value.xposed_records = 1.5)],
    ['negative count', (value) => (value.xposed_records = -1)],
    ['nonexistent date', (value) => (value.breached_date = '2026-02-30T00:00:00Z')],
    ['unqualified date', (value) => (value.breached_date = '2026-10-11')],
  ])('rejects detailed %s', async (_label, alter) => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index === 1) alter(response.body.breaches[0]);
      }),
    );
    expect(summary.results[1].pass).toBe(false);
  });

  it('permits additional metadata while requiring all documented fields', async () => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index === 1) response.body.breaches[0].future_field = 'Fictional future metadata';
      }),
    );
    expect(summary.failed).toBe(0);
  });

  it.each(['2024-02-29T23:59:59Z', '2026-10-11T12:10:00.123456+11:00'])(
    'accepts timezone-qualified ISO date %s',
    async (date) => {
      const summary = await runSmokeTests(
        key,
        harness((response, index) => {
          if (index === 1) response.body.breaches[0].breached_date = date;
        }),
      );
      expect(summary.results[1].pass).toBe(true);
    },
  );

  it.each([
    ['mismatched email', (body) => (body.email = 'different@example.com')],
    ['wrong success status', (body) => (body.status = 'error')],
    ['missing breach array', (body) => delete body.breaches],
    ['duplicate IDs', (body) => body.breaches.push(breachId)],
    ['non-string ID', (body) => (body.breaches = [42])],
  ])('rejects simple %s', async (_label, alter) => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index === 0) alter(response.body);
      }),
    );
    expect(summary.results[0].pass).toBe(false);
    expect(summary.results[1].pass).toBe(false);
  });

  it('rejects different IDs even when simple and detailed counts match', async () => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index === 1) response.body.breaches[0].breach_id = 'OtherFixture';
      }),
    );
    expect(summary.results[1]).toMatchObject({ pass: false });
  });

  it('rejects duplicate detailed IDs', async () => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index === 1) response.body.breaches.push({ ...detail });
      }),
    );
    expect(summary.results[1]).toMatchObject({
      pass: false,
      reason: 'Duplicate breach identifiers.',
    });
  });

  it('does not interpret 404 as zero breaches', async () => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index === 2) response.status = 404;
      }),
    );
    expect(summary.results[2]).toMatchObject({ pass: false, status: 404 });
  });

  it('fails the empty scenario if the random reserved address has findings', async () => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index === 2) response.body.breaches = [breachId];
      }),
    );
    expect(summary.results[2].pass).toBe(false);
  });

  it.each([401, 403])(
    'reports unexpected HTTP %i as failure, never an empty result',
    async (status) => {
      const summary = await runSmokeTests(
        key,
        harness((response, index) => {
          if (index === 0) response.status = status;
        }),
      );
      expect(summary.results[0]).toMatchObject({ status, pass: false });
    },
  );

  it.each([429, 500, 503, 302, 307])(
    'stops immediately on HTTP %i without retrying',
    async (status) => {
      const dependencies = harness((response) => {
        response.status = status;
        response.body = { detail: { status: 'error', message: key, retry_after: 42.317 } };
      });
      const summary = await runSmokeTests(key, dependencies);
      expect(summary).toMatchObject({ passed: 0, failed: 1, stopped: true });
      expect(summary.results[0].status).toBe(status);
      expect(dependencies.fetchImpl).toHaveBeenCalledTimes(1);
      expect(dependencies.sleepImpl).not.toHaveBeenCalled();
    },
  );

  it('also refuses a response that claims it already followed a redirect', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, redirected: true }));
    const summary = await runSmokeTests(key, { fetchImpl });
    expect(summary.results[0]).toMatchObject({ pass: false, reason: 'Redirect refused.' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('suppresses provider error content and discards breach data from its report', async () => {
    const dependencies = harness((response, index) => {
      if (index === 3 || index === 5) response.body.detail.message = key;
    });
    const summary = await runSmokeTests(key, dependencies);
    const report = JSON.stringify(summary) + summary.results.map(formatResult).join('\n');
    expect(report).not.toContain(key);
    expect(report).not.toContain(breachId);
    expect(report).not.toContain('example.com');
    expect(report).not.toContain('Fictional test data');
  });

  it('rejects malformed error envelopes without printing their content', async () => {
    const summary = await runSmokeTests(
      key,
      harness((response, index) => {
        if (index >= 3) response.body = { detail: key };
      }),
    );
    expect(summary.failed).toBe(3);
    expect(JSON.stringify(summary)).not.toContain(key);
  });

  it('rejects malformed JSON without leaking the response', async () => {
    const dependencies = harness();
    dependencies.fetchImpl.mockImplementationOnce(
      async () => new Response(key, { headers: { 'content-type': 'application/json' } }),
    );
    const summary = await runSmokeTests(key, dependencies);
    expect(summary.results[0]).toMatchObject({
      pass: false,
      reason: 'Response is not valid JSON.',
    });
    expect(JSON.stringify(summary)).not.toContain(key);
  });

  it('rejects a non-JSON content type even when the response contains JSON', async () => {
    const dependencies = harness();
    dependencies.fetchImpl.mockImplementationOnce(
      async () => new Response(JSON.stringify({ key })),
    );
    const summary = await runSmokeTests(key, dependencies);
    expect(summary.results[0]).toMatchObject({
      pass: false,
      reason: 'Response content type is not JSON.',
    });
    expect(JSON.stringify(summary)).not.toContain(key);
  });

  it.each(['fetch', 'body'])(
    'stops on %s network failure without leaking exception details',
    async (stage) => {
      const fetchImpl = vi.fn(async () => {
        if (stage === 'fetch') throw new Error(`${key} https://example.com/private`);
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => {
            throw new Error(key);
          },
        };
      });
      const summary = await runSmokeTests(key, { fetchImpl });
      expect(summary.results[0]).toMatchObject({ pass: false, reason: 'Network request failed.' });
      expect(summary.stopped).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(summary)).not.toContain(key);
    },
  );

  it('aborts a hanging request after 15 seconds and stops without retrying', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error(key)), { once: true });
        }),
    );
    const pending = runSmokeTests(key, { fetchImpl });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const summary = await pending;
    expect(summary.results[0]).toMatchObject({ pass: false, reason: 'Request timed out.' });
    expect(summary.stopped).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(summary)).not.toContain(key);
  });

  it('does not make a request without a supplied key', async () => {
    const dependencies = harness();
    expect(await runSmokeTests('', dependencies)).toMatchObject({ failed: 1, stopped: true });
    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });
});
