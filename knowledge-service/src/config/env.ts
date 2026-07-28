/**
 * env.ts — Central, zod-validated environment configuration.
 *
 * Single entry point for scalar process.env settings: every value is declared
 * here, validated at first import, and exported as a typed object. Invalid
 * configuration fails fast at startup with a readable message instead of
 * surfacing later as a silently wrong port/URL.
 *
 * Path-like settings live in paths.ts (they need __dirname-relative defaults).
 * Secrets are exposed via the lazy `secrets` accessor below so tests and
 * runtime token reloads observe process.env mutations (values are read at
 * call time, but still only inside this config module).
 *
 * When adding a new env var, declare it here — do not read process.env inline.
 */

import 'dotenv/config';
import { z } from 'zod';

/**
 * Boolean feature flag. Semantics preserved from the historical inline reads:
 * only the literal string 'true' enables the feature; absence uses `def`.
 */
const boolFlag = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ── HTTP server ────────────────────────────────────────────────────────────
  // HTTP port. DEV convention: 3466, PROD: 3456 (see repo README).
  PORT: z.coerce.number().int().min(1).max(65535).default(3456),

  // Bind address. Default 127.0.0.1 keeps the service private; set to a
  // private interface IP (e.g. a Tailscale 100.x address) on exposed hosts.
  HOST: z.string().min(1).default('127.0.0.1'),

  // Base URL the service uses to call ITSELF (internal watchers, digests,
  // health checks). Default derives from PORT so DEV (3466) and PROD (3456)
  // both hit the right instance without extra config.
  KNOWLEDGE_SERVICE_URL: z.url().optional(),

  // ── External services ─────────────────────────────────────────────────────
  // ChromaDB server (Docker). CHROMADB_URL is a legacy alias kept for
  // backwards compatibility with older deployments.
  CHROMA_URL: z.url().default('http://localhost:8001'),
  CHROMADB_URL: z.url().optional(),

  // Knowledge-graph store (Neo4j, GraphRAG pilot — docs/plans/GRAPHRAG-PILOT.md).
  // Unset GRAPH_URL disables every graph feature (fail-safe default). The
  // password is a secret: see `secrets.graphPassword` below — embedding it in
  // the URL is rejected here, because connection URLs end up in logs.
  GRAPH_URL: z
    .url()
    .refine((u) => /^(bolt|neo4j)(\+s|\+ssc)?:\/\//.test(u), {
      message: 'GRAPH_URL must use a bolt:// or neo4j:// scheme',
    })
    .refine((u) => !/\/\/[^/]*@/.test(u), {
      message: 'GRAPH_URL must not embed credentials — use GRAPH_USER / GRAPH_PASSWORD',
    })
    .optional(),
  GRAPH_USER: z.string().min(1).default('neo4j'),
  GRAPH_DATABASE: z.string().min(1).default('neo4j'),
  // Server-side query timeout: a deep traversal on a hub node enumerates paths
  // before the row cap applies, so an unbounded query could pin the shared
  // Neo4j instance for every island.
  GRAPH_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),

  // Index-run lease TTL: how long a crashed index run's write lease blocks the
  // island before a new run may take over. Must exceed the longest real index
  // run (JoineryTech full: ~15 s) with generous margin; the VPS timer cadence
  // is 15 min, so a crash costs at most one skipped cycle. Upper bound: a
  // mistyped giant value would disable the TTL reaper (crash → island blocked
  // until manual surgery).
  GRAPH_INDEX_LEASE_TTL_MS: z.coerce.number().int().min(30000).max(3600000).default(600000),

  // DataHaven dashboard integration (missionControl cross-sync).
  DATAHAVEN_URL: z.url().default('https://datahaven.joinerytech.hu'),
  MARVEEN_URL: z.url().optional(),

  // MCP client-facing URLs (written into generated .mcp.json / tool metadata).
  MCP_SERVER_URL: z.url().optional(),
  MCP_DOCUMENTATION_URL: z.url().default('https://nexus.joinerytech.hu'),

  // Telegram webhook registration target (empty = polling mode).
  TELEGRAM_WEBHOOK_URL: z.url().optional(),

  // ── Logging (consumed by core/logger.ts) ──────────────────────────────────
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

  // ── Multi-island deployment ───────────────────────────────────────────────
  ISLAND_ID: z.string().min(1).default('spaceos'),

  // Root of the SpaceOS tree on the host (terminals, docs, config live under
  // it). No hardcoded default here: paths.ts derives a platform-independent
  // default (the checkout root) when unset. Deployments with a different
  // layout MUST set it explicitly.
  SPACEOS_ROOT: z.string().min(1).optional(),

  // ── Security ──────────────────────────────────────────────────────────────
  // Authentication mode (see auth/tokenAuth.ts). 'open' preserves local-dev
  // behavior; 'required' fails closed — mandatory for exposed deployments.
  AUTH_MODE: z.enum(['open', 'required']).default('required'),

  // Browser origins allowed to call the API. Empty means same-origin only.
  CORS_ORIGINS: z.string().default(''),

  // Number of trusted reverse-proxy hops. Zero ignores client-supplied
  // X-Forwarded-For/X-Real-IP headers.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  // ── Background service flags (bootstrap/startup.ts) ───────────────────────
  ENABLE_NIGHTWATCH: boolFlag(false),
  ENABLE_HEARTBEAT: boolFlag(false),
  ENABLE_AUTO_RESTART: boolFlag(false),
  ENABLE_MESSAGE_ROUTER: boolFlag(false),
  ENABLE_TELEGRAM_COORDINATOR: boolFlag(false),
  ENABLE_AUTONOMOUS_DEV: boolFlag(false),
  ENABLE_ROOT_MONITOR: boolFlag(false),
  ENABLE_IDEA_SCAN: boolFlag(false),
  ENABLE_PHASE_COORDINATOR: boolFlag(false),
  ENABLE_MULTI_BOT: boolFlag(false),
  // Hourly digest is opt-out: enabled unless explicitly set to 'false'.
  ENABLE_HOURLY_DIGEST: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Inbox watcher is opt-out: enabled unless explicitly set to 'false'
  // (TASK-QC-013 — the conductor CLAUDE.md mandates DEV isolation with the
  // watcher OFF; before this key the watcher started unconditionally).
  ENABLE_INBOX_WATCHER: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Pre-review gate is opt-out as well.
  PRE_REVIEW_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  // ── Scheduler intervals ───────────────────────────────────────────────────
  NIGHTWATCH_INTERVAL: z.coerce.number().int().min(1).default(120000),
  MESSAGE_ROUTER_INTERVAL: z.coerce.number().int().min(1).default(10000),
  METRICS_INTERVAL: z.coerce.number().int().min(1).default(60000),
  HEARTBEAT_INTERVAL: z.coerce.number().int().min(1).default(3600000),
  AUTONOMOUS_DEV_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(20),
  IDEA_SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(30),
  IDEA_SCAN_MIN_INTERVAL: z.coerce.number().int().min(1).default(5),
  IDEA_SCAN_MAX_INTERVAL: z.coerce.number().int().min(1).default(120),
  ROOT_MONITOR_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(60),
  PHASE_COORDINATOR_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(30),

  // ── Autonomous dev tuning (pipeline/autonomousDev.ts) ─────────────────────
  AUTONOMOUS_DEV_CONTROL_MODE: z.enum(['manual', 'autonomous', 'hybrid']).default('autonomous'),
  AUTONOMOUS_DEV_TOKEN_BUDGET: z.coerce.number().int().min(1).default(300),
  AUTONOMOUS_DEV_INCLUDE_ARCHITECT_GUIDANCE: z.enum(['auto', 'always', 'never']).default('auto'),
  AUTONOMOUS_DEV_INCLUDE_MCP_EXAMPLES: z.enum(['first-3', 'always', 'never']).default('first-3'),
  AUTONOMOUS_DEV_INCLUDE_QUEUE_GUIDANCE: z.enum(['auto', 'always', 'never']).default('auto'),
  AUTONOMOUS_DEV_PROMPT_TEMPLATE: z.enum(['base', 'verbose', 'minimal']).default('base'),

  // ── Review pipeline ───────────────────────────────────────────────────────
  // 'terminal' drives review via tmux terminals, 'api' via the Anthropic API.
  REVIEW_MODE: z.enum(['terminal', 'api']).default('api'),

  // ── Cost monitoring ───────────────────────────────────────────────────────
  DAILY_COST_BUDGET: z.coerce.number().positive().default(50),
});

export type Env = z.infer<typeof EnvSchema>;

/** Raised when the environment fails validation (used by tests). */
export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse + validate an environment map. Throws EnvValidationError with a
 * readable, per-variable message on failure. Exported for regression tests;
 * production code uses the `env` singleton below.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Empty-string values (common in commented-out .env templates) behave as
  // "unset" so defaults apply instead of failing enum/number validation.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}

let envValue: Env;
try {
  envValue = parseEnv();
} catch (err) {
  // Logger is not available here — it depends on this module. Fail fast.
  console.error('❌ [Config] Invalid environment configuration:');
  if (err instanceof EnvValidationError) {
    for (const issue of err.issues) console.error(`   ${issue}`);
  } else {
    console.error(err);
  }
  process.exit(1);
  throw err; // unreachable — keeps definite-assignment analysis happy
}

export const env = envValue;

// ── Derived values ───────────────────────────────────────────────────────────

/**
 * Base URL for the service's own HTTP API (self-calls from watchers,
 * digests and health checks). Loopback + configured PORT by default.
 */
export const SELF_BASE_URL = env.KNOWLEDGE_SERVICE_URL ?? `http://127.0.0.1:${env.PORT}`;

/** Effective ChromaDB URL (legacy CHROMADB_URL alias wins if set). */
export const CHROMA_EFFECTIVE_URL = env.CHROMADB_URL ?? env.CHROMA_URL;

/** MCP endpoint advertised to clients (generated .mcp.json etc.). */
export const MCP_SERVER_URL = env.MCP_SERVER_URL ?? `${SELF_BASE_URL}/mcp`;

// ── Dynamic reads (call-time, still confined to the config layer) ────────────

/**
 * SPACEOS_MODE is mutated by mode-detection tests at runtime, so it must be
 * observed lazily. Validation of the allowed values stays with the consumer
 * (conductor/modeDetection.ts) which defines the mode vocabulary.
 */
export function getSpaceosMode(): string | undefined {
  return process.env.SPACEOS_MODE;
}

/**
 * Secrets and tokens — read lazily so runtime reloads (auth/tokenAuth.ts)
 * and per-test env overrides keep working. Never log these values.
 *
 * NOTE: the dev-token defaults below predate this module and are preserved
 * verbatim for behavioral compatibility; TASK-QC-003 owns their removal.
 */
export const secrets = {
  get mcpAuthToken(): string {
    return process.env.MCP_AUTH_TOKEN || '';
  },
  get adminSecret(): string | undefined {
    return process.env.ADMIN_SECRET;
  },
  get terminalTokenSecret(): string | undefined {
    return process.env.TERMINAL_TOKEN_SECRET;
  },
  get dashboardAuthToken(): string {
    return process.env.DASHBOARD_AUTH_TOKEN || 'dev-token-spaceos-dashboard-2026';
  },
  get anthropicApiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY;
  },
  get voyageApiKey(): string | undefined {
    return process.env.VOYAGE_API_KEY;
  },
  get googleApiKey(): string | undefined {
    return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  },
  get telegramBotToken(): string {
    return process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '';
  },
  get telegramChatId(): string {
    return process.env.TELEGRAM_CHAT_ID || '';
  },
  get telegramWebhookSecret(): string {
    return process.env.TELEGRAM_WEBHOOK_SECRET || 'spaceos-webhook-secret-2026';
  },
  get slackBotToken(): string {
    return process.env.SLACK_BOT_TOKEN || '';
  },
  get slackChannelId(): string {
    return process.env.SLACK_CHANNEL_ID || '';
  },
  get discordBotToken(): string {
    return process.env.DISCORD_BOT_TOKEN || '';
  },
  get discordChannelId(): string {
    return process.env.DISCORD_CHANNEL_ID || '';
  },
  get datahavenToken(): string {
    return process.env.DATAHAVEN_TOKEN || 'dev-token-spaceos-dashboard-2026';
  },
  get graphPassword(): string | undefined {
    return process.env.GRAPH_PASSWORD;
  },
};
