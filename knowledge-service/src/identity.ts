/**
 * Identity & Memory Management for SpaceOS Terminals
 *
 * Handles terminal identity (CLAUDE.md) and local memory files.
 * Now uses terminalConfig.ts for terminal definitions.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import {
  resolveTerminal,
  getTerminal,
  getTerminalPath,
  getAllTerminalNames,
  getAllNamesAndAliases,
  getPrimaryTerminals,
  isValidTerminal,
  TERMINALS_DIR_PATH,
} from './terminalConfig';

// Base paths
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';

// ─── Exports for backward compatibility ──────────────────────────────────────

// Primary terminals (system roles)
export const PRIMARY_TERMINALS = getPrimaryTerminals();

// All known terminals (names + aliases)
export const TERMINALS = getAllNamesAndAliases();

// Re-export from terminalConfig for convenience
export { resolveTerminal, getTerminal, isValidTerminal, getAllTerminalNames };

// ─── Identity Functions ────────────────────────────────────────────────────

export interface TerminalIdentity {
  terminal: string;
  claudeMd: string | null;
  memory: string | null;
  path: string;
  memoryPath: string;
}

/**
 * Get terminal identity (CLAUDE.md content + memory)
 */
export async function getIdentity(terminal: string): Promise<TerminalIdentity> {
  const canonical = resolveTerminal(terminal);

  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}. Valid terminals: ${getAllTerminalNames().join(', ')}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const claudeMdPath = path.join(terminalPath, 'CLAUDE.md');
  const memoryPath = path.join(terminalPath, 'MEMORY.md');

  let claudeMd: string | null = null;
  let memory: string | null = null;

  try {
    claudeMd = await fs.readFile(claudeMdPath, 'utf-8');
  } catch (err) {
    // CLAUDE.md not found - that's ok
  }

  try {
    memory = await fs.readFile(memoryPath, 'utf-8');
  } catch (err) {
    // Memory file not found - that's ok
  }

  return {
    terminal: canonical,
    claudeMd,
    memory,
    path: terminalPath,
    memoryPath,
  };
}

/**
 * List all terminals with their paths
 */
export async function listTerminals(): Promise<Array<{ terminal: string; path: string; hasClaudeMd: boolean; hasMemory: boolean; isPrimary: boolean }>> {
  const results = [];
  const primarySet = new Set(getPrimaryTerminals());

  for (const terminalName of getAllTerminalNames()) {
    const terminalPath = getTerminalPath(terminalName)!;
    const claudeMdPath = path.join(terminalPath, 'CLAUDE.md');
    const memoryPath = path.join(terminalPath, 'MEMORY.md');

    let hasClaudeMd = false;
    let hasMemory = false;

    try {
      await fs.access(claudeMdPath);
      hasClaudeMd = true;
    } catch {}

    try {
      await fs.access(memoryPath);
      hasMemory = true;
    } catch {}

    results.push({
      terminal: terminalName,
      path: terminalPath,
      hasClaudeMd,
      hasMemory,
      isPrimary: primarySet.has(terminalName),
    });
  }

  return results;
}

// ─── Memory Functions ──────────────────────────────────────────────────────

/**
 * Read terminal memory file
 */
export async function readMemory(terminal: string): Promise<string | null> {
  const canonical = resolveTerminal(terminal);

  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(canonical)!;
  const memoryPath = path.join(terminalPath, 'MEMORY.md');

  try {
    return await fs.readFile(memoryPath, 'utf-8');
  } catch (err) {
    return null;
  }
}

/**
 * Write/update terminal memory file
 */
export async function writeMemory(terminal: string, content: string): Promise<{ success: boolean; path: string }> {
  const canonical = resolveTerminal(terminal);

  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(canonical)!;
  const memoryPath = path.join(terminalPath, 'MEMORY.md');

  // Write memory file (terminal directory already exists)
  await fs.writeFile(memoryPath, content, 'utf-8');

  return {
    success: true,
    path: memoryPath,
  };
}

/**
 * Append to terminal memory file
 */
export async function appendMemory(terminal: string, content: string): Promise<{ success: boolean; path: string }> {
  const canonical = resolveTerminal(terminal);

  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(canonical)!;
  const memoryPath = path.join(terminalPath, 'MEMORY.md');

  // Read existing content
  let existing = '';
  try {
    existing = await fs.readFile(memoryPath, 'utf-8');
  } catch {}

  // Append new content with timestamp
  const timestamp = new Date().toISOString().split('T')[0];
  const newContent = existing.trim() + '\n\n---\n\n' + `_Updated: ${timestamp}_\n\n` + content;

  await fs.writeFile(memoryPath, newContent, 'utf-8');

  return {
    success: true,
    path: memoryPath,
  };
}

// ─── Capabilities ──────────────────────────────────────────────────────────

export interface Capability {
  name: string;
  description: string;
  category: 'knowledge' | 'mailbox' | 'identity' | 'tasks' | 'system';
}

export const CAPABILITIES: Capability[] = [
  // Knowledge
  { name: 'search_knowledge', description: 'Semantic search in SpaceOS knowledge base (1100+ docs)', category: 'knowledge' },

  // Mailbox
  { name: 'list_inbox', description: 'List inbox messages for a terminal', category: 'mailbox' },
  { name: 'send_message', description: 'Send message to terminal inbox', category: 'mailbox' },
  { name: 'submit_done', description: 'Submit DONE message to outbox', category: 'mailbox' },

  // Identity
  { name: 'get_identity', description: 'Get terminal CLAUDE.md and memory', category: 'identity' },
  { name: 'list_terminals', description: 'List all SpaceOS terminals', category: 'identity' },
  { name: 'read_memory', description: 'Read terminal memory file', category: 'identity' },
  { name: 'write_memory', description: 'Write/replace terminal memory', category: 'identity' },
  { name: 'append_memory', description: 'Append to terminal memory', category: 'identity' },

  // Memory Management (MSG-BACKEND-192)
  { name: 'memory_health_report', description: 'Fleet-wide memory health status in one call', category: 'identity' },
  { name: 'compress_memory', description: 'Automatic memory compression with pattern detection', category: 'identity' },
  { name: 'extract_patterns', description: 'Cross-terminal pattern mining for knowledge extraction', category: 'identity' },

  // Tasks
  { name: 'get_task_status', description: 'Query task status from docs/tasks/', category: 'tasks' },

  // System
  { name: 'get_service_status', description: 'Health check for knowledge service', category: 'system' },
  { name: 'get_capabilities', description: 'List all available capabilities', category: 'system' },
];

/**
 * Get all capabilities, optionally filtered by category
 */
export function getCapabilities(category?: string): Capability[] {
  if (category) {
    return CAPABILITIES.filter(c => c.category === category);
  }
  return CAPABILITIES;
}
