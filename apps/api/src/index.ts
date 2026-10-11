import { type ErrorResponse, environmentSchema, healthResponseSchema } from '@cybrguard/contracts';
import { Hono } from 'hono';

export type Bindings = {
  DB: D1Database;
  APP_ENV: string;
  DATA_MODE: string;
};

type WorkerEnvironment = {
  Bindings: Bindings;
  Variables: { requestId: string };
};

function error(
  code: ErrorResponse['error']['code'],
  message: string,
  requestId: string,
): ErrorResponse {
  return { error: { code, message, requestId } };
}

export const app = new Hono<WorkerEnvironment>();

app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');

  const environment = environmentSchema.safeParse(c.env.APP_ENV);
  if (!environment.success || c.env.DATA_MODE !== 'unconfigured') {
    return c.json(error('configuration_error', 'Invalid service configuration.', requestId), 503);
  }
  if (environment.data !== 'development' && environment.data !== 'test') {
    return c.json(
      error(
        'scaffold_not_deployable',
        'This development scaffold is not ready for deployment.',
        requestId,
      ),
      503,
    );
  }
  await next();
});

app.get('/v1/health', async (c) => {
  try {
    const version = await c.env.DB.prepare(
      'SELECT version FROM schema_metadata WHERE id = 1',
    ).first<number>('version');
    if (version !== 1) throw new Error('Schema is not ready');
  } catch {
    return c.json(
      error('database_unavailable', 'Local database is not ready.', c.get('requestId')),
      503,
    );
  }

  return c.json(
    healthResponseSchema.parse({
      status: 'ok',
      service: 'cybrguard-api',
      environment: c.env.APP_ENV,
      dataMode: 'unconfigured',
    }),
  );
});

app.notFound((c) => c.json(error('not_found', 'Endpoint not found.', c.get('requestId')), 404));

app.onError((_cause, c) => {
  // Deliberately do not log request paths, credentials or exception payloads.
  console.error(JSON.stringify({ event: 'request_failed', requestId: c.get('requestId') }));
  return c.json(
    error('internal_error', 'The request could not be completed.', c.get('requestId')),
    500,
  );
});

export default app;
