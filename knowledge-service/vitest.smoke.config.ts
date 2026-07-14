/**
 * Smoke test configuration — requires a LIVE knowledge-service.
 *
 * Run with: npm run test:smoke
 * Prerequisites: service running at TEST_API_URL (default http://localhost:3456),
 * ChromaDB up, and a real terminal file tree (TERMINALS_PATH).
 * These are environment verification tests, not CI gates.
 */

import { defineConfig } from 'vitest/config';
import { SMOKE_TESTS } from './vitest.config';

export default defineConfig({
  test: {
    include: SMOKE_TESTS,
  },
});
