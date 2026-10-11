import { z } from 'zod';

export const environmentSchema = z.enum(['development', 'test', 'staging', 'production']);

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('cybrguard-api'),
  environment: environmentSchema,
  dataMode: z.enum(['unconfigured', 'live']),
});

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'not_found',
      'configuration_error',
      'scaffold_not_deployable',
      'database_unavailable',
      'internal_error',
      'invalid_request',
      'invalid_code',
      'unauthorised',
      'rate_limited',
      'email_unavailable',
      'provider_unavailable',
      'provider_not_authorised',
      'provider_bad_response',
      'provider_rate_limited',
      'subscription_required',
    ]),
    message: z.string(),
    requestId: z.uuid(),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type Environment = z.infer<typeof environmentSchema>;

export const addressSummarySchema = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  verified: z.literal(true),
  knownBreachCount: z.number().int().nonnegative().nullable(),
  checkedAt: z.iso.datetime().nullable(),
});
export const sessionResponseSchema = z.strictObject({
  accessToken: z.string().regex(/^[a-f0-9]{64}$/),
  refreshToken: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int(),
});
export const verificationResponseSchema = z.strictObject({
  challengeId: z.uuid(),
  expiresIn: z.number().int().positive(),
  message: z.string(),
});
export const accountResponseSchema = z.strictObject({
  userId: z.uuid(),
  tier: z.literal('free'),
  quota: z.literal(1),
  address: addressSummarySchema,
});

export const deviceCredentialSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const authStartSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).email(),
  consent: z.literal(true),
  deviceId: deviceCredentialSchema,
});
export const authVerifySchema = z.strictObject({
  challengeId: z.uuid(),
  code: z
    .string()
    .trim()
    .regex(/^\d{3}-?\d{3}$/)
    .transform((code) => code.replace('-', '')),
  deviceId: deviceCredentialSchema,
});
export const authRefreshSchema = z.strictObject({
  refreshToken: deviceCredentialSchema,
  deviceId: deviceCredentialSchema,
});
