import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': `${here}src`,
      '@oghost/shared': `${here}../../packages/shared/src/index.ts`,
      // The real package throws outside a Server Component build, which would
      // make any module carrying the marker untestable. See tests/stubs.
      'server-only': `${here}tests/stubs/server-only.ts`,
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
