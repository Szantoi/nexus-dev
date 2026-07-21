/**
 * perfBudget — env-tunable budget for time-based (performance) assertions.
 *
 * TASK-QC-006: the suite contains fixed millisecond budgets (e.g. "<200ms").
 * Under coverage instrumentation or a saturated CI machine these budgets are
 * occasionally exceeded even though the code is fine, producing flaky runs.
 * Instead of deleting the perf asserts, every fixed budget is scaled by a
 * single multiplier:
 *
 *   PERF_BUDGET_MULTIPLIER  (default 1; vitest.config.ts sets 4 for
 *                            coverage/CI runs unless the caller overrides it)
 *
 * Usage in tests:  expect(elapsed).toBeLessThan(perfBudget(200));
 */

function resolveMultiplier(): number {
  const raw = Number(process.env.PERF_BUDGET_MULTIPLIER ?? '1');
  // Fail safe: a malformed or non-positive value must never disable the
  // assertion (Infinity) or make it impossible (0/negative) — fall back to 1.
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Effective multiplier for this process (resolved once at import). */
export const PERF_BUDGET_MULTIPLIER = resolveMultiplier();

/** Scale a fixed millisecond budget by the configured multiplier. */
export function perfBudget(ms: number): number {
  return ms * PERF_BUDGET_MULTIPLIER;
}
