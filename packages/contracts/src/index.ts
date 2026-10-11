import { z } from 'zod';

export const environmentSchema = z.enum(['development', 'test', 'staging', 'production']);

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('cybrguard-api'),
  environment: environmentSchema,
  dataMode: z.literal('unconfigured'),
});

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'not_found',
      'configuration_error',
      'scaffold_not_deployable',
      'database_unavailable',
      'internal_error',
    ]),
    message: z.string(),
    requestId: z.uuid(),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type Environment = z.infer<typeof environmentSchema>;
