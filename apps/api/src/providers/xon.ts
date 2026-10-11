import { type BreachDetails, breachDetailsSchema } from '@cybrguard/contracts';
import { z } from 'zod';
import { APIError } from '../lib/security';

export interface BreachIntelligenceProvider {
  checkVerifiedEmail(
    email: string,
    detailed?: boolean,
  ): Promise<{ checkedAt: string; knownBreachCount: number; findings?: BreachDetails[] }>;
}

export class XonProvider implements BreachIntelligenceProvider {
  constructor(
    private key: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  async checkVerifiedEmail(
    email: string,
    detailed = false,
  ): Promise<{ checkedAt: string; knownBreachCount: number; findings?: BreachDetails[] }> {
    if (!this.key)
      throw new APIError('provider_unavailable', 503, 'Breach intelligence is not configured.');
    const url = new URL(
      `https://plus-api.xposedornot.com/v3/check-email/${encodeURIComponent(email)}`,
    );
    // The route chooses detailed mode only after checking server-side premium access.
    url.searchParams.set('detailed', String(detailed));
    let response: Response;
    try {
      // Workers fetch requires its global receiver; do not invoke it as a class method.
      const fetcher = this.fetcher;
      response = await fetcher(url, {
        headers: { accept: 'application/json', 'x-api-key': this.key },
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new APIError(
        'provider_unavailable',
        503,
        'Breach intelligence is temporarily unavailable. Try again later.',
      );
    }
    if (response.status === 429) {
      let seconds = 60;
      try {
        const body = (await response.json()) as { detail?: { retry_after?: unknown } };
        if (
          typeof body.detail?.retry_after === 'number' &&
          Number.isFinite(body.detail.retry_after)
        )
          seconds = Math.min(86_400, Math.max(1, Math.ceil(body.detail.retry_after)));
      } catch {
        /* Keep safe default; never expose upstream error text. */
      }
      throw new APIError(
        'provider_rate_limited',
        429,
        'The breach provider is busy. Try again later.',
        seconds,
      );
    }
    if ([401, 403, 422].includes(response.status))
      throw new APIError(
        'provider_not_authorised',
        503,
        'The breach provider needs server configuration.',
      );
    if (response.status >= 500)
      throw new APIError(
        'provider_unavailable',
        503,
        'Breach intelligence is temporarily unavailable.',
      );
    if (
      response.status !== 200 ||
      response.redirected ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    )
      throw new APIError(
        'provider_bad_response',
        502,
        'The breach provider returned an unsupported response.',
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new APIError(
        'provider_bad_response',
        502,
        'The breach provider returned an unsupported response.',
      );
    }
    return detailed ? parseXonDetails(body, email) : parseXonCount(body, email);
  }
}

export function parseXonCount(body: unknown, email: string) {
  const value = body as { status?: unknown; email?: unknown; breaches?: unknown } | null;
  if (
    value?.status !== 'success' ||
    value.email !== email ||
    !Array.isArray(value.breaches) ||
    value.breaches.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(value.breaches).size !== value.breaches.length
  ) {
    throw new APIError(
      'provider_bad_response',
      502,
      'The breach provider returned an unsupported response.',
    );
  }
  return { checkedAt: new Date().toISOString(), knownBreachCount: value.breaches.length };
}

const detailedBreachSchema = z.object({
  breach_id: z.string().trim().min(1).max(500),
  breached_date: z.iso.datetime({ offset: true }).nullable(),
  domain: z.string().max(500).nullable(),
  password_risk: z.string().max(500).nullable(),
  xposed_data: z.string().max(5000).nullable(),
  xposure_desc: z.string().max(20000).nullable(),
});

export function parseXonDetails(body: unknown, email: string) {
  const parsed = z
    .object({
      status: z.literal('success'),
      email: z.literal(email),
      breaches: z.array(detailedBreachSchema).max(5000),
    })
    .safeParse(body);
  if (
    !parsed.success ||
    new Set(parsed.data.breaches.map((b) => b.breach_id)).size !== parsed.data.breaches.length
  )
    throw new APIError(
      'provider_bad_response',
      502,
      'The breach provider returned an unsupported response.',
    );
  const findings = parsed.data.breaches.map((breach) => {
    const risk = breach.password_risk?.trim().toLowerCase().replace(/[_-]/g, ' ') ?? '';
    return breachDetailsSchema.parse({
      breachId: breach.breach_id,
      breachedAt: breach.breached_date,
      domain: breach.domain,
      passwordRisk: breach.password_risk,
      passwordRiskHighlighted: [
        'plaintext',
        'plain text',
        'easy to crack',
        'easytocrack',
        'weak',
        'weak hash',
        'weak hashing',
        'unencrypted',
      ].includes(risk),
      exposedData: (breach.xposed_data ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean),
      description: breach.xposure_desc,
    });
  });
  return { checkedAt: new Date().toISOString(), knownBreachCount: findings.length, findings };
}
