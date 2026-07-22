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
    // (step 3, not yet implemented) — accepted by config validation but the
    // sink factory fails loudly at launch until it lands.
    mode: z.enum(['headless', 'attached']).default('headless'),
  })
  .refine((entry) => entry.models.includes(entry.default_model), {
    message: 'default_model must be present in models',
    path: ['default_model'],
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
    shutdown_grace_ms: z.coerce.number().int().min(0).default(10_000),
    mcp_server_name: z.string().regex(/^[A-Za-z0-9_-]+$/).default('spaceos-knowledge'),
    default_provider: z.enum(CLI_PROVIDERS).default('claude'),
    providers: z.partialRecord(z.enum(CLI_PROVIDERS), ProviderConfigSchema).default(DEFAULT_PROVIDERS),
    log_dir: z.string().min(1).default('logs/runner'),
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
