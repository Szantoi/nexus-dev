#!/usr/bin/env node
/**
 * runner-start.mjs — Cross-platform local-runner launcher.
 *
 * - Loads knowledge-service/.env.runner (then .env.dev as fallback) into
 *   the environment (real env always wins)
 * - Runs the TypeScript entry directly via tsx (no build step needed)
 *
 * Usage: node scripts/runner-start.mjs
 * Needs: config/runner.yaml (copy from runner.yaml.example) + RUNNER_TOKEN.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serviceDir = join(repoRoot, 'knowledge-service');

const env = { ...process.env };

let envLoaded = false;
for (const candidate of ['.env.runner', '.env.dev']) {
  const envFile = join(serviceDir, candidate);
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env) && !(key in env)) env[key] = value;
  }
  console.log(`[runner-start] Loaded ${envFile}`);
  envLoaded = true;
  break;
}

// Env files are local runtime files (git-ignored). The runner can still run on
// real environment variables alone, so a missing file is a warning, not a
// hard error — but the fix command is printed for clarity.
if (!envLoaded) {
  console.warn('[runner-start] WARNING: no .env.runner or .env.dev found in knowledge-service/.');
  console.warn('[runner-start] Using process environment only. To create the dev env file:');
  console.warn(
    process.platform === 'win32'
      ? '[runner-start]   Copy-Item knowledge-service\\.env.dev.example knowledge-service\\.env.dev'
      : '[runner-start]   cp knowledge-service/.env.dev.example knowledge-service/.env.dev'
  );
}

console.log('[runner-start] Starting local runner');

// Windows: npx is a .cmd shim (needs a shell); args are joined by hand to
// avoid DEP0190 — every part is a fixed literal.
const child = process.platform === 'win32'
  ? spawn('npx.cmd tsx src/runner/main.ts', [], { cwd: serviceDir, env, stdio: 'inherit', shell: true })
  : spawn('npx', ['tsx', 'src/runner/main.ts'], { cwd: serviceDir, env, stdio: 'inherit' });

child.on('exit', code => process.exit(code ?? 0));
