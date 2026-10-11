import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = new URL('../', import.meta.url);
const destination = new URL('apps/api/.dev.vars', root);
mkdirSync(new URL('apps/api/', root), { recursive: true });
const existing = existsSync(destination) ? parseEnv(readFileSync(destination, 'utf8')) : {};
const source = new URL('.env', root);
const supplied = existsSync(source) ? parseEnv(readFileSync(source, 'utf8')) : {};
const env = { ...parseEnv(readFileSync(new URL('.dev.vars.example', root), 'utf8')), ...existing };
for (const key of [
  'XON_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_EMAIL_API_TOKEN',
  'EMAIL_FROM',
]) {
  if (supplied[key]?.trim()) env[key] = supplied[key].trim();
}
if (supplied.CLOUDFLARE_EMAIL_TOKEN?.trim())
  env.CLOUDFLARE_EMAIL_API_TOKEN = supplied.CLOUDFLARE_EMAIL_TOKEN.trim();
env.DATA_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
env.EMAIL_BLIND_INDEX_KEY ||= randomBytes(32).toString('hex');
env.APP_ENV = 'development';
env.DATA_MODE = env.XON_API_KEY ? 'live' : 'unconfigured';
if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_EMAIL_API_TOKEN)
  env.EMAIL_TRANSPORT = 'cloudflare-rest';
writeFileSync(
  destination,
  `${Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')}\n`,
  { mode: 0o600 },
);
chmodSync(destination, 0o600);
console.log(`Updated ${fileURLToPath(destination)}; secret values suppressed.`);
console.log(`Breach mode: ${env.DATA_MODE}. Email transport: ${env.EMAIL_TRANSPORT}.`);
console.log(
  'Next: npm run db:migrate:local, then npm run dev:api. Real email delivery requires an active verified Cloudflare sending domain.',
);
