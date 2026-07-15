/**
 * Default (hermetic) test configuration.
 *
 * `npm test` runs only tests that pass on a bare checkout: no live
 * knowledge-service, no ChromaDB, no terminal file tree required.
 * Live-server smoke tests are excluded here and run separately via
 * `npm run test:smoke` (vitest.smoke.config.ts).
 */

import { defineConfig, configDefaults } from 'vitest/config';
import { SMOKE_TESTS } from './test-suites';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...SMOKE_TESTS],
    // Full-suite runs saturate the machine (transform+import >60s across workers);
    // suites that pass in isolation were hitting the 10s default in beforeAll.
    hookTimeout: 30000,
    testTimeout: 15000,
  },
});
