/**
 * agentMessages.ts — Inter-Agent Message Queue
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * SQLite-based message queue for terminal-to-terminal communication.
 * Supports: pending, delivered, done, failed states with retry logic.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { SPACEOS_ROOT, SESSIONS, log } from './common';
import { logger } from '../core/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MessageStatus = 'pending' | 'delivered' | 'done' | 'failed';
export type MessagePriority = 'critical' | 'high' | 'medium' | 'low';

export interface AgentMessage {
  id: number;
  from_terminal: string;
  to_terminal: string;
  content: string;
  message_type: string;
  priority: MessagePriority;
  status: MessageStatus;
  ref_id: string | null;
  created_at: number;
  delivered_at: number | null;
  completed_at: number | null;
  result: string | null;
  retry_count: number;
}

export interface CreateMessageParams {
  from: string;
  to: string;
  content: string;
  type?: string;
  priority?: MessagePriority;
  ref?: string;
}

// ─── Database Setup ──────────────────────────────────────────────────────────

// DATA_DIR is configurable per-island — central config layer decides.
import { DATA_DIR, AGENT_MESSAGES_DB as DB_PATH } from '../config/paths';

let db: Database.Database | null = null;

/**
 * Initialize the SQLite database
 */
export function initMessageDb(): void {
  if (db) return;

  // Ensure data directory exists
  require('fs').mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_terminal TEXT NOT NULL,
      to_terminal TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'task',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','done','failed')),
      ref_id TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      completed_at INTEGER,
      result TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status, to_terminal)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at DESC)`);

  // Message delivery tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_delivery_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      attempt_at INTEGER NOT NULL,
      success INTEGER NOT NULL,
      error TEXT,
      FOREIGN KEY (message_id) REFERENCES agent_messages(id)
    )
  `);

  logger.info('[AgentMessages] Database initialized:', DB_PATH);
}

/**
 * Close the database connection
 */
export function closeMessageDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Create a new inter-agent message
 */
export function createAgentMessage(params: CreateMessageParams): AgentMessage {
  if (!db) initMessageDb();

  const now = Date.now();
  const stmt = db!.prepare(`
    INSERT INTO agent_messages (from_terminal, to_terminal, content, message_type, priority, ref_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    params.from,
    params.to,
    params.content,
    params.type || 'task',
    params.priority || 'medium',
    params.ref || null,
    now
  );

  const message = db!.prepare('SELECT * FROM agent_messages WHERE id = ?').get(result.lastInsertRowid) as AgentMessage;

  log(`[AgentMessages] Created: ${params.from} → ${params.to} (${params.type || 'task'}, ${params.priority || 'medium'})`);

  return message;
}

/**
 * Get pending messages for a terminal
 */
export function getPendingMessages(terminal?: string): AgentMessage[] {
  if (!db) initMessageDb();

  if (terminal) {
    return db!.prepare(`
      SELECT * FROM agent_messages
      WHERE status = 'pending' AND to_terminal = ?
      ORDER BY
        CASE priority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END,
        created_at ASC
    `).all(terminal) as AgentMessage[];
  }

  return db!.prepare(`
    SELECT * FROM agent_messages
    WHERE status = 'pending'
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
      END,
      created_at ASC
  `).all() as AgentMessage[];
}

/**
 * Mark message as delivered (sent to terminal)
 */
export function markDelivered(id: number): boolean {
  if (!db) initMessageDb();

  const now = Date.now();
  const result = db!.prepare(`
    UPDATE agent_messages
    SET status = 'delivered', delivered_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, id);

  if (result.changes > 0) {
    log(`[AgentMessages] Delivered: message #${id}`);
  }

  return result.changes > 0;
}

/**
 * Mark message as done (terminal completed the task)
 */
export function markDone(id: number, resultText?: string): boolean {
  if (!db) initMessageDb();

  const now = Date.now();
  const result = db!.prepare(`
    UPDATE agent_messages
    SET status = 'done', completed_at = ?, result = ?
    WHERE id = ? AND status IN ('pending', 'delivered')
  `).run(now, resultText || null, id);

  if (result.changes > 0) {
    log(`[AgentMessages] Done: message #${id}`);
  }

  return result.changes > 0;
}

/**
 * Mark message as failed
 */
export function markFailed(id: number, error?: string): boolean {
  if (!db) initMessageDb();

  const now = Date.now();
  const result = db!.prepare(`
    UPDATE agent_messages
    SET status = 'failed', completed_at = ?, result = ?, retry_count = retry_count + 1
    WHERE id = ?
  `).run(now, error || null, id);

  if (result.changes > 0) {
    log(`[AgentMessages] Failed: message #${id} - ${error || 'unknown'}`);
  }

  return result.changes > 0;
}

/**
 * Retry a failed message (reset to pending)
 */
export function retryMessage(id: number): boolean {
  if (!db) initMessageDb();

  const result = db!.prepare(`
    UPDATE agent_messages
    SET status = 'pending', delivered_at = NULL, completed_at = NULL, result = NULL
    WHERE id = ? AND status = 'failed' AND retry_count < 3
  `).run(id);

  if (result.changes > 0) {
    log(`[AgentMessages] Retry: message #${id}`);
  }

  return result.changes > 0;
}

/**
 * Get message by ID
 */
export function getMessage(id: number): AgentMessage | undefined {
  if (!db) initMessageDb();
  return db!.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage | undefined;
}

/**
 * Get recent messages (for dashboard)
 */
export function getRecentMessages(limit = 50): AgentMessage[] {
  if (!db) initMessageDb();
  return db!.prepare(`
    SELECT * FROM agent_messages
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as AgentMessage[];
}

/**
 * Get messages between two terminals
 */
export function getMessagesBetween(terminal1: string, terminal2: string, limit = 20): AgentMessage[] {
  if (!db) initMessageDb();
  return db!.prepare(`
    SELECT * FROM agent_messages
    WHERE (from_terminal = ? AND to_terminal = ?) OR (from_terminal = ? AND to_terminal = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(terminal1, terminal2, terminal2, terminal1, limit) as AgentMessage[];
}

/**
 * Get message statistics
 */
export function getMessageStats(): {
  total: number;
  pending: number;
  delivered: number;
  done: number;
  failed: number;
  byTerminal: Record<string, { sent: number; received: number }>;
} {
  if (!db) initMessageDb();

  const counts = db!.prepare(`
    SELECT status, COUNT(*) as count
    FROM agent_messages
    GROUP BY status
  `).all() as { status: string; count: number }[];

  const byTerminal: Record<string, { sent: number; received: number }> = {};

  // Sent counts
  const sentCounts = db!.prepare(`
    SELECT from_terminal, COUNT(*) as count
    FROM agent_messages
    GROUP BY from_terminal
  `).all() as { from_terminal: string; count: number }[];

  for (const row of sentCounts) {
    byTerminal[row.from_terminal] = { sent: row.count, received: 0 };
  }

  // Received counts
  const receivedCounts = db!.prepare(`
    SELECT to_terminal, COUNT(*) as count
    FROM agent_messages
    GROUP BY to_terminal
  `).all() as { to_terminal: string; count: number }[];

  for (const row of receivedCounts) {
    if (!byTerminal[row.to_terminal]) {
      byTerminal[row.to_terminal] = { sent: 0, received: 0 };
    }
    byTerminal[row.to_terminal].received = row.count;
  }

  const stats = {
    total: 0,
    pending: 0,
    delivered: 0,
    done: 0,
    failed: 0,
    byTerminal,
  };

  for (const row of counts) {
    stats.total += row.count;
    (stats as any)[row.status] = row.count;
  }

  return stats;
}

/**
 * Log delivery attempt
 */
export function logDeliveryAttempt(messageId: number, success: boolean, error?: string): void {
  if (!db) initMessageDb();

  db!.prepare(`
    INSERT INTO message_delivery_log (message_id, attempt_at, success, error)
    VALUES (?, ?, ?, ?)
  `).run(messageId, Date.now(), success ? 1 : 0, error || null);
}

/**
 * Clean up old completed messages (older than 7 days)
 */
export function cleanupOldMessages(daysOld = 7): number {
  if (!db) initMessageDb();

  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  const result = db!.prepare(`
    DELETE FROM agent_messages
    WHERE status IN ('done', 'failed') AND completed_at < ?
  `).run(cutoff);

  if (result.changes > 0) {
    log(`[AgentMessages] Cleaned up ${result.changes} old messages`);
  }

  return result.changes;
}
