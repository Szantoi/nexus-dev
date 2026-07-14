/**
 * Shared test-suite lists for the vitest configs.
 *
 * Kept in its own module (not exported from vitest.config.ts) so the config
 * entry modules only have a default export.
 */

/** Tests that need a running service at TEST_API_URL (default localhost:3456). */
export const SMOKE_TESTS = [
  'src/__tests__/agent/**',
  'src/__tests__/integration/api.test.ts',
  'src/__tests__/integration/session.test.ts',
  'src/__tests__/integration/watchInbox.integration.test.ts',
];
