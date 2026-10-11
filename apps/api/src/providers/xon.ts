import { APIError } from '../lib/security';

export interface BreachIntelligenceProvider {
  checkVerifiedEmail(email: string): Promise<{ checkedAt: string; knownBreachCount: number }>;
}

export class XonProvider implements BreachIntelligenceProvider {
  constructor(
    private key: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  async checkVerifiedEmail(email: string) {
    if (!this.key)
      throw new APIError('provider_unavailable', 503, 'Breach intelligence is not configured.');
    const url = new URL(
      `https://plus-api.xposedornot.com/v3/check-email/${encodeURIComponent(email)}`,
    );
    // Free access needs a count only. Do not collect detailed metadata before billing exists.
    url.searchParams.set('detailed', 'false');
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
    return parseXonCount(body, email);
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
