/**
 * paths.ts — Centralized path configuration for multi-island deployment
 *
 * All paths are configurable via environment variables for island isolation.
 * Default paths are relative to the knowledge-service directory.
 */

import { join } from 'path';

// Base directory for knowledge-service (where this code lives)
const KNOWLEDGE_SERVICE_ROOT = join(__dirname, '../..');

// Island ID for multi-tenant deployments
export const ISLAND_ID = process.env.ISLAND_ID || 'spaceos';

// Data directory for SQLite databases and runtime files
export const DATA_DIR = process.env.DATA_DIR || join(KNOWLEDGE_SERVICE_ROOT, 'data');

// Terminals directory for inbox/outbox watching.
// Default matches this repo's layout (nexus-dev/terminals); production
// deployments override via env.
export const TERMINALS_PATH = process.env.TERMINALS_PATH || join(KNOWLEDGE_SERVICE_ROOT, '../terminals');

// Knowledge base directory for document indexing
export const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH || join(KNOWLEDGE_SERVICE_ROOT, '../docs/knowledge');

// Logs directory
export const LOGS_DIR = process.env.LOGS_DIR || join(KNOWLEDGE_SERVICE_ROOT, '../logs');

// ChromaDB collection name (island-specific)
export const COLLECTION_NAME = process.env.COLLECTION_NAME || `${ISLAND_ID}-knowledge`;

// Agents config file (tokens)
export const AGENTS_CONFIG_PATH = process.env.AGENTS_CONFIG_PATH || join(KNOWLEDGE_SERVICE_ROOT, 'config/agents.yaml');

// Canonical message-model config (types, statuses, transitions, legacy mappings)
export const MESSAGE_MODEL_CONFIG_PATH = process.env.MESSAGE_MODEL_CONFIG_PATH || join(KNOWLEDGE_SERVICE_ROOT, 'config/message-model.yaml');

// Workflow definitions (declared expected lifecycle per message type)
export const WORKFLOWS_CONFIG_PATH = process.env.WORKFLOWS_CONFIG_PATH || join(KNOWLEDGE_SERVICE_ROOT, 'config/workflows.yaml');

// Export derived paths
export const AGENT_MESSAGES_DB = process.env.AGENT_MESSAGES_DB || join(DATA_DIR, 'agent_messages.db');
export const MESSAGE_REGISTRY_DB = process.env.MESSAGE_REGISTRY_DB || join(DATA_DIR, 'message_registry.db');
export const DISPATCH_DB = process.env.DISPATCH_DB || join(DATA_DIR, 'dispatch.db');
export const MEMORY_DB = process.env.MEMORY_DB || join(DATA_DIR, 'memory.db');

// Ensure DATA_DIR exists on import
import { mkdirSync } from 'fs';
import { logger } from '../core/logger';
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  // Ignore errors (directory may already exist or be read-only)
}

// Log configuration on startup (once)
let logged = false;
export function logPathConfig(): void {
  if (logged) return;
  logged = true;
  logger.info(`📁 [Config] Island: ${ISLAND_ID}`);
  logger.info(`   DATA_DIR: ${DATA_DIR}`);
  logger.info(`   TERMINALS_PATH: ${TERMINALS_PATH}`);
  logger.info(`   KNOWLEDGE_BASE_PATH: ${KNOWLEDGE_BASE_PATH}`);
}
