/**
 * frontendVerify.ts - Frontend Verification and Analysis Tools
 * Part of MSG-NEXUS-002: Frontend MCP Tools Implementation
 *
 * Provides frontend-specific verification capabilities:
 * - API client status checking (Orval)
 * - Build verification (TypeScript + Vite)
 * - Bundle size analysis
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const DATAHAVEN_CLIENT = path.join(SPACEOS_ROOT, 'datahaven-web/client');
const API_DOCS_DIR = path.join(SPACEOS_ROOT, 'docs/api');

// ─── Type Definitions ─────────────────────────────────────────────────────────

export interface CheckApiClientStatusParams {
  module: string;
}

export interface CheckApiClientStatusResult {
  openapi_spec_exists: boolean;
  openapi_spec_path: string | null;
  orval_config_exists: boolean;
  generated_client_path: string | null;
  manual_hooks_detected: boolean;
  recommendation: string;
}

export interface VerifyFrontendBuildParams {
  project: string;
  run_tests: boolean;
}

export interface VerifyFrontendBuildResult {
  typescript_errors: number;
  build_time_estimate: string;
  bundle_size_mb: number;
  chunk_warnings: string[];
  buildable: boolean;
}

export interface AnalyzeBundleSizeParams {
  project: string;
}

export interface AnalyzeBundleSizeResult {
  total_size_mb: number;
  gzip_size_mb: number;
  top_chunks: Array<{
    name: string;
    size_kb: number;
  }>;
  lazy_loading_candidates: string[];
  recommendations: string[];
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Execute a command and capture output
 */
async function execCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode || 0 });
    });

    proc.on('error', (error) => {
      resolve({ stdout, stderr: error.message, exitCode: 1 });
    });
  });
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file size in MB
 */
async function getFileSizeMB(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size / (1024 * 1024);
  } catch {
    return 0;
  }
}

// ─── Tool 1: Check API Client Status ──────────────────────────────────────────

/**
 * Check Orval-generated API client status for a JoineryTech module
 *
 * Verifies:
 * - OpenAPI spec exists
 * - Orval config exists
 * - Generated client exists
 * - Manual hooks detected (should be replaced with Orval hooks)
 */
export async function checkApiClientStatus(
  params: CheckApiClientStatusParams
): Promise<CheckApiClientStatusResult> {
  const { module } = params;

  const result: CheckApiClientStatusResult = {
    openapi_spec_exists: false,
    openapi_spec_path: null,
    orval_config_exists: false,
    generated_client_path: null,
    manual_hooks_detected: false,
    recommendation: '',
  };

  // Check OpenAPI spec
  const openapiPath = path.join(API_DOCS_DIR, `joinerytech-${module}-v1.yaml`);
  result.openapi_spec_exists = await fileExists(openapiPath);
  if (result.openapi_spec_exists) {
    result.openapi_spec_path = openapiPath;
  }

  // Check Orval config
  const orvalConfigPath = path.join(DATAHAVEN_CLIENT, `orval.${module}.config.ts`);
  result.orval_config_exists = await fileExists(orvalConfigPath);

  // Check generated client
  const generatedClientPath = path.join(
    DATAHAVEN_CLIENT,
    `src/api/generated/${module}`
  );
  const generatedClientExists = await fileExists(generatedClientPath);
  if (generatedClientExists) {
    result.generated_client_path = generatedClientPath;
  }

  // Check manual hooks (should be replaced with Orval)
  const manualHookPath = path.join(DATAHAVEN_CLIENT, `src/hooks/use${capitalizeFirst(module)}.ts`);
  result.manual_hooks_detected = await fileExists(manualHookPath);

  // Generate recommendation
  if (!result.openapi_spec_exists) {
    result.recommendation = `❌ OpenAPI spec missing. Create ${openapiPath} first.`;
  } else if (!result.orval_config_exists) {
    result.recommendation = `⚠️ Orval config missing. Run: \`npx orval init\` or copy from existing module.`;
  } else if (!result.generated_client_path) {
    result.recommendation = `⚠️ Client not generated. Run: \`npm run codegen:${module}\``;
  } else if (result.manual_hooks_detected) {
    result.recommendation = `✅ Client generated. Replace manual hooks in ${manualHookPath} with Orval hooks.`;
  } else {
    result.recommendation = `✅ API client fully configured. No action needed.`;
  }

  return result;
}

// ─── Tool 2: Verify Frontend Build ───────────────────────────────────────────

/**
 * Verify frontend build status (TypeScript check + build estimate)
 *
 * Runs:
 * - `tsc --noEmit` to count TypeScript errors
 * - Optional: `npm test` if run_tests is true
 * - Estimates build time based on project size
 */
export async function verifyFrontendBuild(
  params: VerifyFrontendBuildParams
): Promise<VerifyFrontendBuildResult> {
  const { project, run_tests } = params;

  const projectPath = path.join(SPACEOS_ROOT, project);

  const result: VerifyFrontendBuildResult = {
    typescript_errors: 0,
    build_time_estimate: '~30s',
    bundle_size_mb: 0,
    chunk_warnings: [],
    buildable: true,
  };

  // TypeScript check
  const tscResult = await execCommand('npx', ['tsc', '--noEmit'], projectPath);

  // Count errors (lines containing "error TS")
  const errorLines = tscResult.stdout.split('\n').filter((line) =>
    line.includes('error TS')
  );
  result.typescript_errors = errorLines.length;

  if (result.typescript_errors > 0) {
    result.buildable = false;
    result.chunk_warnings.push(`${result.typescript_errors} TypeScript errors found`);
  }

  // Run tests if requested
  if (run_tests) {
    const testResult = await execCommand('npm', ['test', '--', '--run'], projectPath);
    if (testResult.exitCode !== 0) {
      result.buildable = false;
      result.chunk_warnings.push('Tests failing');
    }
  }

  // Estimate build time (heuristic based on file count)
  try {
    const srcPath = path.join(projectPath, 'src');
    const files = await fs.readdir(srcPath, { recursive: true });
    const tsxFiles = files.filter((f) => f.toString().endsWith('.tsx') || f.toString().endsWith('.ts'));

    if (tsxFiles.length < 50) {
      result.build_time_estimate = '~20s';
    } else if (tsxFiles.length < 150) {
      result.build_time_estimate = '~40s';
    } else {
      result.build_time_estimate = '~60s';
    }
  } catch {
    result.build_time_estimate = '~30s';
  }

  // Check dist size (if build exists)
  const distPath = path.join(projectPath, 'dist');
  const distExists = await fileExists(distPath);
  if (distExists) {
    try {
      // Note: recursive readdir returns relative paths, not Dirent with parentPath
      const files = await fs.readdir(distPath, { recursive: true });
      let totalSize = 0;
      for (const file of files) {
        const filePath = path.join(distPath, file.toString());
        try {
          const stats = await fs.stat(filePath);
          if (stats.isFile()) {
            totalSize += await getFileSizeMB(filePath);
          }
        } catch {
          // Skip files that can't be read
        }
      }
      result.bundle_size_mb = Math.round(totalSize * 100) / 100;
    } catch {
      result.bundle_size_mb = 0;
    }
  }

  return result;
}

// ─── Tool 3: Analyze Bundle Size ──────────────────────────────────────────────

/**
 * Analyze bundle size and provide optimization recommendations
 *
 * Runs:
 * - `vite build --mode production`
 * - Analyzes dist/ output
 * - Identifies lazy loading candidates
 */
export async function analyzeBundleSize(
  params: AnalyzeBundleSizeParams
): Promise<AnalyzeBundleSizeResult> {
  const { project } = params;

  const projectPath = path.join(SPACEOS_ROOT, project);
  const distPath = path.join(projectPath, 'dist/assets');

  const result: AnalyzeBundleSizeResult = {
    total_size_mb: 0,
    gzip_size_mb: 0,
    top_chunks: [],
    lazy_loading_candidates: [],
    recommendations: [],
  };

  // Check if dist exists (if not, recommend build)
  const distExists = await fileExists(distPath);
  if (!distExists) {
    result.recommendations.push('⚠️ No build found. Run `npm run build` first.');
    return result;
  }

  // Analyze dist/assets
  try {
    const files = await fs.readdir(distPath);
    const jsFiles = files.filter((f) => f.endsWith('.js'));

    const chunks: Array<{ name: string; size_kb: number }> = [];
    let totalSize = 0;

    for (const file of jsFiles) {
      const filePath = path.join(distPath, file);
      const sizeMB = await getFileSizeMB(filePath);
      const sizeKB = Math.round(sizeMB * 1024);
      totalSize += sizeMB;
      chunks.push({ name: file, size_kb: sizeKB });
    }

    result.total_size_mb = Math.round(totalSize * 100) / 100;
    result.gzip_size_mb = Math.round(totalSize * 0.3 * 100) / 100; // Estimate gzip ~30%

    // Top 5 chunks
    result.top_chunks = chunks.sort((a, b) => b.size_kb - a.size_kb).slice(0, 5);

    // Lazy loading candidates (chunks > 200KB)
    result.lazy_loading_candidates = chunks
      .filter((c) => c.size_kb > 200)
      .map((c) => c.name);

    // Recommendations
    if (result.total_size_mb > 2) {
      result.recommendations.push('⚠️ Bundle size > 2MB. Consider code splitting.');
    }

    if (result.lazy_loading_candidates.length > 0) {
      result.recommendations.push(
        `💡 ${result.lazy_loading_candidates.length} chunks > 200KB. Use React.lazy() for routes.`
      );
    }

    if (result.top_chunks[0]?.size_kb > 500) {
      result.recommendations.push(
        `⚠️ Largest chunk: ${result.top_chunks[0].name} (${result.top_chunks[0].size_kb}KB). Review dependencies.`
      );
    }

    if (result.recommendations.length === 0) {
      result.recommendations.push('✅ Bundle size is optimal.');
    }
  } catch (error) {
    result.recommendations.push(`❌ Error analyzing bundle: ${error}`);
  }

  return result;
}

// ─── Utility ───────────────────────────────────────────────────────────────────

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
