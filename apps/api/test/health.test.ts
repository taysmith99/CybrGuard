import { errorResponseSchema, healthResponseSchema } from '@cybrguard/contracts';
import { describe, expect, it, vi } from 'vitest';
import { app, type Bindings } from '../src/index';

function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    APP_ENV: 'test',
    DATA_MODE: 'unconfigured',
    DB: {
      prepare: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(1) }),
    } as unknown as D1Database,
    ...overrides,
  };
}

describe('development API boundaries', () => {
  it('reports migrated local readiness with a valid contract and safe headers', async () => {
    const response = await app.request('/v1/health', {}, bindings());
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: 'ok',
      service: 'cybrguard-api',
      environment: 'test',
      dataMode: 'unconfigured',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(['production'])('refuses to serve this scaffold in %s', async (APP_ENV) => {
    const env = bindings({ APP_ENV });
    const response = await app.request('/v1/health', {}, env);
    expect(response.status).toBe(503);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe(
      'scaffold_not_deployable',
    );
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { APP_ENV: 'unknown' },
    { DATA_MODE: 'mock' },
    { DATA_MODE: 'live' },
    { DATA_MODE: '' },
  ])('fails closed on unsupported configuration %j', async (overrides) => {
    const response = await app.request('/v1/health', {}, bindings(overrides));
    expect(response.status).toBe(503);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('configuration_error');
  });

  it('does not report success for an unmigrated database or leak its errors', async () => {
    const env = bindings();
    vi.mocked(env.DB.prepare).mockImplementation(() => {
      throw new Error('secret internal SQL detail');
    });
    const response = await app.request('/v1/health', {}, env);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('secret');
    expect(errorResponseSchema.parse(JSON.parse(body)).error.code).toBe('database_unavailable');
  });

  it('does not report success if the schema version is missing', async () => {
    const env = bindings();
    vi.mocked(env.DB.prepare).mockReturnValue({
      first: vi.fn().mockResolvedValue(null),
    } as unknown as D1PreparedStatement);
    expect((await app.request('/v1/health', {}, env)).status).toBe(503);
  });

  it('does not expose unimplemented business routes or reflect a supplied request ID', async () => {
    const response = await app.request(
      '/v1/not-implemented?email=sensitive',
      {
        headers: { 'X-Request-ID': 'attacker-controlled' },
      },
      bindings(),
    );
    expect(response.status).toBe(404);
    const body = errorResponseSchema.parse(await response.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(response.headers.get('X-Request-ID'));
    expect(JSON.stringify(body)).not.toContain('sensitive');
    expect(body.error.requestId).not.toBe('attacker-controlled');
  });
});
