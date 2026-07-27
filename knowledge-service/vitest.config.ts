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

// TASK-QC-006 — deterministic perf-asserts: fixed ms budgets in the suite are
// scaled by PERF_BUDGET_MULTIPLIER (see src/__tests__/helpers/perfBudget.ts).
// Coverage instrumentation and loaded CI machines are slower than a plain
// local run, so those runs get a larger default multiplier. An explicit
// PERF_BUDGET_MULTIPLIER in the environment always wins.
const isCoverageRun = process.argv.some((a) => a === '--coverage' || a.startsWith('--coverage.'));
const perfBudgetMultiplier =
  process.env.PERF_BUDGET_MULTIPLIER ?? (isCoverageRun || process.env.CI ? '4' : '1');

export default defineConfig({
  test: {
    env: {
      PERF_BUDGET_MULTIPLIER: perfBudgetMultiplier,
    },
    exclude: [...configDefaults.exclude, ...SMOKE_TESTS],
    // Full-suite runs saturate the machine (transform+import >60s across workers);
    // suites that pass in isolation were hitting the 10s default in beforeAll.
    hookTimeout: 30000,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json'],
      // Coverage floor (TASK-QC-005 baseline, RAISED by TASK-QC-006 on
      // 2026-07-18). These are RATCHET values: they may only go UP; lowering
      // requires a documented ADR. Measured on the full hermetic suite after
      // the QC-006 critical-coverage work:
      //   statements 40.74% | branches 34.78% | functions 39.84% | lines 41.15%
      // The floor is set ~3 points below the measured values (headroom for
      // environment variance) and above the QC-006 mandated minimums
      // (35/30/35/35). Reproduce locally: npm run test:coverage
      thresholds: {
        statements: 38,
        branches: 32,
        functions: 37,
        lines: 38,
        // Per-file floors for the auth/security surfaces (TASK-QC-006 scope:
        // >=80% lines / >=70% branches). NOTE: files matched by these globs
        // are excluded from the global threshold pool by vitest.
        // Measured (full suite): tokenAuth 100/92, app 96/88, env 98/97,
        // mcp 87/73, epic-router.routes 87/88.
        'src/auth/tokenAuth.ts': { lines: 80, branches: 70 },
        'src/bootstrap/app.ts': { lines: 80, branches: 70 },
        'src/config/env.ts': { lines: 80, branches: 70 },
        'src/mcp.ts': { lines: 80, branches: 70 },
        'src/interfaces/http/routes/epic-router.routes.ts': { lines: 80, branches: 70 },
      },
    },
  },
});
