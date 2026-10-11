import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/api/test/**/*.test.ts',
      'packages/contracts/test/**/*.test.ts',
      'scripts/test/**/*.test.mjs',
    ],
    clearMocks: true,
  },
});
