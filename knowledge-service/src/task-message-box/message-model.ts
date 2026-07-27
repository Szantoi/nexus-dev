/**
 * Canonical message model (DDD domain module).
 *
 * WHY: the codebase grew two message stores with divergent status vocabularies
 * (messageRegistry: 12 UPPERCASE; task-message-box: 6 lowercase) plus a central
 * Postgres transport (pending/delivered/ack). That drift is the "DONE vs done vs
 * Completed" black-box problem. This module is the single, config-driven authority
 * for the canonical vocabulary, its lifecycle state machine, and every legacy →
 * canonical mapping. NOTHING here is hardcoded — it all loads from
 * config/message-model.yaml (env-overridable via MESSAGE_MODEL_CONFIG_PATH), so the
 * model can be extended/changed in config without touching code.
 *
 * Two independent dimensions (deliberately separated):
 *   - type   = the message's PURPOSE
 *   - status = the message's LIFECYCLE
 */
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { MESSAGE_MODEL_CONFIG_PATH } from '../config/paths';
import { logger } from '../core/logger';
import { ConfigurationError } from '../core/errors';

const log = (msg: string) => logger.info(`[MessageModel] ${msg}`);
const warn = (msg: string) => logger.warn(`[MessageModel] ⚠️ ${msg}`);

// ─── Config shape ─────────────────────────────────────────────────────────────

interface MessageModelConfig {
  version: string;
  types: string[];
  default_type: string;
  statuses: string[];
  default_status: string;
  transitions: Record<string, string[]>;
  legacy_status_map: Record<string, string>;
  central_status_map: Record<string, string>;
  legacy_type_map: Record<string, string>;
}

// Loaded once, lazily, and cached. Config is small and read-mostly.
let cached: MessageModelConfig | null = null;

function loadConfig(): MessageModelConfig {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(MESSAGE_MODEL_CONFIG_PATH, 'utf-8');
    const cfg = yaml.load(raw) as MessageModelConfig;
    if (!cfg || !Array.isArray(cfg.types) || !Array.isArray(cfg.statuses)) {
      throw new ConfigurationError('message-model.yaml missing required "types"/"statuses" arrays');
    }
    cached = cfg;
    log(`Loaded canonical model v${cfg.version}: ${cfg.types.length} types, ${cfg.statuses.length} statuses, ` +
        `${Object.keys(cfg.transitions || {}).length} transition rules from ${MESSAGE_MODEL_CONFIG_PATH}`);
    return cfg;
  } catch (err) {
    // Fail loud but keep a safe built-in fallback so the service can still boot.
    warn(`Could not load ${MESSAGE_MODEL_CONFIG_PATH}: ${(err as Error).message}. Using built-in canonical fallback.`);
    cached = FALLBACK;
    return cached;
  }
}

// Minimal built-in fallback ONLY for the case the config file is missing.
// The config file is the real source of truth; this just keeps the service alive.
const FALLBACK: MessageModelConfig = {
  version: '0-fallback',
  types: ['task', 'question', 'response', 'info'],
  default_type: 'info',
  statuses: ['unread', 'read', 'in_progress', 'completed', 'blocked', 'archived'],
  default_status: 'unread',
  transitions: {
    unread: ['read', 'in_progress', 'archived'],
    read: ['in_progress', 'completed', 'blocked', 'archived'],
    in_progress: ['completed', 'blocked', 'read', 'archived'],
    blocked: ['in_progress', 'read', 'archived'],
    completed: ['archived'],
    archived: [],
  },
  legacy_status_map: {},
  central_status_map: {},
  legacy_type_map: {},
};

/** For tests / hot-reload: forget the cached config so the next call re-reads it. */
export function reloadMessageModel(): void {
  cached = null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function canonicalTypes(): string[] { return loadConfig().types; }
export function canonicalStatuses(): string[] { return loadConfig().statuses; }
export function defaultType(): string { return loadConfig().default_type; }
export function defaultStatus(): string { return loadConfig().default_status; }

export function isCanonicalStatus(s: string): boolean { return loadConfig().statuses.includes(s); }
export function isCanonicalType(t: string): boolean { return loadConfig().types.includes(t); }

/**
 * Is `from -> to` an allowed lifecycle transition per the configured state machine?
 * A no-op transition (from === to) is always allowed (idempotent re-assert).
 */
export function isValidTransition(from: string, to: string): boolean {
  if (from === to) return true;
  const cfg = loadConfig();
  const allowed = cfg.transitions[from];
  if (!allowed) {
    warn(`Unknown source status '${from}' — no transition rule; rejecting transition to '${to}'.`);
    return false;
  }
  return allowed.includes(to);
}

/** Map a legacy messageRegistry status (any case) to the canonical status. */
export function mapLegacyStatus(legacy: string): string {
  const cfg = loadConfig();
  if (cfg.statuses.includes(legacy)) return legacy; // already canonical
  const mapped = cfg.legacy_status_map[legacy] ?? cfg.legacy_status_map[legacy?.toUpperCase?.()];
  if (!mapped) {
    warn(`No legacy_status_map entry for '${legacy}' — defaulting to '${cfg.default_status}'.`);
    return cfg.default_status;
  }
  return mapped;
}

/** Map a central Postgres transport status (pending/delivered/ack) to canonical. */
export function mapCentralStatus(central: string): string {
  const cfg = loadConfig();
  const mapped = cfg.central_status_map[central];
  if (!mapped) {
    warn(`No central_status_map entry for '${central}' — defaulting to '${cfg.default_status}'.`);
    return cfg.default_status;
  }
  return mapped;
}

/** Map a legacy message type to the canonical type. */
export function mapLegacyType(legacy: string): string {
  const cfg = loadConfig();
  if (cfg.types.includes(legacy)) return legacy; // already canonical
  const mapped = cfg.legacy_type_map[legacy];
  if (!mapped) {
    warn(`No legacy_type_map entry for '${legacy}' — defaulting to '${cfg.default_type}'.`);
    return cfg.default_type;
  }
  return mapped;
}
