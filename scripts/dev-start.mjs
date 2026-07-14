#!/usr/bin/env node
/**
 * dev-start.mjs — Cross-platform DEV server launcher (replaces dev-start.sh).
 *
 * - Loads knowledge-service/.env.dev into the environment
 * - Enforces the DEV port (3466) unless PORT is set explicitly
 * - Runs the TypeScript entry directly via tsx (no build step needed)
 *
 * Usage: node scripts/dev-start.mjs
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serviceDir = join(repoRoot, 'knowledge-service');
const envFile = join(serviceDir, '.env.dev');

const env = { ...process.env };

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) env[key] = value; // real env wins over .env.dev
  }
  console.log(`[dev-start] Loaded ${envFile}`);
} else {
  console.warn(`[dev-start] WARNING: ${envFile} not found, using process env only`);
}

env.PORT = env.PORT || '3466';
env.NODE_ENV = env.NODE_ENV || 'development';

console.log(`[dev-start] Starting knowledge-service on port ${env.PORT} (DEV)`);

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsx', 'src/server.ts'],
  { cwd: serviceDir, env, stdio: 'inherit', shell: process.platform === 'win32' }
);

child.on('exit', code => process.exit(code ?? 0));
