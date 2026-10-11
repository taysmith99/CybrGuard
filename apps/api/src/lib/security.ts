export class APIError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();
export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export function verificationCode(): string {
  // Rejection sampling avoids modulo bias; six digits give one million possibilities.
  let value: number;
  do {
    value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  } while (value >= 4_294_000_000);
  return (value % 1_000_000).toString().padStart(6, '0');
}
export async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function keyedHash(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
async function encryptionKey(secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret))
    throw new APIError('configuration_error', 503, 'Encryption configuration is unavailable.');
  const bytes = new Uint8Array(secret.match(/../g)?.map((v) => Number.parseInt(v, 16)) ?? []);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(secret: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await encryptionKey(secret),
      encoder.encode(value),
    ),
  );
  return btoa(String.fromCharCode(...iv, ...encrypted));
}
export async function decrypt(secret: string, value: string): Promise<string> {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      await encryptionKey(secret),
      bytes.slice(12),
    ),
  );
}
