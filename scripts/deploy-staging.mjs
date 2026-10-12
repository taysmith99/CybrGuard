import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = new URL('../', import.meta.url);
const configPath = new URL('apps/api/wrangler.jsonc', root);
const secretsPath = new URL('.env.staging', root);
const account = '9e107262ea2871d9315290c7e380a2da';
const databaseName = 'cybrguard-staging';
const origin = 'https://api.cybrguard.app';

async function main() {
  const source = parseEnv(await readFile(new URL('.env', root), 'utf8'));
  const token = source.CLOUDFLARE_API_TOKEN?.trim() || source.CLOUDFLARE_EMAIL_TOKEN?.trim();
  if (!token)
    throw new Error(
      'Add CLOUDFLARE_API_TOKEN to local .env with Workers, D1 and zone deployment permissions.',
    );
  if (source.CLOUDFLARE_ACCOUNT_ID !== account)
    throw new Error('Cloudflare account does not match the staging configuration.');
  if (!source.XON_API_KEY || !source.CLOUDFLARE_EMAIL_TOKEN)
    throw new Error('Local XON and Cloudflare email credentials are required.');

  async function api(path, method = 'GET', body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (!response.ok || !data.success)
      throw new Error(
        `Cloudflare ${method} ${path} failed (HTTP ${response.status}; codes ${(data.errors ?? []).map((error) => error.code).join(',')}). Check deployment-token permissions.`,
      );
    return data.result;
  }

  const zones = await api('/zones?name=cybrguard.app');
  const zone = zones.find(
    (candidate) => candidate.account?.id === account && candidate.status === 'active',
  );
  if (!zone)
    throw new Error(
      'The deployment token must see the active cybrguard.app zone in the intended account.',
    );
  const databases = await api(`/accounts/${account}/d1/database?per_page=100`);
  let database = databases.find((candidate) => candidate.name === databaseName);
  let secrets;
  try {
    secrets = parseEnv(await readFile(secretsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (database)
      throw new Error(
        'Staging D1 already exists but .env.staging is missing. Restore its encryption keys; do not generate replacements.',
      );
    secrets = {
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      EMAIL_BLIND_INDEX_KEY: randomBytes(32).toString('hex'),
      STAGING_ALLOWED_EMAILS: source.STAGING_ALLOWED_EMAILS?.trim() ?? '',
    };
  }
  if (
    !/^[a-f0-9]{64}$/.test(secrets.DATA_ENCRYPTION_KEY ?? '') ||
    !/^[a-f0-9]{64}$/.test(secrets.EMAIL_BLIND_INDEX_KEY ?? '') ||
    !secrets.STAGING_ALLOWED_EMAILS?.trim()
  )
    throw new Error('Invalid staging keys or tester allowlist.');
  // Upload only runtime secret bindings; never add a deployment-token binding.
  const runtime = {
    DATA_ENCRYPTION_KEY: secrets.DATA_ENCRYPTION_KEY,
    EMAIL_BLIND_INDEX_KEY: secrets.EMAIL_BLIND_INDEX_KEY,
    STAGING_ALLOWED_EMAILS: secrets.STAGING_ALLOWED_EMAILS,
    STAGING_PREMIUM_EMAILS: secrets.STAGING_PREMIUM_EMAILS ?? '',
    XON_API_KEY: source.XON_API_KEY.trim(),
    CLOUDFLARE_EMAIL_API_TOKEN: source.CLOUDFLARE_EMAIL_TOKEN.trim(),
  };
  await writeFile(
    secretsPath,
    `${Object.entries(runtime)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  await chmod(secretsPath, 0o600);
  if (!database) {
    database = await api(`/accounts/${account}/d1/database`, 'POST', { name: databaseName });
    console.log('Created isolated staging D1 database.');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.env.staging.d1_databases[0].database_id = database.uuid ?? database.id;
  if (!config.env.staging.d1_databases[0].database_id)
    throw new Error('Cloudflare did not return a D1 identifier.');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const formatting = spawnSync(
    fileURLToPath(new URL('node_modules/.bin/biome', root)),
    ['format', '--write', fileURLToPath(configPath)],
    { cwd: fileURLToPath(root), stdio: 'ignore' },
  );
  if (formatting.status !== 0) throw new Error('Staging configuration formatting failed.');

  function wrangler(args) {
    const result = spawnSync(fileURLToPath(new URL('node_modules/.bin/wrangler', root)), args, {
      cwd: fileURLToPath(new URL('apps/api/', root)),
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: account,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (result.status !== 0)
      throw new Error('Wrangler stopped; staging deployment is not confirmed.');
  }
  const queues = await api(`/accounts/${account}/queues?per_page=100`);
  const queueName = 'cybrguard-monitoring-staging';
  if (!queues.some((queue) => queue.queue_name === queueName)) {
    await api(`/accounts/${account}/queues`, 'POST', { queue_name: queueName });
    console.log('Created isolated staging monitoring queue.');
  }
  wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--env', 'staging']);
  wrangler(['deploy', '--env', 'staging', '--secrets-file', fileURLToPath(secretsPath)]);
  let response;
  try {
    response = await fetch(`${origin}/v1/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(
      'Deployment uploaded; HTTPS health lookup is pending. Allow DNS/certificate propagation and check /v1/health again.',
    );
  }
  const health = await response.json();
  if (response.status !== 200 || health.environment !== 'staging' || health.dataMode !== 'live')
    throw new Error(
      'Deployment uploaded but HTTPS staging health is not ready. Allow DNS/certificate propagation and check /v1/health.',
    );
  console.log(`Staging HTTPS health verified: ${origin}/v1/health`);
}

try {
  await main();
} catch (error) {
  // Only our own controlled messages are printed; never print arbitrary upstream exception payloads.
  const message = error instanceof Error ? error.message : '';
  const safe =
    /^(Add |Cloudflare |Local |The deployment |Staging |Invalid staging |Wrangler |Deployment )/.test(
      message,
    );
  console.error(
    safe ? message : 'Staging setup stopped unexpectedly; sensitive error details suppressed.',
  );
  process.exitCode = 1;
}
