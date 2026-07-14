/**
 * Terminal Configuration Loader
 *
 * Loads terminal definitions from YAML config with auto-reload.
 * Provides role-based access control and alias resolution.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TerminalType = 'coordinator' | 'support' | 'reviewer' | 'worker';

export interface TerminalDefinition {
  name: string;
  description: string;
  type: TerminalType;
  priority: boolean;
  model: 'opus' | 'sonnet' | 'haiku';
  session: string;
  directory: string;
  aliases: string[];
  canControl: string[];  // Terminal names or "@workers", "@support", "*"
  isSystemRole: boolean;
}

export interface TerminalGroup {
  name: string;
  members: string[];
}

export interface TokenBudget {
  daily: number;
  hourly: number;
}

export interface SchedulingWindow {
  name: string;
  description: string;
  time: string;
  allowed: string[];  // Terminal names or group refs like "@workers"
}

interface TerminalsConfig {
  version?: string;
  updated?: string;
  system_roles?: Record<string, any>;
  terminals?: Record<string, any>;
  groups?: Record<string, string[]>;
  scheduling?: Record<string, any>;
  token_budgets?: Record<string, { daily: number; hourly: number }>;
}

// ─── State ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '../config/terminals.yaml');
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const TERMINALS_DIR = process.env.TERMINALS_PATH || `${SPACEOS_ROOT}/terminals`;
const DEFAULT_TERMINALS_DIR = TERMINALS_DIR;

// Loaded configuration
let terminals: Map<string, TerminalDefinition> = new Map();
let aliasMap: Map<string, string> = new Map();  // alias -> canonical name
let groups: Map<string, string[]> = new Map();
let tokenBudgets: Map<string, TokenBudget> = new Map();
let schedulingWindows: Map<string, SchedulingWindow> = new Map();
let configLoaded = false;

// ─── Config Loading ──────────────────────────────────────────────────────────

/**
 * Load terminals configuration from YAML
 */
export function loadTerminalConfig(): void {
  try {
    const configContent = require('fs').readFileSync(CONFIG_PATH, 'utf-8');
    const config: TerminalsConfig = yaml.load(configContent) as TerminalsConfig;

    const newTerminals = new Map<string, TerminalDefinition>();
    const newAliasMap = new Map<string, string>();
    const newGroups = new Map<string, string[]>();
    const newTokenBudgets = new Map<string, TokenBudget>();
    const newSchedulingWindows = new Map<string, SchedulingWindow>();

    // Process system roles
    if (config.system_roles) {
      for (const [name, def] of Object.entries(config.system_roles)) {
        const terminal: TerminalDefinition = {
          name,
          description: def.description || '',
          type: def.type || 'coordinator',
          priority: def.priority ?? false,
          model: def.model || 'sonnet',
          session: def.session || `spaceos-${name}`,
          directory: path.join(DEFAULT_TERMINALS_DIR, name),
          aliases: def.aliases || [],
          canControl: parseCanControl(def.can_control),
          isSystemRole: true,
        };

        newTerminals.set(name, terminal);

        // Register aliases
        newAliasMap.set(name.toLowerCase(), name);
        for (const alias of terminal.aliases) {
          newAliasMap.set(alias.toLowerCase(), name);
        }
      }
    }

    // Process custom terminals
    if (config.terminals) {
      for (const [name, def] of Object.entries(config.terminals)) {
        const terminal: TerminalDefinition = {
          name,
          description: def.description || '',
          type: def.type || 'worker',
          priority: def.priority ?? false,
          model: def.model || 'sonnet',
          session: def.session || `spaceos-${name}`,
          directory: def.directory || path.join(DEFAULT_TERMINALS_DIR, name),
          aliases: def.aliases || [],
          canControl: [name],  // Workers can only control themselves
          isSystemRole: false,
        };

        newTerminals.set(name, terminal);

        // Register aliases
        newAliasMap.set(name.toLowerCase(), name);
        for (const alias of terminal.aliases) {
          newAliasMap.set(alias.toLowerCase(), name);
        }
      }
    }

    // Process groups
    if (config.groups) {
      for (const [name, members] of Object.entries(config.groups)) {
        newGroups.set(name, members);
      }
    }

    // Process token budgets
    if (config.token_budgets) {
      for (const [name, budget] of Object.entries(config.token_budgets)) {
        if (name !== '_default') {
          newTokenBudgets.set(name, budget);
        }
      }
      // Store default separately
      if (config.token_budgets._default) {
        newTokenBudgets.set('_default', config.token_budgets._default);
      }
    }

    // Process scheduling windows
    if (config.scheduling) {
      for (const [name, window] of Object.entries(config.scheduling)) {
        newSchedulingWindows.set(name, {
          name,
          description: window.description || '',
          time: window.time || '',
          allowed: window.allowed || [],
        });
      }
    }

    // Atomic swap
    terminals = newTerminals;
    aliasMap = newAliasMap;
    groups = newGroups;
    tokenBudgets = newTokenBudgets;
    schedulingWindows = newSchedulingWindows;
    configLoaded = true;

    console.log(`[Config] Loaded ${terminals.size} terminals from config`);
  } catch (err) {
    if (!configLoaded) {
      // First load failed, use defaults
      console.warn('[Config] terminals.yaml not found, using defaults');
      loadDefaultTerminals();
    } else {
      console.error('[Config] Failed to reload terminals.yaml:', err);
    }
  }
}

/**
 * Parse can_control field from YAML
 */
function parseCanControl(value: any): string[] {
  if (!value) return [];
  if (value === '*') return ['*'];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Load default terminal configuration (fallback)
 */
function loadDefaultTerminals(): void {
  const defaults: [string, Partial<TerminalDefinition>][] = [
    ['root', { type: 'coordinator', priority: true, model: 'opus', canControl: ['*'], isSystemRole: true }],
    ['conductor', { type: 'coordinator', priority: true, model: 'sonnet', canControl: ['architect', 'librarian', 'explorer', '@workers'], isSystemRole: true }],
    ['architect', { type: 'support', model: 'sonnet', isSystemRole: true }],
    ['librarian', { type: 'support', model: 'sonnet', isSystemRole: true }],
    ['explorer', { type: 'support', model: 'haiku', isSystemRole: true }],
    ['reviewer', { type: 'reviewer', model: 'haiku', isSystemRole: true }],
    ['backend', { type: 'worker', model: 'sonnet', isSystemRole: false }],
    ['frontend', { type: 'worker', model: 'sonnet', isSystemRole: false }],
    ['designer', { type: 'worker', model: 'sonnet', isSystemRole: false }],
  ];

  for (const [name, partial] of defaults) {
    const terminal: TerminalDefinition = {
      name,
      description: '',
      type: partial.type || 'worker',
      priority: partial.priority ?? false,
      model: partial.model || 'sonnet',
      session: `spaceos-${name}`,
      directory: path.join(DEFAULT_TERMINALS_DIR, name),
      aliases: [],
      canControl: partial.canControl || [name],
      isSystemRole: partial.isSystemRole ?? false,
    };
    terminals.set(name, terminal);
    aliasMap.set(name.toLowerCase(), name);
  }

  // Default groups
  groups.set('coordinators', ['root', 'conductor']);
  groups.set('support', ['architect', 'librarian', 'explorer']);
  groups.set('workers', ['backend', 'frontend', 'designer']);

  configLoaded = true;
}

// Initialize on module load
loadTerminalConfig();

// Auto-reload every 30 seconds
setInterval(() => {
  loadTerminalConfig();
}, 30_000);

// ─── Query Functions ─────────────────────────────────────────────────────────

/**
 * Resolve alias to canonical terminal name
 * Returns null if not found
 */
export function resolveTerminal(nameOrAlias: string): string | null {
  if (!nameOrAlias) return null;
  return aliasMap.get(nameOrAlias.toLowerCase()) || null;
}

/**
 * Get terminal definition by name or alias
 */
export function getTerminal(nameOrAlias: string): TerminalDefinition | null {
  const canonical = resolveTerminal(nameOrAlias);
  if (!canonical) return null;
  return terminals.get(canonical) || null;
}

/**
 * Get terminal path (directory)
 */
export function getTerminalPath(nameOrAlias: string): string | null {
  const terminal = getTerminal(nameOrAlias);
  return terminal?.directory || null;
}

/**
 * Check if a terminal name or alias is valid
 */
export function isValidTerminal(nameOrAlias: string): boolean {
  return resolveTerminal(nameOrAlias) !== null;
}

/**
 * Get all terminal names (canonical only)
 */
export function getAllTerminalNames(): string[] {
  return Array.from(terminals.keys());
}

/**
 * Get all terminal definitions
 */
export function getAllTerminals(): TerminalDefinition[] {
  return Array.from(terminals.values());
}

/**
 * Get primary terminals (system roles)
 */
export function getPrimaryTerminals(): string[] {
  return Array.from(terminals.values())
    .filter(t => t.isSystemRole)
    .map(t => t.name);
}

/**
 * Get terminals by type
 */
export function getTerminalsByType(type: TerminalType): TerminalDefinition[] {
  return Array.from(terminals.values()).filter(t => t.type === type);
}

/**
 * Get all aliases for a terminal
 */
export function getAliases(terminalName: string): string[] {
  const terminal = getTerminal(terminalName);
  return terminal?.aliases || [];
}

/**
 * Get all known names and aliases
 */
export function getAllNamesAndAliases(): string[] {
  return Array.from(aliasMap.keys());
}

// ─── Control Matrix ──────────────────────────────────────────────────────────

/**
 * Check if terminal A can control terminal B
 */
export function canControl(controllerName: string, targetName: string): boolean {
  const controller = getTerminal(controllerName);
  const target = getTerminal(targetName);

  if (!controller || !target) return false;

  // Root can control everything
  if (controller.canControl.includes('*')) return true;

  // Check direct name
  if (controller.canControl.includes(target.name)) return true;

  // Check group references
  for (const ref of controller.canControl) {
    if (ref.startsWith('@')) {
      const groupName = ref.slice(1);
      const groupMembers = groups.get(groupName);
      if (groupMembers?.includes(target.name)) return true;

      // Special handling for @workers - all worker-type terminals
      if (groupName === 'workers' && target.type === 'worker') return true;
    }
  }

  return false;
}

/**
 * Get all terminals that a controller can control
 */
export function getControllableTerminals(controllerName: string): string[] {
  const controller = getTerminal(controllerName);
  if (!controller) return [];

  // Root can control all
  if (controller.canControl.includes('*')) {
    return getAllTerminalNames();
  }

  const result: Set<string> = new Set();

  for (const ref of controller.canControl) {
    if (ref.startsWith('@')) {
      const groupName = ref.slice(1);
      const groupMembers = groups.get(groupName);
      if (groupMembers) {
        groupMembers.forEach(m => result.add(m));
      }
      // Special handling for @workers
      if (groupName === 'workers') {
        getTerminalsByType('worker').forEach(t => result.add(t.name));
      }
    } else {
      result.add(ref);
    }
  }

  return Array.from(result);
}

// ─── Token Budgets ───────────────────────────────────────────────────────────

/**
 * Get token budget for a terminal
 */
export function getTokenBudget(terminalName: string): TokenBudget {
  const canonical = resolveTerminal(terminalName);
  if (canonical && tokenBudgets.has(canonical)) {
    return tokenBudgets.get(canonical)!;
  }
  return tokenBudgets.get('_default') || { daily: 5000, hourly: 1000 };
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

/**
 * Get scheduling windows
 */
export function getSchedulingWindows(): SchedulingWindow[] {
  return Array.from(schedulingWindows.values());
}

/**
 * Check if a terminal is allowed in a scheduling window
 */
export function isAllowedInWindow(windowName: string, terminalName: string): boolean {
  const window = schedulingWindows.get(windowName);
  if (!window) return false;

  const canonical = resolveTerminal(terminalName);
  if (!canonical) return false;

  for (const ref of window.allowed) {
    if (ref === canonical) return true;
    if (ref.startsWith('@')) {
      const groupName = ref.slice(1);
      const groupMembers = groups.get(groupName);
      if (groupMembers?.includes(canonical)) return true;
    }
  }

  return false;
}

// ─── Groups ──────────────────────────────────────────────────────────────────

/**
 * Get group members
 */
export function getGroupMembers(groupName: string): string[] {
  return groups.get(groupName) || [];
}

/**
 * Get all group names
 */
export function getAllGroups(): string[] {
  return Array.from(groups.keys());
}

// ─── Export for backward compatibility ───────────────────────────────────────

// Legacy exports that other modules may depend on
export const TERMINALS_DIR_PATH = TERMINALS_DIR;
