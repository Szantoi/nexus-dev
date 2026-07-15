/**
 * env.ts — Central, zod-validated environment configuration.
 *
 * Single entry point for scalar process.env settings: every value is declared
 * here, validated at first import, and exported as a typed object. Invalid
 * configuration fails fast at startup with a readable message instead of
 * surfacing later as a silently wrong port/URL.
 *
 * Path-like settings live in paths.ts (they need __dirname-relative defaults).
 * When adding a new env var, declare it here — do not read process.env inline.
 */

import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // HTTP port. DEV convention: 3466, PROD: 3456 (see repo README).
  PORT: z.coerce.number().int().min(1).max(65535).default(3456),

  // ChromaDB server (Docker).
  CHROMA_URL: z.url().default('http://localhost:8001'),

  // Logging (consumed by core/logger.ts).
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

  // Multi-island deployment.
  ISLAND_ID: z.string().min(1).default('spaceos'),

  // Root of the SpaceOS tree on the host (terminals, docs, nexus live under it).
  SPACEOS_ROOT: z.string().min(1).default('/opt/spaceos'),

  // Authentication mode (see auth/tokenAuth.ts). 'open' preserves local-dev
  // behavior; 'required' fails closed — mandatory for exposed deployments.
  AUTH_MODE: z.enum(['open', 'required']).default('open'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Logger is not available here — it depends on this module.
  console.error('❌ [Config] Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
