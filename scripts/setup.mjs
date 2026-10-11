import { constants, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('.dev.vars.example', root);
const destination = new URL('apps/api/.dev.vars', root);
mkdirSync(new URL('apps/api/', root), { recursive: true });

try {
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  console.log(`Created ${fileURLToPath(destination)}. No provider credentials are needed.`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing apps/api/.dev.vars retained.');
}

console.log('Next: npm run db:migrate:local, then npm run dev:api.');
