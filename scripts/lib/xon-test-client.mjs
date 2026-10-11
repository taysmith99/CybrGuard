import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const origin = 'https://plus-api.xposedornot.com';
const sampleEmail = 'test@example.com';
const fakeKey = 'cybrguard-intentionally-invalid-test-key';
const fields = [
  'breach_id',
  'breached_date',
  'logo',
  'password_risk',
  'searchable',
  'xposed_data',
  'xposed_records',
  'xposure_desc',
  'domain',
];

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function validDate(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    calendar.toISOString().slice(0, 10) === `${year}-${month}-${day}` &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    (zone === 'Z' || (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60))
  );
}

function validateSuccess(body, email, detailed) {
  if (!object(body) || body.status !== 'success' || body.email !== email) {
    return { reason: 'Invalid success envelope or mismatched address.' };
  }
  if (!Array.isArray(body.breaches)) return { reason: 'Missing breach list.' };
  const ids = new Set();
  for (const breach of body.breaches) {
    if (detailed) {
      if (!object(breach) || !fields.every((field) => Object.hasOwn(breach, field))) {
        return { reason: 'Required detailed fields are missing.' };
      }
      for (const field of fields) {
        const value = breach[field];
        if (field === 'breach_id') {
          if (!nonemptyString(value)) return { reason: 'Invalid breach identifier.' };
        } else if (value !== null) {
          if (field === 'xposed_records') {
            if (!Number.isSafeInteger(value) || value < 0) {
              return { reason: 'Invalid record count.' };
            }
          } else if (typeof value !== 'string') {
            return { reason: 'Invalid detailed field type.' };
          } else if (field === 'breached_date' && !validDate(value)) {
            return { reason: 'Invalid breach date.' };
          }
        }
      }
    } else if (!nonemptyString(breach)) {
      return { reason: 'Invalid breach identifier.' };
    }
    const id = detailed ? breach.breach_id : breach;
    if (ids.has(id)) return { reason: 'Duplicate breach identifiers.' };
    ids.add(id);
  }
  return { ids };
}

function validateError(body, status) {
  if (status === 422) {
    return (
      object(body) &&
      Array.isArray(body.detail) &&
      body.detail.some(
        (error) =>
          object(error) &&
          Array.isArray(error.loc) &&
          error.loc[0] === 'header' &&
          error.loc[1] === 'x-api-key' &&
          nonemptyString(error.msg) &&
          nonemptyString(error.type),
      )
    );
  }
  return (
    object(body) &&
    object(body.detail) &&
    body.detail.status === 'error' &&
    nonemptyString(body.detail.message)
  );
}

async function request(scenario, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = null;
  try {
    const url = new URL(`/v3/check-email/${encodeURIComponent(scenario.email)}`, origin);
    url.searchParams.set('detailed', String(scenario.detailed));
    const headers = { accept: 'application/json' };
    if (scenario.key !== null) headers['x-api-key'] = scenario.key;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
    status = response.status;
    if (response.redirected || (status >= 300 && status < 400)) {
      return { status, reason: 'Redirect refused.', stop: true };
    }
    if (status === 429) return { status, reason: 'Rate limited; no retry attempted.', stop: true };
    if (status >= 500)
      return { status, reason: 'Provider unavailable; no retry attempted.', stop: true };
    if (status !== scenario.expected) return { status, reason: 'Unexpected HTTP status.' };
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      return { status, reason: 'Response content type is not JSON.' };
    }
    const rawBody = await response.text();
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      if (controller.signal.aborted) return { status, reason: 'Request timed out.', stop: true };
      return { status, reason: 'Response is not valid JSON.' };
    }
    if (status !== 200) {
      return validateError(body, status)
        ? { status }
        : { status, reason: 'Invalid error envelope.' };
    }
    return { status, ...validateSuccess(body, scenario.email, scenario.detailed) };
  } catch {
    return {
      status,
      reason: controller.signal.aborted ? 'Request timed out.' : 'Network request failed.',
      stop: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Dependency injection is for offline tests only. The CLI accepts neither URLs nor addresses.
export async function runSmokeTests(
  key,
  { fetchImpl = globalThis.fetch, sleepImpl = sleep, timeoutMs = 15_000, onResult = () => {} } = {},
) {
  const results = [];
  if (!nonemptyString(key)) return { results, passed: 0, failed: 1, stopped: true };
  const scenarios = [
    { name: 'Simple lookup', email: sampleEmail, key, detailed: false, expected: 200 },
    { name: 'Detailed lookup', email: sampleEmail, key, detailed: true, expected: 200 },
    {
      name: 'Empty lookup',
      email: `${randomUUID()}@example.com`,
      key,
      detailed: false,
      expected: 200,
    },
    { name: 'Malformed address', email: 'invalid-email', key, detailed: false, expected: 404 },
    { name: 'Missing credential', email: sampleEmail, key: null, detailed: false, expected: 422 },
    {
      name: 'Invalid credential',
      email: sampleEmail,
      key: fakeKey,
      detailed: false,
      expected: 401,
    },
  ];
  let simpleIds;
  let stopped = false;
  for (const [index, scenario] of scenarios.entries()) {
    if (index > 0) await sleepImpl(1_500);
    const response = await request(scenario, fetchImpl, timeoutMs);
    let reason = response.reason;
    if (!reason && index === 0) simpleIds = response.ids;
    if (!reason && index === 1) {
      if (!simpleIds) {
        reason = 'Simple lookup failed; consistency could not be verified.';
      } else if (
        simpleIds.size !== response.ids.size ||
        [...simpleIds].some((id) => !response.ids.has(id))
      ) {
        reason = 'Simple and detailed breach identifiers differ.';
      }
      simpleIds = undefined;
    }
    if (!reason && index === 2 && response.ids.size !== 0) {
      reason = 'Synthetic empty lookup returned findings.';
    }
    const result = { scenario: scenario.name, status: response.status, pass: !reason };
    if (reason) result.reason = reason;
    results.push(result);
    onResult(result);
    if (response.stop) {
      stopped = true;
      break;
    }
  }
  return {
    results,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    stopped,
  };
}

export function formatResult(result) {
  return `${result.pass ? 'PASS' : 'FAIL'} ${result.scenario}: HTTP ${result.status ?? 'none'}${result.reason ? ` — ${result.reason}` : ''}`;
}
