import { type ErrorResponse, environmentSchema, healthResponseSchema } from '@cybrguard/contracts';
import { Hono } from 'hono';
import { APIError } from './lib/security';
import { type EmailConfiguration, requireEmailConfiguration } from './providers/email';
import { registerRoutes } from './routes';

export type Bindings = EmailConfiguration & {
  DB: D1Database;
  APP_ENV: string;
  DATA_MODE: string;
  STAGING_ALLOWED_EMAILS?: string;
  XON_API_KEY?: string;
  DATA_ENCRYPTION_KEY?: string;
  EMAIL_BLIND_INDEX_KEY?: string;
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
  if (
    !environment.success ||
    !['unconfigured', 'live'].includes(c.env.DATA_MODE) ||
    (c.env.DATA_MODE === 'live' &&
      (!/^[a-f0-9]{64}$/i.test(c.env.DATA_ENCRYPTION_KEY ?? '') ||
        (c.env.EMAIL_BLIND_INDEX_KEY?.length ?? 0) < 32 ||
        !c.env.XON_API_KEY))
  ) {
    return c.json(error('configuration_error', 'Invalid service configuration.', requestId), 503);
  }
  if (environment.data === 'production') {
    return c.json(
      error('scaffold_not_deployable', 'Production deployment is not enabled.', requestId),
      503,
    );
  }
  if (environment.data === 'staging') {
    if (c.env.DATA_MODE !== 'live' || !c.env.STAGING_ALLOWED_EMAILS?.trim())
      return c.json(
        error('configuration_error', 'Staging configuration is incomplete.', requestId),
        503,
      );
    requireEmailConfiguration(c.env);
    const url = new URL(c.req.url);
    if (url.protocol !== 'https:' || url.hostname !== 'api.cybrguard.app')
      return c.json(error('configuration_error', 'Use the staging HTTPS origin.', requestId), 503);
    c.header('Strict-Transport-Security', 'max-age=31536000');
  }
  await next();
});

app.get('/v1/health', async (c) => {
  try {
    const version = await c.env.DB.prepare(
      'SELECT version FROM schema_metadata WHERE id = 1',
    ).first<number>('version');
    if ((version !== 1 && version !== 2) || (c.env.DATA_MODE === 'live' && version !== 2))
      throw new Error('Schema is not ready');
  } catch {
    return c.json(error('database_unavailable', 'Database is not ready.', c.get('requestId')), 503);
  }

  return c.json(
    healthResponseSchema.parse({
      status: 'ok',
      service: 'cybrguard-api',
      environment: c.env.APP_ENV,
      dataMode: c.env.DATA_MODE,
    }),
  );
});

registerRoutes(app);

app.notFound((c) => c.json(error('not_found', 'Endpoint not found.', c.get('requestId')), 404));

app.onError((cause, c) => {
  if (cause instanceof APIError) {
    if (cause.retryAfter) c.header('Retry-After', String(cause.retryAfter));
    return c.json(
      { error: { code: cause.code, message: cause.message, requestId: c.get('requestId') } },
      cause.status,
    );
  }
  // Deliberately do not log request paths, credentials or exception payloads.
  console.error(JSON.stringify({ event: 'request_failed', requestId: c.get('requestId') }));
  return c.json(
    error('internal_error', 'The request could not be completed.', c.get('requestId')),
    500,
  );
});

export default app;
