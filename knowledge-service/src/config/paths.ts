/**
 * paths.ts — Centralized path configuration for multi-island deployment.
 *
 * Every filesystem location the service touches is declared here, overridable
 * via environment variables and derived with path.join/resolve so the same
 * defaults work on POSIX hosts, Windows dev machines and bare checkouts.
 *
 * Two access styles:
 *  - `const` exports: evaluated once at first import (the normal case).
 *  - `getX()` functions: read process.env at call time, for values that
 *    tests (or runtime reloads) mutate after module load.
 *
 * This module and env.ts are the ONLY places allowed to read process.env;
 * feature modules import from here instead.
 */

import { join, resolve } from 'path';

// Base directory for knowledge-service (where this code lives).
// __dirname is src/config (ts-node) or dist/config (compiled) — both are two
// levels below the knowledge-service root.
export const KNOWLEDGE_SERVICE_ROOT = resolve(__dirname, '../..');

// Repo/checkout root: the directory that contains knowledge-service.
const REPO_ROOT = resolve(KNOWLEDGE_SERVICE_ROOT, '..');

// ─── SpaceOS tree root ───────────────────────────────────────────────────────

/**
 * Root of the SpaceOS tree (terminals/, docs/, config/, store/ live under
 * it). Default: the checkout root — platform independent, works on a bare
 * checkout. Deployments with a different layout set SPACEOS_ROOT explicitly.
 * Lazy variant exists because several tests point SPACEOS_ROOT at a temp
 * dir between test cases.
 */
export function getSpaceosRoot(): string {
  return process.env.SPACEOS_ROOT || REPO_ROOT;
}
export const SPACEOS_ROOT = getSpaceosRoot();

// ─── Island identity ─────────────────────────────────────────────────────────

// Island ID for multi-tenant deployments
export const ISLAND_ID = process.env.ISLAND_ID || 'spaceos';

// ChromaDB collection name (island-specific)
export const COLLECTION_NAME = process.env.COLLECTION_NAME || `${ISLAND_ID}-knowledge`;

// ─── Core directories ────────────────────────────────────────────────────────

// Data directory for SQLite databases and runtime files
export const DATA_DIR = process.env.DATA_DIR || join(KNOWLEDGE_SERVICE_ROOT, 'data');

/**
 * Terminals directory for inbox/outbox mailboxes. Recognized overrides:
 * TERMINALS_PATH (canonical) and TERMINALS_DIR (legacy alias used by older
 * modules). Default: <SPACEOS_ROOT>/terminals — identical to the previous
 * repo-relative default on a bare checkout.
 */
export function getTerminalsPath(): string {
  return process.env.TERMINALS_PATH || process.env.TERMINALS_DIR || join(getSpaceosRoot(), 'terminals');
}
export const TERMINALS_PATH = getTerminalsPath();

// Knowledge base directory for document indexing
export const KNOWLEDGE_BASE_PATH =
  process.env.KNOWLEDGE_BASE_PATH || join(getSpaceosRoot(), 'docs', 'knowledge');

// Logs directory
export const LOGS_DIR = process.env.LOGS_DIR || join(getSpaceosRoot(), 'logs');

// Project/goal/planning trees (under the SpaceOS root)
export function getProjectsDir(): string {
  return process.env.PROJECTS_DIR || join(getSpaceosRoot(), 'docs', 'projects');
}
export const PROJECTS_DIR = getProjectsDir();

export function getEpicsPath(): string {
  return process.env.EPICS_PATH || join(getProjectsDir(), 'EPICS.yaml');
}
export const EPICS_PATH = getEpicsPath();

export const GOALS_DIR = process.env.GOALS_DIR || join(SPACEOS_ROOT, 'store', 'goals');
export const IDEAS_DIR = process.env.IDEAS_DIR || join(SPACEOS_ROOT, 'docs', 'planning', 'ideas');
export const QUEUE_DIR = process.env.QUEUE_DIR || join(SPACEOS_ROOT, 'docs', 'planning', 'queue');
export const IDEA_SCAN_PROJECT_PATH =
  process.env.IDEA_SCAN_PROJECT_PATH || join(SPACEOS_ROOT, 'docs', 'tasks', 'new');
export const AUTONOMOUS_DEV_FOCUS_FILE =
  process.env.AUTONOMOUS_DEV_FOCUS_FILE ||
  join(SPACEOS_ROOT, 'docs', 'tasks', 'new', 'PROJECT_STATUS.md');

/** Planning domain-focus document (lazy: planning tests override per-run). */
export function getPlanningFocusPath(): string {
  return (
    process.env.PLANNING_FOCUS_PATH ||
    join(getSpaceosRoot(), 'docs', 'planning', 'domain-focus.md')
  );
}

// Conductor terminal state (session state, context saturation tracking)
export const CONDUCTOR_STATE_DIR =
  process.env.CONDUCTOR_STATE_DIR || join(SPACEOS_ROOT, 'terminals', 'conductor');

// Code generation targets
export const BACKEND_DIR = process.env.BACKEND_DIR || join(SPACEOS_ROOT, 'backend');
export const GENERATORS_DIR =
  process.env.GENERATORS_DIR || join(KNOWLEDGE_SERVICE_ROOT, 'src', 'generators');

/** Frontend portal checkout (relative FRONTEND_PORTAL_PATH under the root). */
export function getFrontendPortalDir(): string {
  return join(getSpaceosRoot(), process.env.FRONTEND_PORTAL_PATH || 'frontend/portal');
}

// External project checkout verified by the pre-review gate
export const DATAHAVEN_CLIENT_DIR =
  process.env.DATAHAVEN_CLIENT_DIR || join(SPACEOS_ROOT, 'datahaven-web', 'client');

// ─── Config files ────────────────────────────────────────────────────────────

// Agents config file (tokens)
export const AGENTS_CONFIG_PATH =
  process.env.AGENTS_CONFIG_PATH || join(KNOWLEDGE_SERVICE_ROOT, 'config/agents.yaml');

// Canonical message-model config (types, statuses, transitions, legacy mappings)
export const MESSAGE_MODEL_CONFIG_PATH =
  process.env.MESSAGE_MODEL_CONFIG_PATH || join(KNOWLEDGE_SERVICE_ROOT, 'config/message-model.yaml');

// Workflow definitions (declared expected lifecycle per message type)
export const WORKFLOWS_CONFIG_PATH =
  process.env.WORKFLOWS_CONFIG_PATH || join(KNOWLEDGE_SERVICE_ROOT, 'config/workflows.yaml');

// Directory of YAML workflow definitions (workflowManager.ts)
export const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || join(SPACEOS_ROOT, 'config', 'workflows');

// Multi-bot Telegram config
export const TELEGRAM_BOTS_CONFIG_PATH =
  process.env.TELEGRAM_BOTS_CONFIG || join(SPACEOS_ROOT, 'config', 'telegram-bots.yaml');

// ─── Databases (under DATA_DIR unless overridden) ────────────────────────────

export const AGENT_MESSAGES_DB = process.env.AGENT_MESSAGES_DB || join(DATA_DIR, 'agent_messages.db');
// REGISTRY_DB_PATH is a legacy alias recognized for compatibility.
export const MESSAGE_REGISTRY_DB =
  process.env.REGISTRY_DB_PATH || process.env.MESSAGE_REGISTRY_DB || join(DATA_DIR, 'message_registry.db');
export const DISPATCH_DB = process.env.DISPATCH_DB || join(DATA_DIR, 'dispatch.db');
// MEMORY_DB_PATH is a legacy alias recognized for compatibility.
export const MEMORY_DB =
  process.env.MEMORY_DB_PATH || process.env.MEMORY_DB || join(DATA_DIR, 'memory.db');
export const WORKFLOW_DB = process.env.WORKFLOW_DB || join(DATA_DIR, 'workflow.db');
export const TELEGRAM_DB = process.env.TELEGRAM_DB_PATH || join(DATA_DIR, 'telegram.db');
export const GOLDEN_PATHS_DIR = process.env.GOLDEN_PATHS_DIR || join(DATA_DIR, 'golden-paths');

// Ensure DATA_DIR exists on import
import { mkdirSync } from 'fs';
import { logger } from '../core/logger';
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  // Ignore errors (directory may already exist or be read-only)
}

/**
 * Log the effective (secret-free) path configuration once at startup so a
 * misconfigured deployment is visible immediately instead of writing data
 * to the wrong place silently.
 */
let logged = false;
export function logPathConfig(): void {
  if (logged) return;
  logged = true;
  logger.info(`📁 [Config] Island: ${ISLAND_ID}`);
  logger.info(`   SPACEOS_ROOT: ${SPACEOS_ROOT}`);
  logger.info(`   DATA_DIR: ${DATA_DIR}`);
  logger.info(`   TERMINALS_PATH: ${TERMINALS_PATH}`);
  logger.info(`   KNOWLEDGE_BASE_PATH: ${KNOWLEDGE_BASE_PATH}`);
  logger.info(`   LOGS_DIR: ${LOGS_DIR}`);
  logger.info(`   PROJECTS_DIR: ${PROJECTS_DIR}`);
  logger.info(`   EPICS_PATH: ${EPICS_PATH}`);
  logger.info(`   WORKFLOWS_DIR: ${WORKFLOWS_DIR}`);
}
