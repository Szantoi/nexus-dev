/**
 * runnerConfig.ts — Local runner configuration (config/runner.yaml).
 *
 * The runner is the LOCAL counterpart of the server-side InboxWatcher:
 * it polls the central knowledge-service for UNREAD tasks and starts
 * local Claude Code sessions for them (pull model — the local machine
 * only ever opens outbound connections).
 *
 * SECURITY INVARIANTS:
 * - Everything that can end up on a command line comes from THIS local
 *   config file (written by the machine owner) or a closed enum — never
 *   from network data. Network data only selects WHICH whitelisted
 *   terminal/model to use and is validated against strict patterns.
 * - The runner refuses to start without a token (fail closed): it is
 *   built to talk to an AUTH_MODE=required server.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

// Chars safe to place in argv even when Windows forces shell:true for .cmd
// shims: no whitespace, quotes, or cmd.exe metacharacters (& | < > ^ % !).
const SAFE_ARG = /^[A-Za-z0-9@=_:.,+\\/-]+$/;

export const MODELS = ['haiku', 'sonnet', 'opus'] as const;
export type ModelName = (typeof MODELS)[number];

const TerminalEntrySchema = z.object({
  // Local working directory the Claude session starts in.
  workdir: z.string().min(1),
  // Models this terminal may be started with; a task requesting anything
  // else falls back to default_model.
  models: z.array(z.enum(MODELS)).min(1).default(['sonnet']),
  default_model: z.enum(MODELS).default('sonnet'),
});

export const RunnerConfigSchema = z.object({
  // Central knowledge-service (VPS or local DEV on 3466).
  server_url: z.url(),
  // Prefer the RUNNER_TOKEN env var; this field is a fallback for setups
  // where the whole file is secret-managed. runner.yaml is gitignored.
  token: z.string().min(1).optional(),
  poll_interval_ms: z.coerce.number().int().min(500).default(5000),
  // Second-level wake-up via the server's SSE endpoint; the poll stays on
  // as the fallback either way.
  sse_enabled: z.boolean().default(true),
  // Backoff cap when the server is unreachable.
  max_backoff_ms: z.coerce.number().int().min(1000).default(300_000),
  // A task that stays UNREAD (session died before ack) is retried at most
  // max_attempts times, waiting retry_cooldown_ms between attempts.
  max_attempts: z.coerce.number().int().min(1).default(3),
  retry_cooldown_ms: z.coerce.number().int().min(0).default(600_000),
  claude_bin: z.string().regex(SAFE_ARG).default('claude'),
  // Extra Claude CLI args (e.g. --permission-mode=plan). Validated so no
  // shell metacharacter can hide here even on Windows.
  extra_args: z.array(z.string().regex(SAFE_ARG)).default([]),
  // Session stdout/stderr logs + persisted dedup state live here.
  log_dir: z.string().min(1).default('logs/runner'),
  // Terminals THIS machine serves — the whitelist. A task addressed to any
  // other terminal is invisible to this runner.
  terminals: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), TerminalEntrySchema),
});

export type RunnerConfig = z.infer<typeof RunnerConfigSchema> & {
  // Resolved token (env wins over YAML) — always present after load.
  token: string;
};

export function getRunnerConfigPath(): string {
  return (
    process.env.RUNNER_CONFIG_PATH ||
    path.join(__dirname, '..', '..', 'config', 'runner.yaml')
  );
}

export function loadRunnerConfig(configPath?: string): RunnerConfig {
  const file = configPath || getRunnerConfigPath();

  if (!fs.existsSync(file)) {
    throw new Error(
      `Runner config not found: ${file}\n` +
        'Copy config/runner.yaml.example to config/runner.yaml and fill it in.',
    );
  }

  const raw = yaml.load(fs.readFileSync(file, 'utf-8'));
  const parsed = RunnerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid runner config (${file}):\n${issues}`);
  }

  const token = process.env.RUNNER_TOKEN || parsed.data.token;
  if (!token) {
    // Fail closed: a runner without identity must not start.
    throw new Error(
      'Runner token missing: set RUNNER_TOKEN or the `token` field in runner.yaml.',
    );
  }

  if (Object.keys(parsed.data.terminals).length === 0) {
    throw new Error('Runner config has no terminals — nothing to serve.');
  }

  return { ...parsed.data, token };
}
