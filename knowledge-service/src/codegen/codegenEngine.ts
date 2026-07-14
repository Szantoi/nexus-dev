/**
 * codegenEngine.ts - SpaceOS Code Generator Engine
 * Part of ADR-050 Phase 4: MCP Tool Integration
 *
 * Provides code generation capabilities accessible via MCP tools.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const SCRIPTS_DIR = path.join(SPACEOS_ROOT, 'scripts/codegen');

export interface GenerateApiClientParams {
  source: 'kernel' | 'orchestrator';
  target: 'portal' | 'orchestrator';
  outputDir?: string;
}

export interface GenerateApiClientResult {
  success: boolean;
  target: string;
  filesGenerated: string[];
  duration: number;
  error?: string;
}

export interface GenerateComponentParams {
  name: string;
  category: 'feature' | 'ui' | 'layout';
  withTest: boolean;
  withStory: boolean;
  props?: PropertyDefinition[];
}

export interface PropertyDefinition {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface GenerateComponentResult {
  success: boolean;
  componentPath: string;
  filesCreated: string[];
  error?: string;
}

export interface GenerateModuleParams {
  name: string;
  aggregate: string;
  states: string[];
  events?: string[];
  endpoints?: EndpointDefinition[];
}

export interface EndpointDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  route: string;
  action: string;
}

export interface GenerateModuleResult {
  success: boolean;
  modulePath: string;
  filesCreated: string[];
  error?: string;
}

export interface GenerateHookParams {
  name: string;
  type: 'query' | 'mutation' | 'state' | 'effect';
  withTest: boolean;
  withCache: boolean;
  endpoint?: string;
}

export interface GenerateHookResult {
  success: boolean;
  hookPath: string;
  filesCreated: string[];
  error?: string;
}

/**
 * Execute a shell script and capture output
 */
async function execScript(
  script: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(script, args, {
      cwd: SCRIPTS_DIR,
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });

    proc.on('error', (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

/**
 * Generate API client using Orval or NSwag
 */
export async function generateApiClient(
  params: GenerateApiClientParams
): Promise<GenerateApiClientResult> {
  const startTime = Date.now();

  const targetArg = params.target === 'portal' ? 'portal' : 'orchestrator';
  const result = await execScript('./generate-api-client.sh', [targetArg]);

  const duration = Date.now() - startTime;

  if (result.exitCode !== 0) {
    return {
      success: false,
      target: params.target,
      filesGenerated: [],
      duration,
      error: result.stderr || result.stdout,
    };
  }

  // Determine generated files
  let filesGenerated: string[] = [];
  if (params.target === 'portal') {
    const genDir = path.join(SPACEOS_ROOT, 'datahaven-web/client/src/api/generated/kernel');
    try {
      const files = await fs.readdir(genDir, { recursive: true });
      filesGenerated = files.filter((f) => f.endsWith('.ts')).map((f) => `kernel/${f}`);
    } catch {
      // Directory might not exist yet
    }
  } else {
    filesGenerated = ['kernel-api-client.ts'];
  }

  return {
    success: true,
    target: params.target,
    filesGenerated,
    duration,
  };
}

/**
 * Generate React component with SpaceOS patterns
 */
export async function generateComponent(
  params: GenerateComponentParams
): Promise<GenerateComponentResult> {
  const args = [params.name, '--category', params.category];

  if (params.withTest) {
    args.push('--with-test');
  }

  if (params.withStory) {
    args.push('--with-story');
  }

  const result = await execScript('./generate-component.sh', args);

  if (result.exitCode !== 0) {
    return {
      success: false,
      componentPath: '',
      filesCreated: [],
      error: result.stderr || result.stdout,
    };
  }

  // Determine created files
  const categoryPath = params.category === 'feature' ? 'features' : params.category;
  const componentDir = path.join(
    SPACEOS_ROOT,
    `datahaven-web/client/src/components/${categoryPath}/${params.name}`
  );

  let filesCreated: string[] = [];
  try {
    const files = await fs.readdir(componentDir);
    filesCreated = files.map((f) => `${params.name}/${f}`);
  } catch {
    // Directory might not exist
  }

  return {
    success: true,
    componentPath: componentDir,
    filesCreated,
  };
}

/**
 * Generate .NET module with DDD structure
 */
export async function generateModule(
  params: GenerateModuleParams
): Promise<GenerateModuleResult> {
  const args = [params.name];

  if (params.aggregate && params.aggregate !== params.name) {
    args.push('--aggregate', params.aggregate);
  }

  if (params.states && params.states.length > 0) {
    args.push('--states', params.states.join(','));
  }

  if (params.events && params.events.length > 0) {
    args.push('--events', params.events.join(','));
  }

  if (params.endpoints && params.endpoints.length > 0) {
    args.push('--with-api');
  }

  const result = await execScript('./generate-module.sh', args);

  if (result.exitCode !== 0) {
    return {
      success: false,
      modulePath: '',
      filesCreated: [],
      error: result.stderr || result.stdout,
    };
  }

  const modulePath = path.join(
    SPACEOS_ROOT,
    `backend/spaceos-modules/spaceos-modules-${params.name.toLowerCase()}`
  );

  // List created files
  let filesCreated: string[] = [];
  try {
    const listFiles = async (dir: string, prefix = ''): Promise<string[]> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await listFiles(path.join(dir, entry.name), fullPath)));
        } else {
          files.push(fullPath);
        }
      }
      return files;
    };
    filesCreated = await listFiles(modulePath);
  } catch {
    // Directory might not exist
  }

  return {
    success: true,
    modulePath,
    filesCreated,
  };
}

/**
 * Generate React hook with SpaceOS patterns
 */
export async function generateHook(
  params: GenerateHookParams
): Promise<GenerateHookResult> {
  const args = [params.name, '--type', params.type];

  if (params.withTest) {
    args.push('--with-test');
  }

  if (params.withCache) {
    args.push('--with-cache');
  }

  if (params.endpoint) {
    args.push('--endpoint', params.endpoint);
  }

  const result = await execScript('./generate-hook.sh', args);

  if (result.exitCode !== 0) {
    return {
      success: false,
      hookPath: '',
      filesCreated: [],
      error: result.stderr || result.stdout,
    };
  }

  // Capitalize hook name for path
  const hookName = params.name.charAt(0).toUpperCase() + params.name.slice(1);
  const hookPath = path.join(
    SPACEOS_ROOT,
    `datahaven-web/client/src/hooks/use${hookName}.ts`
  );

  // Determine created files
  const filesCreated: string[] = [`use${hookName}.ts`];
  if (params.withTest) {
    filesCreated.push(`use${hookName}.test.ts`);
  }

  return {
    success: true,
    hookPath,
    filesCreated,
  };
}

/**
 * Validate TypeScript compilation after generation
 */
export async function validateTypeScript(projectPath: string): Promise<{
  success: boolean;
  errors: string[];
}> {
  const result = await execScript('npx', ['tsc', '--noEmit', '-p', projectPath]);

  if (result.exitCode === 0) {
    return { success: true, errors: [] };
  }

  // Parse TypeScript errors
  const errors = result.stdout
    .split('\n')
    .filter((line) => line.includes('error TS'))
    .slice(0, 10); // Limit to first 10 errors

  return { success: false, errors };
}

/**
 * Get code generation status
 */
export async function getCodegenStatus(): Promise<{
  orvalConfigExists: boolean;
  nswagConfigExists: boolean;
  portalApiGenerated: boolean;
  orchestratorApiGenerated: boolean;
  generatedFiles: {
    portal: number;
    orchestrator: number;
  };
}> {
  const orvalConfig = path.join(SPACEOS_ROOT, 'datahaven-web/client/orval.config.ts');
  const nswagConfig = path.join(SPACEOS_ROOT, 'backend/spaceos-orchestrator/nswag.json');
  const portalGenDir = path.join(SPACEOS_ROOT, 'datahaven-web/client/src/api/generated/kernel');
  const orchGenFile = path.join(
    SPACEOS_ROOT,
    'backend/spaceos-orchestrator/src/api/generated/kernel-api-client.ts'
  );

  const [orvalExists, nswagExists, portalGenExists, orchGenExists] = await Promise.all([
    fs.access(orvalConfig).then(() => true).catch(() => false),
    fs.access(nswagConfig).then(() => true).catch(() => false),
    fs.access(portalGenDir).then(() => true).catch(() => false),
    fs.access(orchGenFile).then(() => true).catch(() => false),
  ]);

  let portalFileCount = 0;
  if (portalGenExists) {
    try {
      const files = await fs.readdir(portalGenDir, { recursive: true });
      portalFileCount = files.filter((f) => f.toString().endsWith('.ts')).length;
    } catch {
      // Ignore
    }
  }

  return {
    orvalConfigExists: orvalExists,
    nswagConfigExists: nswagExists,
    portalApiGenerated: portalGenExists,
    orchestratorApiGenerated: orchGenExists,
    generatedFiles: {
      portal: portalFileCount,
      orchestrator: orchGenExists ? 1 : 0,
    },
  };
}
