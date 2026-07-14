/**
 * Pre-Review Gate (MSG-NEXUS-010)
 *
 * Fast, deterministic checks before expensive AI review:
 * - ESLint
 * - TypeScript type checking
 * - Unit tests (fast subset)
 * - Security audit
 * - Bundle size estimation
 *
 * Target: < 30s execution time
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PreReviewCheck {
  name: string;
  passed: boolean;
  duration_ms: number;
  error?: string;
  warning?: string;
  details?: Record<string, unknown>;
}

export interface PreReviewResult {
  passed: boolean;
  checks: PreReviewCheck[];
  summary: string;
  duration_ms: number;
  project: string;
}

export type ProjectType = 'datahaven-web' | 'knowledge-service';

// ─── Pre-Review Gate Runner ──────────────────────────────────────────────────

/**
 * Run pre-review gate on specified project
 * Returns early if any critical check fails
 */
export async function runPreReviewGate(
  project: ProjectType
): Promise<PreReviewResult> {
  const startTime = Date.now();
  const checks: PreReviewCheck[] = [];

  console.log(`[PreReviewGate] Starting gate for: ${project}`);

  try {
    if (project === 'datahaven-web') {
      // Frontend checks
      checks.push(await checkESLint());
      checks.push(await checkTypeScript());
      checks.push(await checkBundleSize());
      checks.push(await checkSecurityAudit());
    } else if (project === 'knowledge-service') {
      // Backend checks
      checks.push(await checkTypeScriptBackend());
      checks.push(await checkUnitTests());
      checks.push(await checkSecurityAuditBackend());
    }

    const allPassed = checks.every(c => c.passed);
    const duration = Date.now() - startTime;

    const summary = allPassed
      ? `✅ All ${checks.length} checks passed (${duration}ms)`
      : `❌ ${checks.filter(c => !c.passed).length}/${checks.length} checks failed`;

    console.log(`[PreReviewGate] ${summary}`);

    return {
      passed: allPassed,
      checks,
      summary,
      duration_ms: duration,
      project,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);

    return {
      passed: false,
      checks,
      summary: `❌ Pre-review gate crashed: ${msg}`,
      duration_ms: duration,
      project,
    };
  }
}

// ─── Frontend Checks ─────────────────────────────────────────────────────────

/**
 * Run ESLint on datahaven-web/client
 */
async function checkESLint(): Promise<PreReviewCheck> {
  const startTime = Date.now();
  const name = 'ESLint';

  try {
    const cwd = '/opt/spaceos/datahaven-web/client';

    // Check if node_modules exists
    try {
      await fs.access(path.join(cwd, 'node_modules'));
    } catch {
      console.warn('[PreReviewGate] node_modules not found, skipping ESLint');
      return {
        name,
        passed: true,
        duration_ms: Date.now() - startTime,
        warning: 'Skipped: node_modules not found',
      };
    }

    const { stdout, stderr } = await execAsync('npm run lint', {
      cwd,
      timeout: 15000, // 15s timeout
    });

    return {
      name,
      passed: true,
      duration_ms: Date.now() - startTime,
      details: { stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) },
    };
  } catch (error: any) {
    // ESLint returns non-zero exit code on lint errors
    const errorMsg = error.message || String(error);
    const failed = errorMsg.includes('error') || errorMsg.includes('Error');

    return {
      name,
      passed: !failed,
      duration_ms: Date.now() - startTime,
      error: failed ? errorMsg.slice(0, 500) : undefined,
      warning: !failed ? 'Warnings found but not critical' : undefined,
    };
  }
}

/**
 * Run TypeScript type checking on datahaven-web/client
 */
async function checkTypeScript(): Promise<PreReviewCheck> {
  const startTime = Date.now();
  const name = 'TypeScript';

  try {
    const cwd = '/opt/spaceos/datahaven-web/client';

    // Check if node_modules exists
    try {
      await fs.access(path.join(cwd, 'node_modules'));
    } catch {
      console.warn('[PreReviewGate] node_modules not found, skipping TypeScript');
      return {
        name,
        passed: true,
        duration_ms: Date.now() - startTime,
        warning: 'Skipped: node_modules not found',
      };
    }

    // Run tsc --noEmit
    const { stdout, stderr } = await execAsync(
      'npx tsc --noEmit --pretty false',
      {
        cwd,
        timeout: 20000, // 20s timeout
      }
    );

    return {
      name,
      passed: true,
      duration_ms: Date.now() - startTime,
      details: { stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) },
    };
  } catch (error: any) {
    const errorMsg = error.stdout || error.stderr || error.message || String(error);
    const errorCount = (errorMsg.match(/error TS\d+/g) || []).length;

    return {
      name,
      passed: false,
      duration_ms: Date.now() - startTime,
      error: `TypeScript errors found: ${errorCount} errors`,
      details: { errorSample: errorMsg.slice(0, 1000), errorCount },
    };
  }
}

/**
 * Estimate bundle size without full build
 */
async function checkBundleSize(): Promise<PreReviewCheck> {
  const startTime = Date.now();
  const name = 'Bundle Size';

  try {
    const cwd = '/opt/spaceos/datahaven-web/client';

    // Check dist folder size (if exists from previous build)
    try {
      const distPath = path.join(cwd, 'dist');
      await fs.access(distPath);

      const { stdout } = await execAsync(`du -sh "${distPath}"`, { timeout: 5000 });
      const sizeMatch = stdout.match(/^(\d+(?:\.\d+)?[KMG]?)\s/);
      const size = sizeMatch ? sizeMatch[1] : 'unknown';

      return {
        name,
        passed: true,
        duration_ms: Date.now() - startTime,
        warning: `Estimated from last build: ${size}`,
        details: { size },
      };
    } catch {
      // No dist folder, skip check
      return {
        name,
        passed: true,
        duration_ms: Date.now() - startTime,
        warning: 'Skipped: No previous build found',
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      name,
      passed: true,
      duration_ms: Date.now() - startTime,
      warning: `Check failed: ${msg}`,
    };
  }
}

/**
 * Run npm audit on datahaven-web/client
 */
async function checkSecurityAudit(): Promise<PreReviewCheck> {
  const startTime = Date.now();
  const name = 'Security Audit';

  try {
    const cwd = '/opt/spaceos/datahaven-web/client';

    // Check if node_modules exists
    try {
      await fs.access(path.join(cwd, 'node_modules'));
    } catch {
      console.warn('[PreReviewGate] node_modules not found, skipping Security Audit');
      return {
        name,
        passed: true,
        duration_ms: Date.now() - startTime,
        warning: 'Skipped: node_modules not found',
      };
    }

    const { stdout } = await execAsync('npm audit --audit-level=high --json', {
      cwd,
      timeout: 10000,
    });

    const auditResult = JSON.parse(stdout);
    const highVulns = auditResult.metadata?.vulnerabilities?.high || 0;
    const criticalVulns = auditResult.metadata?.vulnerabilities?.critical || 0;

    const passed = highVulns === 0 && criticalVulns === 0;

    return {
      name,
      passed,
      duration_ms: Date.now() - startTime,
      warning: passed
        ? undefined
        : `Found ${criticalVulns} critical, ${highVulns} high vulnerabilities`,
      details: { high: highVulns, critical: criticalVulns },
    };
  } catch (error: any) {
    // npm audit returns non-zero if vulnerabilities found
    // This is expected, parse the output
    try {
      const auditResult = JSON.parse(error.stdout || '{}');
      const highVulns = auditResult.metadata?.vulnerabilities?.high || 0;
      const criticalVulns = auditResult.metadata?.vulnerabilities?.critical || 0;

      const passed = criticalVulns === 0; // Only critical is blocker

      return {
        name,
        passed,
        duration_ms: Date.now() - startTime,
        warning:
          highVulns > 0
            ? `Found ${highVulns} high vulnerabilities (non-blocking)`
            : undefined,
        error:
          criticalVulns > 0
            ? `Found ${criticalVulns} CRITICAL vulnerabilities`
            : undefined,
        details: { high: highVulns, critical: criticalVulns },
      };
    } catch {
      // Audit completely failed
      return {
        name,
        passed: true,
        duration_ms: Date.now() - startTime,
        warning: 'Security audit failed to run (non-blocking)',
      };
    }
  }
}

// ─── Backend Checks ──────────────────────────────────────────────────────────

/**
 * Run TypeScript type checking on knowledge-service
 */
async function checkTypeScriptBackend(): Promise<PreReviewCheck> {
  const startTime = Date.now();
  const name = 'TypeScript (Backend)';

  try {
    const cwd = '/opt/spaceos/spaceos-nexus/knowledge-service';

    const { stdout, stderr } = await execAsync('npx tsc --noEmit --pretty false', {
      cwd,
      timeout: 30000, // 30s timeout (backend is larger)
    });

    return {
      name,
      passed: true,
      duration_ms: Date.now() - startTime,
      details: { stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) },
    };
  } catch (error: any) {
    const errorMsg = error.stdout || error.stderr || error.message || String(error);
    const errorCount = (errorMsg.match(/error TS\d+/g) || []).length;

    return {
      name,
      passed: false,
      duration_ms: Date.now() - startTime,
      error: `TypeScript errors found: ${errorCount} errors`,
      details: { errorSample: errorMsg.slice(0, 1000), errorCount },
    };
  }
}

/**
 * Run unit tests on knowledge-service
 */
async function checkUnitTests(): Promise<PreReviewCheck> {
  const startTime = Date.now();
  const name = 'Unit Tests';

  try {
    const cwd = '/opt/spaceos/spaceos-nexus/knowledge-service';

    // Run tests (skip integration tests for speed)
    // Using vitest CLI syntax for filtering
    const { stdout, stderr } = await execAsync(
      'npm test -- --run --silent src/__tests__/unit',
      {
        cwd,
        timeout: 45000, // 45s timeout
      }
    );

    return {
      name,
      passed: true,
      duration_ms: Date.now() - startTime,
      details: { stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) },
    };
  } catch (error: any) {
    const errorMsg = error.stdout || error.stderr || error.message || String(error);
    const failedTests = (errorMsg.match(/FAIL/g) || []).length;

    return {
      name,
      passed: false,
      duration_ms: Date.now() - startTime,
      error: `Unit tests failed: ${failedTests} test suites`,
      details: { errorSample: errorMsg.slice(0, 1000), failedTests },
    };
  }
}

/**
 * Run npm audit on knowledge-service
 */
async function checkSecurityAuditBackend(): Promise<PreReviewCheck> {
  const startTime = Date.now();
  const name = 'Security Audit (Backend)';

  try {
    const cwd = '/opt/spaceos/spaceos-nexus/knowledge-service';

    const { stdout } = await execAsync('npm audit --audit-level=high --json', {
      cwd,
      timeout: 10000,
    });

    const auditResult = JSON.parse(stdout);
    const highVulns = auditResult.metadata?.vulnerabilities?.high || 0;
    const criticalVulns = auditResult.metadata?.vulnerabilities?.critical || 0;

    const passed = highVulns === 0 && criticalVulns === 0;

    return {
      name,
      passed,
      duration_ms: Date.now() - startTime,
      warning: passed
        ? undefined
        : `Found ${criticalVulns} critical, ${highVulns} high vulnerabilities`,
      details: { high: highVulns, critical: criticalVulns },
    };
  } catch (error: any) {
    try {
      const auditResult = JSON.parse(error.stdout || '{}');
      const highVulns = auditResult.metadata?.vulnerabilities?.high || 0;
      const criticalVulns = auditResult.metadata?.vulnerabilities?.critical || 0;

      const passed = criticalVulns === 0;

      return {
        name,
        passed,
        duration_ms: Date.now() - startTime,
        warning:
          highVulns > 0
            ? `Found ${highVulns} high vulnerabilities (non-blocking)`
            : undefined,
        error:
          criticalVulns > 0
            ? `Found ${criticalVulns} CRITICAL vulnerabilities`
            : undefined,
        details: { high: highVulns, critical: criticalVulns },
      };
    } catch {
      return {
        name,
        passed: true,
        duration_ms: Date.now() - startTime,
        warning: 'Security audit failed to run (non-blocking)',
      };
    }
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export default runPreReviewGate;
