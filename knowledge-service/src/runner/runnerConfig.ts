/**
 * Local autonomous-runner configuration (`config/runner.yaml`).
 *
 * Network input may select only a locally whitelisted terminal/model. CLI
 * provider, binary, sandbox and arguments are owned by this local file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { CLI_PROVIDERS } from './cliAdapter';

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
const SAFE_LOCAL_ARG = /^[^\0\r\n]*$/;
const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const FORBIDDEN_BYPASS = /dangerously-(?:bypass|skip)|danger-full-access/i;

const ProviderConfigSchema = z.object({
  binary: z.string().min(1).regex(SAFE_LOCAL_ARG),
  auth_env_var: z.string().regex(SAFE_ENV_NAME).optional(),
  sandbox: z.enum(['read-only', 'workspace-write']).default('read-only'),
  ephemeral: z.boolean().default(true),
  skip_git_repo_check: z.boolean().default(false),
  max_turns: z.coerce.number().int().min(1).optional(),
  max_budget_usd: z.coerce.number().positive().optional(),
  extra_args: z
    .array(z.string().regex(SAFE_LOCAL_ARG))
    .default([])
    .refine((args) => args.every((arg) => !FORBIDDEN_BYPASS.test(arg)), {
      message: 'dangerous permission/sandbox bypass flags are not allowed',
    }),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// Provider-specific prompt-classifier overrides for one attached terminal.
// Patterns are compiled bounded and flagless (see terminalScreen.ts); the
// PoC canary pins the exact per-version values.
const TerminalAttachedSchema = z.object({
  ready_pattern: z.string().min(1).max(200).regex(SAFE_LOCAL_ARG).optional(),
  idle_pattern: z.string().min(1).max(200).regex(SAFE_LOCAL_ARG).optional(),
});

const TerminalEntrySchema = z
  .object({
    workdir: z.string().min(1),
    provider: z.enum(CLI_PROVIDERS).optional(),
    models: z.array(z.string().regex(SAFE_MODEL)).min(1).default(['sonnet']),
    default_model: z.string().regex(SAFE_MODEL).default('sonnet'),
    additional_write_dirs: z.array(z.string().min(1)).default([]),
    credential_env: z.string().regex(SAFE_ENV_NAME).optional(),
    // Execution model for this terminal. `headless` (default) = today's
    // autonomous one-shot CLI session. `attached` = a live node-pty session
    // (step 3). Startup fails closed unless the attached assembly can build
    // a supported provider policy for the terminal.
    mode: z.enum(['headless', 'attached']).default('headless'),
    attached: TerminalAttachedSchema.optional(),
  })
  .refine((entry) => entry.models.includes(entry.default_model), {
    message: 'default_model must be present in models',
    path: ['default_model'],
  });

// Runtime guards for every attached terminal (plan §8). All values are
// bounded; the spawn/cleanup deadlines live on the PtyHost, not here.
const AttachedDefaultsSchema = z.object({
  startup_timeout_ms: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  ready_confirm_samples: z.coerce.number().int().min(1).max(100).default(2),
  idle_settle_ms: z.coerce.number().int().min(100).max(60_000).default(1_500),
  // Bounds mirror validateAttachedTerminalPolicy: a schema-valid value must
  // never crash the later runtime validation.
  idle_confirm_samples: z.coerce.number().int().min(2).max(10).default(2),
  completion_idle_timeout_ms: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  task_stall_timeout_ms: z.coerce.number().int().min(10_000).max(86_400_000).default(600_000),
  cols: z.coerce.number().int().min(20).max(500).default(120),
  rows: z.coerce.number().int().min(10).max(200).default(36),
});

const DEFAULT_PROVIDERS = {
  claude: ProviderConfigSchema.parse({ binary: 'claude', sandbox: 'workspace-write' }),
};

export const RunnerConfigSchema = z
  .object({
    server_url: z.url(),
    token: z.string().min(1).optional(),
    poll_interval_ms: z.coerce.number().int().min(500).default(5000),
    sse_enabled: z.boolean().default(true),
    max_backoff_ms: z.coerce.number().int().min(1000).default(300_000),
    max_attempts: z.coerce.number().int().min(1).default(3),
    retry_cooldown_ms: z.coerce.number().int().min(0).default(600_000),
    quarantine_existing_on_first_start: z.boolean().default(true),
    session_timeout_ms: z.coerce.number().int().min(1000).default(3_600_000),
    max_output_bytes: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
    shutdown_grace_ms: z.coerce.number().int().min(1).max(120_000).default(20_000),
    mcp_server_name: z.string().regex(/^[A-Za-z0-9_-]+$/).default('spaceos-knowledge'),
    default_provider: z.enum(CLI_PROVIDERS).default('claude'),
    providers: z.partialRecord(z.enum(CLI_PROVIDERS), ProviderConfigSchema).default(DEFAULT_PROVIDERS),
    log_dir: z.string().min(1).default('logs/runner'),
    // The island this runner expects its terminals to belong to. The server
    // derives the authoritative island from the token; this local declaration
    // scopes completion-receipt validation and the cursor namespace, so a
    // rotated credential can never silently inherit another island's cursor.
    expected_island_id: z.string().min(1).regex(SAFE_LOCAL_ARG).optional(),
    attached_defaults: AttachedDefaultsSchema.prefault({}),
    terminals: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), TerminalEntrySchema),
  })
  .superRefine((config, context) => {
    const usedProviders = new Set([
      config.default_provider,
      ...Object.values(config.terminals)
        .map((terminal) => terminal.provider)
        .filter((provider): provider is (typeof CLI_PROVIDERS)[number] => Boolean(provider)),
    ]);
    for (const provider of usedProviders) {
      if (!config.providers[provider]) {
        context.addIssue({
          code: 'custom',
          path: ['providers', provider],
          message: `provider ${provider} is used but not configured`,
        });
      }
    }
    const attachedTerminals = Object.entries(config.terminals)
      .filter(([, entry]) => entry.mode === 'attached')
      .map(([name]) => name);
    if (attachedTerminals.length > 0 && !config.expected_island_id) {
      context.addIssue({
        code: 'custom',
        path: ['expected_island_id'],
        message:
          `expected_island_id is required when attached terminals exist (${attachedTerminals.join(', ')})`,
      });
    }
  });

export type RunnerConfig = z.infer<typeof RunnerConfigSchema> & { token: string };
export type TerminalRunnerConfig = RunnerConfig['terminals'][string];

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
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid runner config (${file}):\n${issues}`);
  }

  const token = process.env.RUNNER_TOKEN || parsed.data.token;
  if (!token) {
    throw new Error(
      'Runner token missing: set RUNNER_TOKEN or the `token` field in runner.yaml.',
    );
  }

  if (Object.keys(parsed.data.terminals).length === 0) {
    throw new Error('Runner config has no terminals — nothing to serve.');
  }

  return { ...parsed.data, token };
}
