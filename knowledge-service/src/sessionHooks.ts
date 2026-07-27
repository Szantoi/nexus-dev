/**
 * Session Lifecycle Hooks (ADR-046 Track B)
 *
 * Provides cold start context injection and session end handling
 * for SpaceOS agent sessions. Inspired by Marveen cold start pattern.
 */

import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  queryByTier,
  type TieredMemory,
  type MemoryTier,
  saveTieredMemory,
} from './pipeline/ftsMemoryStore';
import { log as pipelineLog } from './pipeline/common';
import {
  loadDomainKnowledge,
  formatKnowledgeForPrompt,
  getKnowledgeSummary,
  type LoadedKnowledge,
} from './pipeline/knowledgeLoader';

const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionStartContext {
  terminal: string;
  taskId?: string;
  inboxMessageId?: string;
  taskContent?: string; // ADR-049 Phase 3: Task content for domain memory detection
}

export interface SessionStartResult {
  contextInjected: boolean;
  memoriesLoaded: number;
  hotMemories: TieredMemory[];
  warmMemories: TieredMemory[];
  sharedMemories: TieredMemory[];
  domainKnowledge?: LoadedKnowledge; // ADR-049 Phase 3: Domain-specific memories
  contextTokens: number;
  contextMarkdown: string;
}

export interface SessionEndContext {
  terminal: string;
  endReason: 'done' | 'blocked' | 'timeout' | 'handoff' | 'crash';
  taskId?: string;
  summary?: string;
  hadCorrections?: boolean;
  toolCallCount?: number;
}

export interface SessionEndResult {
  memoriesSaved: number;
  retrospectiveTriggered: boolean;
  handoffGenerated: boolean;
  sessionId: number;
}

// ─── Database Path ───────────────────────────────────────────────────────────

import { MEMORY_DB } from './config/paths';
// MEMORY_DB already honors the MEMORY_DB_PATH legacy alias (config/paths.ts)
const DB_PATH = MEMORY_DB;

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    ensureSessionHistoryTable();
  }
  return db;
}

function ensureSessionHistoryTable(): void {
  const database = db!;

  database.exec(`
    CREATE TABLE IF NOT EXISTS session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      task_id TEXT,
      memories_injected INTEGER NOT NULL DEFAULT 0,
      memories_created INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      had_corrections BOOLEAN NOT NULL DEFAULT 0,
      retrospective_done BOOLEAN NOT NULL DEFAULT 0
    )
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_history_terminal ON session_history(terminal);
    CREATE INDEX IF NOT EXISTS idx_session_history_started ON session_history(started_at DESC);
  `);

  log('sessionHooks', 'session_history table initialized');
}

// ─── Session Start Hook ──────────────────────────────────────────────────────

/**
 * Build startup context for a terminal session (ADR-046 Track B + ADR-049 Phase 3)
 *
 * This function:
 * 1. Queries hot + warm memories for the terminal
 * 2. Queries shared memories (cross-terminal)
 * 3. Loads domain-specific memories based on task content (ADR-049)
 * 4. Builds a markdown context
 * 5. Returns SessionStartResult with all context data
 */
export async function buildStartContext(ctx: SessionStartContext): Promise<SessionStartResult> {
  const { terminal, taskId, inboxMessageId, taskContent } = ctx;

  log('sessionHooks', `Building start context for ${terminal} (task=${taskId || 'none'})`);

  // 1. Query hot memories (terminal-specific)
  const hotMemories = queryByTier(terminal, ['hot'], 10);

  // 2. Query warm memories (terminal-specific)
  const warmMemories = queryByTier(terminal, ['warm'], 5);

  // 3. Query shared memories (global)
  const sharedMemories = queryByTier(terminal, ['shared'], 3);

  const allMemories = [...hotMemories, ...warmMemories, ...sharedMemories];

  // 4. Load domain-specific memories (ADR-049 Phase 3)
  let domainKnowledge: LoadedKnowledge | undefined;
  if (taskContent) {
    domainKnowledge = loadDomainKnowledge(terminal, taskContent);
    if (domainKnowledge.memories.length > 0) {
      log('sessionHooks', `Domain knowledge: ${getKnowledgeSummary(domainKnowledge)}`);
    }
  }

  // 5. Build context markdown
  const contextLines: string[] = [];

  contextLines.push('# Session Context\n');
  contextLines.push(`**Terminal:** ${terminal}`);
  if (taskId) {
    contextLines.push(`**Task:** ${taskId}`);
  }
  if (inboxMessageId) {
    contextLines.push(`**Inbox Message:** ${inboxMessageId}`);
  }
  if (domainKnowledge && domainKnowledge.domains.length > 0) {
    contextLines.push(`**Active Domains:** ${domainKnowledge.domains.join(', ')}`);
  }
  contextLines.push('');

  if (hotMemories.length > 0) {
    contextLines.push('## 🔥 Hot Memories (Recent, High Priority)\n');
    for (const memory of hotMemories) {
      const typeEmoji = memory.type === 'semantic' ? '💡' : memory.type === 'episodic' ? '📝' : '🔧';
      contextLines.push(`${typeEmoji} ${memory.content}`);
      if (memory.context) {
        contextLines.push(`   _Context: ${memory.context}_`);
      }
      contextLines.push('');
    }
  }

  if (warmMemories.length > 0) {
    contextLines.push('## 🌤️ Warm Memories (Past 2 weeks)\n');
    for (const memory of warmMemories) {
      const typeEmoji = memory.type === 'semantic' ? '💡' : memory.type === 'episodic' ? '📝' : '🔧';
      contextLines.push(`${typeEmoji} ${memory.content}`);
      if (memory.context) {
        contextLines.push(`   _Context: ${memory.context}_`);
      }
      contextLines.push('');
    }
  }

  if (sharedMemories.length > 0) {
    contextLines.push('## 🌍 Shared Memories (Cross-Terminal)\n');
    for (const memory of sharedMemories) {
      const typeEmoji = memory.type === 'semantic' ? '💡' : memory.type === 'episodic' ? '📝' : '🔧';
      contextLines.push(`${typeEmoji} ${memory.content}`);
      if (memory.context) {
        contextLines.push(`   _Context: ${memory.context}_`);
      }
      contextLines.push('');
    }
  }

  // Add domain knowledge section (ADR-049)
  if (domainKnowledge && domainKnowledge.memories.length > 0) {
    contextLines.push(formatKnowledgeForPrompt(domainKnowledge));
  }

  const contextMarkdown = contextLines.join('\n');

  // Estimate tokens (rough: 1 token ≈ 4 chars)
  const totalDomainTokens = domainKnowledge?.totalTokens || 0;
  const contextTokens = Math.ceil(contextMarkdown.length / 4);

  log('sessionHooks', `Context built: ${allMemories.length} tiered memories + ${domainKnowledge?.memories.length || 0} domain memories, ~${contextTokens} tokens`);

  return {
    contextInjected: false, // Will be set to true by sessionStarter after injection
    memoriesLoaded: allMemories.length + (domainKnowledge?.memories.length || 0),
    hotMemories,
    warmMemories,
    sharedMemories,
    domainKnowledge,
    contextTokens,
    contextMarkdown,
  };
}

// ─── Session End Hook ────────────────────────────────────────────────────────

/**
 * Handle session end (ADR-046 Track B)
 *
 * This function:
 * 1. Saves session metadata to session_history
 * 2. Auto-saves hot memory (task summary)
 * 3. Triggers retrospective if significant work was done
 * 4. Generates handoff if requested
 */
export async function handleSessionEnd(ctx: SessionEndContext): Promise<SessionEndResult> {
  const { terminal, endReason, taskId, summary, hadCorrections, toolCallCount } = ctx;

  log('sessionHooks', `Handling session end for ${terminal} (reason=${endReason})`);

  const database = getDb();

  // 1. Save session history
  const insertStmt = database.prepare(`
    INSERT INTO session_history (
      terminal,
      started_at,
      ended_at,
      end_reason,
      task_id,
      memories_injected,
      memories_created,
      tool_calls,
      had_corrections,
      retrospective_done
    ) VALUES (?, datetime('now', '-1 hour'), datetime('now'), ?, ?, 0, 0, ?, ?, 0)
  `);

  const result = insertStmt.run(
    terminal,
    endReason,
    taskId || null,
    toolCallCount || 0,
    hadCorrections ? 1 : 0
  );

  const sessionId = result.lastInsertRowid as number;

  // 2. Auto-save hot memory if summary provided
  let memoriesSaved = 0;
  if (summary && summary.length > 10) {
    try {
      await saveTieredMemory({
        tier: 'hot',
        type: 'episodic',
        source: 'digest',
        content: summary,
        terminal,
        context: `Task: ${taskId || 'unknown'}, End reason: ${endReason}`,
        salience: 0.7,
      });
      memoriesSaved = 1;
      log('sessionHooks', `Saved session summary as hot memory`);
    } catch (error) {
      log('sessionHooks', `Failed to save session summary: ${error}`);
    }
  }

  // 3. Trigger retrospective if significant work
  const retrospectiveTriggered = hadCorrections === true || (toolCallCount || 0) > 10;

  // 4. Handoff generation (placeholder for now)
  const handoffGenerated = false;

  log('sessionHooks', `Session end handled: id=${sessionId}, memories=${memoriesSaved}, retrospective=${retrospectiveTriggered}`);

  return {
    memoriesSaved,
    retrospectiveTriggered,
    handoffGenerated,
    sessionId,
  };
}

/**
 * Close database connection
 */
export function closeSessionHooks(): void {
  if (db) {
    db.close();
    db = null;
    log('sessionHooks', 'Database connection closed');
  }
}
