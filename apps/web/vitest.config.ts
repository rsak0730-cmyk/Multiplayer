import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': `${here}src`,
      '@oghost/shared': `${here}../../packages/shared/src/index.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Pure logic only. Nothing here may touch Supabase, the network or the
    // filesystem beyond reading source files for the cross-language mirrors.
    passWithNoTests: false,
  },
});
