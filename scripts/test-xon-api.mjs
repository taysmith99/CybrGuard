import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { formatResult, runSmokeTests } from './lib/xon-test-client.mjs';

async function main() {
  if (process.env.CI) {
    console.error('FAIL Live provider tests are disabled in CI.');
    return 1;
  }
  if (process.argv.length !== 2) {
    console.error('FAIL This test command accepts no arguments.');
    return 1;
  }
  let key;
  try {
    const environment = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
    key = environment.XON_API_KEY?.trim();
  } catch {
    console.error('FAIL Could not read the root .env file.');
    return 1;
  }
  if (!key) {
    console.error('FAIL Set XON_API_KEY in the root .env file.');
    return 1;
  }
  const summary = await runSmokeTests(key, {
    onResult: (result) => console.log(formatResult(result)),
  });
  console.log(
    `Summary: ${summary.passed} passed, ${summary.failed} failed, ${6 - summary.results.length} not run.${summary.stopped ? ' Stopped without retrying.' : ''}`,
  );
  return summary.failed || summary.stopped ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch {
  console.error('FAIL Test runner stopped unexpectedly; sensitive details were suppressed.');
  process.exitCode = 1;
}
