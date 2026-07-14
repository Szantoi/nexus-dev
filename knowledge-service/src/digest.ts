/**
 * Daily Digest Generation (ADR-046 Track D)
 *
 * Generates daily summaries of terminal activity including:
 * - Session summaries
 * - Memories created
 * - Tasks completed
 * - DONE/BLOCKED messages
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { saveTieredMemory } from './pipeline/memoryStore';
import { log as pipelineLog } from './pipeline/common';

const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DailyDigestInput {
  terminal: string;
  date: string; // YYYY-MM-DD
}

export interface DailyDigestResult {
  terminal: string;
  date: string;
  sessionCount: number;
  memoriesCreated: number;
  toolCallsTotal: number;
  tasksCompleted: number;
  tasksBlocked: number;
  summary: string;
  digestMarkdown: string;
  savedAsMemory: boolean;
}

// ─── Database Path ───────────────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const DATA_DIR = process.env.DATA_DIR || `${SPACEOS_ROOT}/spaceos-nexus/knowledge-service/data`;
const DB_PATH = path.join(DATA_DIR, 'memory.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

// ─── Daily Digest Generation ────────────────────────────────────────────────

/**
 * Generate daily digest for a terminal (ADR-046 Track D)
 */
export async function generateDailyDigest(input: DailyDigestInput): Promise<DailyDigestResult> {
  const { terminal, date } = input;

  log('digest', `Generating daily digest for ${terminal} on ${date}`);

  const database = getDb();

  // Query session history for the day
  const sessionStmt = database.prepare(`
    SELECT *
    FROM session_history
    WHERE terminal = ?
      AND DATE(started_at) = ?
    ORDER BY started_at ASC
  `);

  const sessions = sessionStmt.all(terminal, date) as Array<Record<string, unknown>>;

  // Query memories created on this day
  const memoryStmt = database.prepare(`
    SELECT COUNT(*) as count
    FROM memories
    WHERE terminal = ?
      AND DATE(created_at) = ?
  `);

  const memoryCount = (memoryStmt.get(terminal, date) as { count: number }).count;

  // Calculate aggregate stats
  const sessionCount = sessions.length;
  const toolCallsTotal = sessions.reduce((sum, s) => sum + ((s.tool_calls as number) || 0), 0);
  const tasksCompleted = sessions.filter((s) => s.end_reason === 'done').length;
  const tasksBlocked = sessions.filter((s) => s.end_reason === 'blocked').length;

  // Build summary
  const summary = buildDigestSummary({
    terminal,
    date,
    sessionCount,
    memoriesCreated: memoryCount,
    toolCallsTotal,
    tasksCompleted,
    tasksBlocked,
    sessions,
  });

  // Build markdown
  const digestMarkdown = buildDigestMarkdown({
    terminal,
    date,
    sessionCount,
    memoriesCreated: memoryCount,
    toolCallsTotal,
    tasksCompleted,
    tasksBlocked,
    sessions,
    summary,
  });

  // Save as warm memory
  let savedAsMemory = false;
  if (sessionCount > 0) {
    await saveTieredMemory({
      tier: 'warm',
      type: 'episodic',
      source: 'digest',
      content: summary,
      terminal,
      context: `Daily digest for ${date}`,
      salience: 0.6,
    });
    savedAsMemory = true;
    log('digest', `Daily digest saved as warm memory for ${terminal} (${date})`);
  }

  return {
    terminal,
    date,
    sessionCount,
    memoriesCreated: memoryCount,
    toolCallsTotal,
    tasksCompleted,
    tasksBlocked,
    summary,
    digestMarkdown,
    savedAsMemory,
  };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

interface DigestStats {
  terminal: string;
  date: string;
  sessionCount: number;
  memoriesCreated: number;
  toolCallsTotal: number;
  tasksCompleted: number;
  tasksBlocked: number;
  sessions: Array<Record<string, unknown>>;
}

interface DigestMarkdownInput extends DigestStats {
  summary: string;
}

function buildDigestSummary(stats: DigestStats): string {
  const { terminal, date, sessionCount, memoriesCreated, toolCallsTotal, tasksCompleted, tasksBlocked } = stats;

  if (sessionCount === 0) {
    return `${terminal} had no activity on ${date}.`;
  }

  const parts: string[] = [];
  parts.push(`${terminal} on ${date}:`);
  parts.push(`${sessionCount} session(s)`);
  parts.push(`${tasksCompleted} task(s) completed`);
  if (tasksBlocked > 0) parts.push(`${tasksBlocked} blocked`);
  parts.push(`${memoriesCreated} memories created`);
  parts.push(`${toolCallsTotal} tool calls`);

  return parts.join(', ') + '.';
}

function buildDigestMarkdown(input: DigestMarkdownInput): string {
  const {
    terminal,
    date,
    sessionCount,
    memoriesCreated,
    toolCallsTotal,
    tasksCompleted,
    tasksBlocked,
    sessions,
    summary,
  } = input;

  const lines: string[] = [];

  lines.push(`# Daily Digest — ${terminal} — ${date}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Summary
  lines.push('## 📊 Summary');
  lines.push('');
  lines.push(summary);
  lines.push('');

  // Stats
  lines.push('## 📈 Statistics');
  lines.push('');
  lines.push(`- **Sessions:** ${sessionCount}`);
  lines.push(`- **Tasks Completed:** ${tasksCompleted}`);
  if (tasksBlocked > 0) lines.push(`- **Tasks Blocked:** ${tasksBlocked}`);
  lines.push(`- **Memories Created:** ${memoriesCreated}`);
  lines.push(`- **Tool Calls:** ${toolCallsTotal}`);
  lines.push('');

  // Session Details
  if (sessions.length > 0) {
    lines.push('## 🕐 Sessions');
    lines.push('');
    for (const session of sessions) {
      const startedAt = session.started_at as string;
      const endedAt = session.ended_at as string;
      const endReason = session.end_reason as string;
      const taskId = session.task_id as string;
      const toolCalls = session.tool_calls as number;

      const startTime = startedAt ? new Date(startedAt).toLocaleTimeString('en-US', { hour12: false }) : 'N/A';
      const endTime = endedAt ? new Date(endedAt).toLocaleTimeString('en-US', { hour12: false }) : 'N/A';

      lines.push(`### ${startTime} - ${endTime}`);
      lines.push('');
      lines.push(`- **Task:** ${taskId || 'Unknown'}`);
      lines.push(`- **End Reason:** ${endReason || 'Unknown'}`);
      lines.push(`- **Tool Calls:** ${toolCalls || 0}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('_Generated by Nexus Knowledge Service (ADR-046 Track D)_');

  return lines.join('\n');
}

/**
 * Close database connection
 */
export function closeDigest(): void {
  if (db) {
    db.close();
    db = null;
    log('digest', 'Database connection closed');
  }
}
