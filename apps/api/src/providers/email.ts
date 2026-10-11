import { APIError } from '../lib/security';

export type EmailConfiguration = {
  EMAIL_TRANSPORT?: string;
  EMAIL_FROM?: string;
  EMAIL?: {
    send(message: {
      from: string;
      to: string;
      subject: string;
      text: string;
    }): Promise<{ messageId: string }>;
  };
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_EMAIL_API_TOKEN?: string;
};

export function requireEmailConfiguration(env: EmailConfiguration) {
  const bindingReady = env.EMAIL_TRANSPORT === 'cloudflare-binding' && env.EMAIL;
  const restReady =
    env.EMAIL_TRANSPORT === 'cloudflare-rest' &&
    /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') &&
    env.CLOUDFLARE_EMAIL_API_TOKEN;
  if (
    (!bindingReady && !restReady) ||
    !env.EMAIL_FROM ||
    !/^[^\s@]+@cybrguard\.app$/.test(env.EMAIL_FROM)
  ) {
    throw new APIError(
      'email_unavailable',
      503,
      'Verification email is not configured. Finish Cloudflare Email Service sender setup.',
    );
  }
}

export async function sendVerificationEmail(env: EmailConfiguration, to: string, code: string) {
  requireEmailConfiguration(env);
  const message = {
    from: env.EMAIL_FROM as string,
    to,
    subject: 'Your CybrGuard verification code',
    text: `Your CybrGuard verification code is ${code.slice(0, 3)}-${code.slice(3)}. It expires in 10 minutes and can be used once.\n\nOnly enter it in CybrGuard. Never share this code. If you did not request it, ignore this email.`,
  };
  try {
    if (env.EMAIL_TRANSPORT === 'cloudflare-binding' && env.EMAIL) {
      // This mode requires an actual deployed binding or remote:true locally; never a simulated email binding.
      const result = await env.EMAIL.send(message);
      if (!result.messageId) throw new Error('No delivery acknowledgement');
      return;
    }
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`,
      {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      },
    );
    if (!response.ok || response.redirected) throw new Error('Delivery failed');
    const body = (await response.json()) as {
      success?: boolean;
      result?: { delivered?: string[]; queued?: string[] };
    };
    if (
      body.success !== true ||
      ![...(body.result?.delivered ?? []), ...(body.result?.queued ?? [])].includes(to)
    )
      throw new Error('Delivery not accepted');
  } catch {
    throw new APIError(
      'email_unavailable',
      503,
      'Verification email could not be sent. Try again later.',
    );
  }
}
