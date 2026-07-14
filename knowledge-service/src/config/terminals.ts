/**
 * terminals.ts — Dynamic terminal configuration loader
 *
 * Loads terminal configuration from config/terminals.json
 * No hardcoded terminal mappings - everything comes from config.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionMode = 'cold' | 'continuous';

export interface TerminalConfig {
  session: string;
  priority: boolean;
  model: 'opus' | 'sonnet' | 'haiku';
  description: string;
  sessionMode?: SessionMode;  // 'cold' = fresh session per task, 'continuous' = keep running
}

export interface TerminalsConfig {
  terminalsRoot: string;
  terminals: Record<string, TerminalConfig>;
  legacyAliases: Record<string, string>;
  tmuxSocket: string;
  defaultSessionMode?: SessionMode;  // Global default: 'cold' or 'continuous'
}

// ─── Config Loading ──────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '../../config/terminals.json');

let _config: TerminalsConfig | null = null;

/**
 * Load terminals configuration (cached after first load)
 */
export function loadConfig(): TerminalsConfig {
  if (_config) return _config;

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    _config = JSON.parse(raw) as TerminalsConfig;
    console.log(`[Config] Loaded ${Object.keys(_config.terminals).length} terminals from config`);
    return _config;
  } catch (err) {
    console.error(`[Config] Failed to load terminals.json: ${err}`);
    // Fallback to minimal config
    const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
    _config = {
      terminalsRoot: `${SPACEOS_ROOT}/terminals`,
      terminals: {
        root: { session: 'spaceos-root', priority: true, model: 'opus', description: 'Root' },
        conductor: { session: 'spaceos-conductor', priority: true, model: 'sonnet', description: 'Conductor' },
      },
      legacyAliases: {},
      tmuxSocket: '/tmp/spaceos.tmux',
    };
    return _config;
  }
}

/**
 * Reload configuration (for hot-reload support)
 */
export function reloadConfig(): TerminalsConfig {
  _config = null;
  return loadConfig();
}

// ─── Derived Accessors ───────────────────────────────────────────────────────

/**
 * Get all terminal names
 */
export function getTerminalNames(): string[] {
  return Object.keys(loadConfig().terminals);
}

/**
 * Get terminal config by name (resolves legacy aliases)
 */
export function getTerminal(name: string): TerminalConfig | null {
  const config = loadConfig();

  // Check direct terminal
  if (config.terminals[name]) {
    return config.terminals[name];
  }

  // Check legacy alias
  const aliasTarget = config.legacyAliases[name];
  if (aliasTarget && config.terminals[aliasTarget]) {
    return config.terminals[aliasTarget];
  }

  return null;
}

/**
 * Resolve terminal name (legacy alias → actual terminal)
 */
export function resolveTerminalName(name: string): string {
  const config = loadConfig();
  return config.legacyAliases[name] || name;
}

/**
 * Get session name for terminal
 */
export function getSessionName(terminal: string): string {
  const resolved = resolveTerminalName(terminal);
  const config = loadConfig();
  return config.terminals[resolved]?.session || `spaceos-${resolved}`;
}

/**
 * Get session → terminal mapping
 */
export function getSessionsMap(): Record<string, string> {
  const config = loadConfig();
  const map: Record<string, string> = {};

  for (const [terminal, cfg] of Object.entries(config.terminals)) {
    map[cfg.session] = terminal;
  }

  return map;
}

/**
 * Get session → workdir mapping
 */
export function getSessionWorkdirs(): Record<string, string> {
  const config = loadConfig();
  const map: Record<string, string> = {};

  for (const [terminal, cfg] of Object.entries(config.terminals)) {
    map[cfg.session] = path.join(config.terminalsRoot, terminal);
  }

  return map;
}

/**
 * Get priority terminal names
 */
export function getPriorityTerminals(): string[] {
  const config = loadConfig();
  return Object.entries(config.terminals)
    .filter(([_, cfg]) => cfg.priority)
    .map(([name, _]) => name);
}

/**
 * Get priority session names
 */
export function getPrioritySessions(): string[] {
  const config = loadConfig();
  return Object.entries(config.terminals)
    .filter(([_, cfg]) => cfg.priority)
    .map(([_, cfg]) => cfg.session);
}

/**
 * Check if session is priority
 */
export function isPrioritySession(sessionName: string): boolean {
  return getPrioritySessions().includes(sessionName);
}

/**
 * Get task-only terminals (non-priority)
 */
export function getTaskOnlyTerminals(): string[] {
  const config = loadConfig();
  return Object.entries(config.terminals)
    .filter(([_, cfg]) => !cfg.priority)
    .map(([name, _]) => name);
}

/**
 * Get inbox path for terminal
 */
export function getInboxPath(terminal: string): string {
  const config = loadConfig();
  const resolved = resolveTerminalName(terminal);
  return path.join(config.terminalsRoot, resolved, 'inbox');
}

/**
 * Get outbox path for terminal
 */
export function getOutboxPath(terminal: string): string {
  const config = loadConfig();
  const resolved = resolveTerminalName(terminal);
  return path.join(config.terminalsRoot, resolved, 'outbox');
}

/**
 * Get tmux socket path
 */
export function getTmuxSocket(): string {
  return loadConfig().tmuxSocket;
}

/**
 * Get terminals root path
 */
export function getTerminalsRoot(): string {
  return loadConfig().terminalsRoot;
}

/**
 * Get default model for terminal
 */
export function getDefaultModel(terminal: string): 'opus' | 'sonnet' | 'haiku' {
  const cfg = getTerminal(terminal);
  return cfg?.model || 'sonnet';
}

/**
 * Get session mode for terminal (cold start or continuous)
 * Priority: terminal-specific > global default > 'continuous' (backwards compat)
 */
export function getSessionMode(terminal: string): SessionMode {
  const config = loadConfig();
  const cfg = getTerminal(terminal);

  // Terminal-specific override takes precedence
  if (cfg?.sessionMode) {
    return cfg.sessionMode;
  }

  // Fall back to global default
  if (config.defaultSessionMode) {
    return config.defaultSessionMode;
  }

  // Default: continuous (backwards compatible)
  return 'continuous';
}
