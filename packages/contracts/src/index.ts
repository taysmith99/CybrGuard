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
      'forbidden',
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
  isPrimary: z.boolean(),
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
  tier: z.enum(['free', 'premium']),
  quota: z.number().int().min(1).max(25),
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

export const breachDetailsSchema = z.strictObject({
  breachId: z.string().min(1).max(500),
  breachedAt: z.string().nullable(),
  domain: z.string().max(500).nullable(),
  exposedData: z.array(z.string().max(500)).max(100),
  passwordRisk: z.string().max(500).nullable(),
  passwordRiskHighlighted: z.boolean(),
  description: z.string().max(20000).nullable(),
});
export const remediationStepSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  completedAt: z.iso.datetime().nullable(),
});
export const remediationStepUpdateSchema = z.strictObject({ completed: z.boolean() });
export const findingSchema = breachDetailsSchema.extend({
  id: z.uuid(),
  isNew: z.boolean(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  remediatedAt: z.iso.datetime().nullable(),
  remediationSteps: z.array(remediationStepSchema),
});
export const findingsResponseSchema = z.strictObject({
  findings: z.array(findingSchema),
  checkedAt: z.iso.datetime().nullable(),
});
export const remediationSchema = z.strictObject({ remediated: z.boolean() });
export type BreachDetails = z.infer<typeof breachDetailsSchema>;

export const addressListSchema = z.strictObject({
  addresses: z.array(addressSummarySchema),
  quota: z.number().int().min(1).max(25),
});

export const sessionListSchema = z.strictObject({
  sessions: z.array(
    z.strictObject({
      id: z.uuid(),
      current: z.boolean(),
      expiresAt: z.number().int(),
    }),
  ),
});

export const monitoringUpdateSchema = z.strictObject({ enabled: z.boolean() });
export const monitoringResponseSchema = z.strictObject({
  enabled: z.boolean(),
  paused: z.boolean(),
  cadenceHours: z.literal(24),
  lastCheckedAt: z.iso.datetime().nullable(),
  nextCheckAt: z.number().int().nullable(),
  outcome: z.string().nullable(),
  pushAvailable: z.literal(false),
});
