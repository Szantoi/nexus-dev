/**
 * preReviewGate unit tests — hermetic (TASK-QC-006).
 *
 * PINS the pre-review gate contract:
 *  - project routing: 'datahaven-web' → ESLint + TypeScript + Bundle Size +
 *    Security Audit; 'knowledge-service' → TypeScript (Backend) + Unit Tests +
 *    Security Audit (Backend)
 *  - per-check semantics: skip-with-warning when node_modules is missing,
 *    eslint "error" vs warning-only classification, `error TS\d+` counting,
 *    npm-audit JSON parsing on BOTH the resolve path and the non-zero-exit
 *    path (error.stdout), catch-catch on unparseable audit output,
 *    dist-present / dist-missing bundle estimation, and the top-level crash
 *    catch producing a "Pre-review gate crashed" summary.
 *
 * Hermetic setup: child_process.exec is mocked with the async mock attached
 * under Symbol.for('nodejs.util.promisify.custom') so promisify(exec) resolves
 * to our vi.fn; fs.access runs against real temp directories under os.tmpdir()
 * (DATAHAVEN_CLIENT_DIR is env-overridden BEFORE config/paths is imported).
 * No real child process is ever spawned.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const H = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const nodePath = require('path');
  const nodeOs = require('os');
  const nodeFs = require('fs');
  const runId = require('crypto').randomBytes(6).toString('hex');

  const clientDir = nodePath.join(nodeOs.tmpdir(), `prereview-client-${runId}`);
  nodeFs.mkdirSync(clientDir, { recursive: true });

  // Must be set BEFORE any src import: config/paths.ts reads process.env at import.
  process.env.DATAHAVEN_CLIENT_DIR = clientDir;
  process.env.DATA_DIR = nodePath.join(nodeOs.tmpdir(), `prereview-data-${runId}`);
  process.env.SPACEOS_ROOT = nodePath.join(nodeOs.tmpdir(), `prereview-root-${runId}`);

  // promisify(exec) returns exec[Symbol.for('nodejs.util.promisify.custom')]
  // directly, so execAsync inside the module under test IS this vi.fn.
  const execAsyncMock = vi.fn();
  const exec = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execAsyncMock,
  });

  return { clientDir, execAsyncMock, exec };
});

vi.mock('child_process', () => ({ exec: H.exec, execSync: vi.fn() }));
vi.mock('../../core/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runPreReviewGate, type PreReviewResult } from '../../pipeline/preReviewGate';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NODE_MODULES = path.join(H.clientDir, 'node_modules');
const DIST = path.join(H.clientDir, 'dist');

const CLEAN_AUDIT = JSON.stringify({ metadata: { vulnerabilities: { high: 0, critical: 0 } } });

/** Build an exec rejection carrying stdout/stderr like a real non-zero exit. */
function execErr(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

/**
 * Route the promisified exec mock by command substring. Unrouted commands get
 * safe passing defaults (clean audit JSON, plausible `du` output, empty tsc).
 */
function setExec(overrides: Record<string, (cmd: string) => Promise<{ stdout: string; stderr: string }>> = {}): void {
  H.execAsyncMock.mockImplementation(async (cmd: string) => {
    for (const key of Object.keys(overrides)) {
      if (cmd.includes(key)) return overrides[key](cmd);
    }
    if (cmd.includes('npm audit')) return { stdout: CLEAN_AUDIT, stderr: '' };
    if (cmd.startsWith('du ')) return { stdout: '4.2M\t/some/dist\n', stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

function check(result: PreReviewResult, name: string) {
  const found = result.checks.find((c) => c.name === name);
  expect(found, `check "${name}" should exist`).toBeDefined();
  return found!;
}

beforeEach(() => {
  H.execAsyncMock.mockReset();
  // Default: frontend deps + previous build are present.
  fs.mkdirSync(NODE_MODULES, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });
});

afterAll(() => {
  try {
    fs.rmSync(H.clientDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ─── datahaven-web ────────────────────────────────────────────────────────────

describe('runPreReviewGate — datahaven-web', () => {
  it('runs all four frontend checks and passes when everything is green', async () => {
    setExec();

    const result = await runPreReviewGate('datahaven-web');

    expect(result.project).toBe('datahaven-web');
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      'ESLint',
      'TypeScript',
      'Bundle Size',
      'Security Audit',
    ]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.summary).toContain('All 4 checks passed');
    expect(typeof result.duration_ms).toBe('number');

    // ESLint/TypeScript success path keeps truncated stdout/stderr details.
    expect(check(result, 'ESLint').details).toEqual({ stdout: '', stderr: '' });
    // Bundle size was estimated from the existing dist folder.
    expect(check(result, 'Bundle Size').warning).toBe('Estimated from last build: 4.2M');
    expect(check(result, 'Bundle Size').details).toEqual({ size: '4.2M' });
    // Clean audit → passing check with vuln counts in details.
    expect(check(result, 'Security Audit').details).toEqual({ high: 0, critical: 0 });
    expect(check(result, 'Security Audit').warning).toBeUndefined();
  });

  it('skips ESLint, TypeScript and Security Audit when node_modules is missing (no exec at all)', async () => {
    fs.rmSync(NODE_MODULES, { recursive: true, force: true });
    fs.rmSync(DIST, { recursive: true, force: true });
    setExec();

    const result = await runPreReviewGate('datahaven-web');

    expect(result.passed).toBe(true);
    expect(check(result, 'ESLint').warning).toBe('Skipped: node_modules not found');
    expect(check(result, 'TypeScript').warning).toBe('Skipped: node_modules not found');
    expect(check(result, 'Security Audit').warning).toBe('Skipped: node_modules not found');
    expect(check(result, 'Bundle Size').warning).toBe('Skipped: No previous build found');
    // Everything skipped before shelling out — the gate must not exec anything.
    expect(H.execAsyncMock).not.toHaveBeenCalled();
  });

  it('fails the ESLint check when the lint error output mentions errors', async () => {
    setExec({
      'npm run lint': async () => {
        throw execErr('Command failed: npm run lint — 2 errors found');
      },
    });

    const result = await runPreReviewGate('datahaven-web');

    const eslint = check(result, 'ESLint');
    expect(eslint.passed).toBe(false);
    expect(eslint.error).toContain('2 errors found');
    expect(eslint.warning).toBeUndefined();
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('❌ 1/4 checks failed');
  });

  it('treats a lint failure without "error" in the message as non-critical warnings', async () => {
    setExec({
      'npm run lint': async () => {
        throw execErr('lint finished with warnings');
      },
    });

    const result = await runPreReviewGate('datahaven-web');

    const eslint = check(result, 'ESLint');
    expect(eslint.passed).toBe(true);
    expect(eslint.warning).toBe('Warnings found but not critical');
    expect(eslint.error).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('counts "error TS\\d+" occurrences when frontend tsc fails', async () => {
    setExec({
      'tsc --noEmit': async () => {
        throw execErr('tsc failed', {
          stdout: 'a.ts(1,1): error TS2345: bad arg\nb.ts(2,2): error TS2551: typo\n',
        });
      },
    });

    const result = await runPreReviewGate('datahaven-web');

    const ts = check(result, 'TypeScript');
    expect(ts.passed).toBe(false);
    expect(ts.error).toBe('TypeScript errors found: 2 errors');
    expect(ts.details?.errorCount).toBe(2);
    expect(String(ts.details?.errorSample)).toContain('error TS2345');
    expect(result.passed).toBe(false);
  });

  it('reports bundle size as "unknown" when du output has no parseable size', async () => {
    setExec({
      'du ': async () => ({ stdout: 'unparseable-du-output', stderr: '' }),
    });

    const result = await runPreReviewGate('datahaven-web');

    const bundle = check(result, 'Bundle Size');
    expect(bundle.passed).toBe(true);
    expect(bundle.warning).toBe('Estimated from last build: unknown');
    expect(bundle.details).toEqual({ size: 'unknown' });
  });

  it('skips bundle size when there is no dist folder', async () => {
    fs.rmSync(DIST, { recursive: true, force: true });
    setExec();

    const result = await runPreReviewGate('datahaven-web');

    const bundle = check(result, 'Bundle Size');
    expect(bundle.passed).toBe(true);
    expect(bundle.warning).toBe('Skipped: No previous build found');
    // du must never have been invoked without a dist folder
    const duCalls = H.execAsyncMock.mock.calls.filter((c) => String(c[0]).startsWith('du '));
    expect(duCalls).toHaveLength(0);
  });

  it('fails the audit check when the zero-exit audit JSON reports high/critical vulns', async () => {
    setExec({
      'npm audit': async () => ({
        stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 2, critical: 1 } } }),
        stderr: '',
      }),
    });

    const result = await runPreReviewGate('datahaven-web');

    const audit = check(result, 'Security Audit');
    expect(audit.passed).toBe(false);
    expect(audit.warning).toBe('Found 1 critical, 2 high vulnerabilities');
    expect(audit.details).toEqual({ high: 2, critical: 1 });
    expect(result.passed).toBe(false);
  });

  it('parses audit JSON from error.stdout on non-zero exit: high-only is non-blocking', async () => {
    setExec({
      'npm audit': async () => {
        throw execErr('npm audit exited 1', {
          stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 3, critical: 0 } } }),
        });
      },
    });

    const result = await runPreReviewGate('datahaven-web');

    const audit = check(result, 'Security Audit');
    expect(audit.passed).toBe(true);
    expect(audit.warning).toBe('Found 3 high vulnerabilities (non-blocking)');
    expect(audit.error).toBeUndefined();
    expect(audit.details).toEqual({ high: 3, critical: 0 });
    expect(result.passed).toBe(true);
  });

  it('treats completely broken audit output as non-blocking (catch-catch)', async () => {
    setExec({
      'npm audit': async () => {
        throw execErr('npm audit blew up', { stdout: 'this is not json {{' });
      },
    });

    const result = await runPreReviewGate('datahaven-web');

    const audit = check(result, 'Security Audit');
    expect(audit.passed).toBe(true);
    expect(audit.warning).toBe('Security audit failed to run (non-blocking)');
    expect(result.passed).toBe(true);
  });

  it('reports a crashed gate (empty checks) when a check throws outside its own catch', async () => {
    // Rejecting with null makes checkESLint's catch block itself throw
    // (null.message), which propagates to the gate-level catch.
    H.execAsyncMock.mockRejectedValue(null);

    const result = await runPreReviewGate('datahaven-web');

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual([]);
    expect(result.summary).toContain('❌ Pre-review gate crashed:');
    expect(result.project).toBe('datahaven-web');
  });
});

// ─── knowledge-service ────────────────────────────────────────────────────────

describe('runPreReviewGate — knowledge-service', () => {
  it('runs the three backend checks and passes when everything is green', async () => {
    setExec({
      'npm test': async () => ({ stdout: 'Test Files  12 passed', stderr: '' }),
    });

    const result = await runPreReviewGate('knowledge-service');

    expect(result.project).toBe('knowledge-service');
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      'TypeScript (Backend)',
      'Unit Tests',
      'Security Audit (Backend)',
    ]);
    expect(result.summary).toContain('All 3 checks passed');
    expect(check(result, 'Unit Tests').details?.stdout).toContain('12 passed');
    expect(check(result, 'Security Audit (Backend)').details).toEqual({ high: 0, critical: 0 });
  });

  it('counts TS errors from error.stderr when stdout is empty on backend tsc failure', async () => {
    setExec({
      'tsc --noEmit': async () => {
        throw execErr('tsc failed', { stdout: '', stderr: 'src/x.ts(3,7): error TS2304: boom' });
      },
      'npm test': async () => ({ stdout: '', stderr: '' }),
    });

    const result = await runPreReviewGate('knowledge-service');

    const ts = check(result, 'TypeScript (Backend)');
    expect(ts.passed).toBe(false);
    expect(ts.error).toBe('TypeScript errors found: 1 errors');
    expect(ts.details?.errorCount).toBe(1);
    expect(result.passed).toBe(false);
  });

  it('counts FAIL occurrences when the unit test subset fails', async () => {
    setExec({
      'npm test': async () => {
        throw execErr('tests failed', {
          stdout: 'FAIL src/__tests__/unit/a.test.ts\nFAIL src/__tests__/unit/b.test.ts\n',
        });
      },
    });

    const result = await runPreReviewGate('knowledge-service');

    const tests = check(result, 'Unit Tests');
    expect(tests.passed).toBe(false);
    expect(tests.error).toBe('Unit tests failed: 2 test suites');
    expect(tests.details?.failedTests).toBe(2);
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('❌ 1/3 checks failed');
  });

  it('blocks on CRITICAL vulnerabilities reported via backend audit non-zero exit', async () => {
    setExec({
      'npm test': async () => ({ stdout: '', stderr: '' }),
      'npm audit': async () => {
        throw execErr('npm audit exited 1', {
          stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 1, critical: 2 } } }),
        });
      },
    });

    const result = await runPreReviewGate('knowledge-service');

    const audit = check(result, 'Security Audit (Backend)');
    expect(audit.passed).toBe(false);
    expect(audit.error).toBe('Found 2 CRITICAL vulnerabilities');
    expect(audit.warning).toBe('Found 1 high vulnerabilities (non-blocking)');
    expect(audit.details).toEqual({ high: 1, critical: 2 });
    expect(result.passed).toBe(false);
  });

  it('treats unparseable backend audit output as non-blocking (catch-catch)', async () => {
    setExec({
      'npm test': async () => ({ stdout: '', stderr: '' }),
      'npm audit': async () => {
        throw execErr('registry unreachable', { stdout: '<html>proxy error</html>' });
      },
    });

    const result = await runPreReviewGate('knowledge-service');

    const audit = check(result, 'Security Audit (Backend)');
    expect(audit.passed).toBe(true);
    expect(audit.warning).toBe('Security audit failed to run (non-blocking)');
    expect(result.passed).toBe(true);
  });
});
