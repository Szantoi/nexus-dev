/**
 * Default (hermetic) test configuration.
 *
 * `npm test` runs only tests that pass on a bare checkout: no live
 * knowledge-service, no ChromaDB, no terminal file tree required.
 * Live-server smoke tests are excluded here and run separately via
 * `npm run test:smoke` (vitest.smoke.config.ts).
 */

import { defineConfig, configDefaults } from 'vitest/config';

/** Tests that need a running service at TEST_API_URL (default localhost:3456). */
export const SMOKE_TESTS = [
  'src/__tests__/agent/**',
  'src/__tests__/integration/api.test.ts',
  'src/__tests__/integration/session.test.ts',
  'src/__tests__/integration/watchInbox.integration.test.ts',
];

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...SMOKE_TESTS],
  },
});
