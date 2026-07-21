/**
 * messageRegistry.ts — Inbox/Outbox Message Registry for SpaceOS
 *
 * Central SQLite registry for all mailbox messages, enabling:
 * - Fast queries without filesystem scans
 * - Complete audit trail with timestamps
 * - Status tracking (UNREAD → READ → PROCESSED)
 * - Analytics (message counts, response times, throughput)
 * - Cross-terminal message flow visibility
 *
 * Schema inspired by ADR-046 tiered memory architecture.
 */

import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, MESSAGE_REGISTRY_DB, getTerminalsPath } from './config/paths';
import { logger } from './core/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MessageType = 'task' | 'question' | 'done' | 'blocked' | 'escalation' | 'info' | 'progress' | 'freeform' | 'notification' | 'response' | 'acknowledgment' | 'test' | 'answer' | 'message';
export type MessagePriority = 'critical' | 'high' | 'medium' | 'low';
export type MessageStatus = 'UNREAD' | 'INJECTED' | 'READ' | 'PROCESSING' | 'PROCESSED' | 'ARCHIVED' | 'COMPLETED' | 'DONE' | 'SKIPPED' | 'DELEGATED' | 'PENDING' | 'SUPERSEDED';
export type MessageBox = 'inbox' | 'outbox';
export type ModelType = 'opus' | 'sonnet' | 'haiku';

export interface RegisteredMessage {
  id: number;
  messageId: string;        // MSG-BACKEND-001
  terminal: string;         // backend
  box: MessageBox;          // inbox | outbox
  fromTerminal: string;     // root
  toTerminal: string;       // backend
  type: MessageType;
  priority: MessagePriority;
  status: MessageStatus;
  model?: ModelType;
  refMessageId?: string;    // Reference to related message
  filePath: string;
  title?: string;
  contentPreview?: string;  // First 200 chars
  contentHash: string;      // SHA-256 hash of original file content (anti-tampering)
  createdAt: string;        // From frontmatter
  detectedAt: string;       // When InboxWatcher found it
  firstReadAt?: string;     // First time terminal opened message (immutable)
  readAt?: string;          // Last read timestamp
  processedAt?: string;
  responseTimeMs?: number;  // Time from created to processed
  hashVerified?: boolean;   // Whether current file matches original hash
}

export interface MessageInput {
  messageId: string;
  terminal: string;
  box: MessageBox;
  fromTerminal: string;
  toTerminal: string;
  type: MessageType;
  priority: MessagePriority;
  status: MessageStatus;
  model?: ModelType;
  refMessageId?: string;
  filePath: string;
  title?: string;
  contentPreview?: string;
  contentHash?: string;     // SHA-256 hash (will be calculated if not provided)
  createdAt: string;
}

export interface MessageStats {
  total: number;
  byStatus: Record<MessageStatus, number>;
  byType: Record<MessageType, number>;
  byPriority: Record<MessagePriority, number>;
  byTerminal: Record<string, { inbox: number; outbox: number; unread: number }>;
  avgResponseTimeMs: number;
  oldestUnread?: RegisteredMessage;
}

export interface MessageQuery {
  terminal?: string;
  box?: MessageBox;
  status?: MessageStatus | MessageStatus[];
  type?: MessageType | MessageType[];
  priority?: MessagePriority | MessagePriority[];
  fromTerminal?: string;
  toTerminal?: string;
  since?: string;           // ISO date
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'detectedAt' | 'priority';
  orderDir?: 'ASC' | 'DESC';
}

// ─── Constants ───────────────────────────────────────────────────────────────

// MESSAGE_REGISTRY_DB already honors the REGISTRY_DB_PATH legacy alias
// (config/paths.ts).
const DB_PATH = MESSAGE_REGISTRY_DB;

// Priority ordering for sorting
const PRIORITY_ORDER: Record<MessagePriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// ─── In-Memory Cache with TTL ────────────────────────────────────────────────
// Caches frequently accessed data to avoid DB queries every time

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const MODEL_CACHE_TTL_MS = 5000; // 5 seconds TTL for model cache
const UNREAD_CACHE_TTL_MS = 2000; // 2 seconds TTL for unread counts

// Cache for terminal models (terminal -> model)
const modelCache = new Map<string, CacheEntry<ModelType | null>>();

// Cache for unread counts (terminal:box -> messages)
const unreadCache = new Map<string, CacheEntry<RegisteredMessage[]>>();

/**
 * Get cached model for terminal, or null if expired/not cached
 */
function getCachedModel(terminal: string): ModelType | null | undefined {
  const entry = modelCache.get(terminal);
  if (entry && Date.now() < entry.expiry) {
    return entry.data;
  }
  modelCache.delete(terminal);
  return undefined; // undefined = not cached, null = cached as "no model"
}

/**
 * Set cached model for terminal
 */
function setCachedModel(terminal: string, model: ModelType | null): void {
  modelCache.set(terminal, {
    data: model,
    expiry: Date.now() + MODEL_CACHE_TTL_MS,
  });
}

/**
 * Invalidate model cache for terminal (call when inbox changes)
 */
export function invalidateModelCache(terminal: string): void {
  modelCache.delete(terminal);
  unreadCache.delete(`${terminal}:inbox`);
  unreadCache.delete(`${terminal}:outbox`);
}

/**
 * Invalidate all caches (call on bulk operations)
 */
export function invalidateAllCaches(): void {
  modelCache.clear();
  unreadCache.clear();
}

// ─── Database Setup ──────────────────────────────────────────────────────────

let db: Database.Database | null = null;

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const database = db!;

  // Main messages table
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      terminal TEXT NOT NULL,
      box TEXT NOT NULL CHECK (box IN ('inbox', 'outbox')),
      from_terminal TEXT NOT NULL,
      to_terminal TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('task', 'question', 'done', 'blocked', 'escalation', 'info', 'progress', 'freeform', 'notification', 'response', 'acknowledgment', 'test', 'answer', 'message', 'ack', 'decision', 'approved', 'research', 'rejected', 'verification', 'task_acknowledgment', 'session_complete', 'review', 'resolved', 'report', 'question_response', 'briefing', 'approval')),
      priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      priority_order INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'UNREAD' CHECK (status IN ('UNREAD', 'READ', 'PROCESSING', 'PROCESSED', 'ARCHIVED', 'COMPLETED', 'DONE', 'SKIPPED', 'DELEGATED', 'PENDING', 'SUPERSEDED', 'INJECTED', 'BLOCKED', 'PARTIAL', 'DUPLICATE', 'APPROVED')),
      model TEXT CHECK (model IN ('opus', 'sonnet', 'haiku', NULL)),
      ref_message_id TEXT,
      file_path TEXT NOT NULL,
      title TEXT,
      content_preview TEXT,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      first_read_at TEXT,
      read_at TEXT,
      processed_at TEXT,
      response_time_ms INTEGER
    )
  `);

  // Status change history (audit trail)
  database.exec(`
    CREATE TABLE IF NOT EXISTS message_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      changed_by TEXT,
      reason TEXT
    )
  `);

  // Indexes for common queries
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_terminal ON messages(terminal);
    CREATE INDEX IF NOT EXISTS idx_messages_box ON messages(box);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority_order DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_detected ON messages(detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_terminal);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_terminal);
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(status, terminal) WHERE status = 'UNREAD';
    CREATE INDEX IF NOT EXISTS idx_history_message ON message_status_history(message_id);
  `);

  // FTS5 for content search
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id,
      title,
      content_preview,
      content='messages',
      content_rowid='id'
    )
  `);

  // FTS5 sync triggers
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, message_id, title, content_preview)
      VALUES (new.id, new.message_id, new.title, new.content_preview);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, message_id, title, content_preview)
      VALUES ('delete', old.id, old.message_id, old.title, old.content_preview);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, message_id, title, content_preview)
      VALUES ('delete', old.id, old.message_id, old.title, old.content_preview);
      INSERT INTO messages_fts(rowid, message_id, title, content_preview)
      VALUES (new.id, new.message_id, new.title, new.content_preview);
    END
  `);

  logger.info('[MessageRegistry] Database schema initialized');
}

// ─── Hash Functions ──────────────────────────────────────────────────────────

/**
 * Extract body content (everything after frontmatter)
 */
function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/**
 * Calculate SHA-256 hash of file BODY content (excluding frontmatter)
 * This allows storing the hash in the frontmatter itself
 */
export async function calculateBodyHash(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const body = extractBody(content);
    return createHash('sha256').update(body, 'utf-8').digest('hex');
  } catch {
    return 'HASH_ERROR';
  }
}

/**
 * Calculate body hash from content string
 */
export function calculateBodyHashFromContent(content: string): string {
  const body = extractBody(content);
  return createHash('sha256').update(body, 'utf-8').digest('hex');
}

/**
 * Add or update content_hash in frontmatter of an .md file
 * Returns the hash that was written
 */
export async function stampFileWithHash(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const bodyHash = calculateBodyHashFromContent(content);

    // Check if frontmatter exists
    const frontmatterMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
    if (!frontmatterMatch) {
      logger.warn(`[MessageRegistry] No frontmatter in ${filePath}`);
      return bodyHash;
    }

    const frontmatterStart = frontmatterMatch[1];
    let frontmatterContent = frontmatterMatch[2];
    const frontmatterEnd = frontmatterMatch[3];
    const restOfFile = content.slice(frontmatterMatch[0].length);

    // Remove existing content_hash line if present
    frontmatterContent = frontmatterContent
      .split('\n')
      .filter(line => !line.startsWith('content_hash:'))
      .join('\n');

    // Add new content_hash
    frontmatterContent += `\ncontent_hash: ${bodyHash}`;

    // Reconstruct file
    const newContent = frontmatterStart + frontmatterContent + frontmatterEnd + restOfFile;
    await fs.writeFile(filePath, newContent, 'utf-8');

    logger.info(`[MessageRegistry] Stamped ${path.basename(filePath)} with hash: ${bodyHash.slice(0, 12)}...`);
    return bodyHash;
  } catch (err) {
    logger.error(`[MessageRegistry] Failed to stamp ${filePath}:`, err);
    return 'STAMP_ERROR';
  }
}

/**
 * Verify if current file body matches the registered hash AND the frontmatter hash
 */
export async function verifyMessageHash(messageId: string): Promise<{
  valid: boolean;
  registryHash: string;
  frontmatterHash: string | null;
  currentBodyHash: string;
  filePath: string;
  tampered: boolean;
}> {
  const database = getDb();
  const row = database.prepare('SELECT content_hash, file_path FROM messages WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined;

  if (!row) {
    return { valid: false, registryHash: '', frontmatterHash: null, currentBodyHash: '', filePath: '', tampered: false };
  }

  const registryHash = row.content_hash as string;
  const filePath = row.file_path as string;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const currentBodyHash = calculateBodyHashFromContent(content);

    // Extract frontmatter hash if present
    const frontmatterHashMatch = content.match(/content_hash:\s*([a-f0-9]+)/);
    const frontmatterHash = frontmatterHashMatch ? frontmatterHashMatch[1] : null;

    // Validation logic:
    // 1. Registry hash must match current body hash
    // 2. If frontmatter has hash, it must also match
    const registryValid = registryHash === currentBodyHash;
    const frontmatterValid = !frontmatterHash || frontmatterHash === currentBodyHash;

    return {
      valid: registryValid && frontmatterValid,
      registryHash,
      frontmatterHash,
      currentBodyHash,
      filePath,
      tampered: !registryValid || !frontmatterValid,
    };
  } catch (err) {
    return {
      valid: false,
      registryHash,
      frontmatterHash: null,
      currentBodyHash: 'READ_ERROR',
      filePath,
      tampered: true,
    };
  }
}

/**
 * Verify all messages and return tampering report
 */
export async function verifyAllMessages(): Promise<{
  total: number;
  valid: number;
  tampered: Array<{ messageId: string; filePath: string; details: string }>;
}> {
  const database = getDb();
  const rows = database.prepare('SELECT message_id FROM messages').all() as Array<{ message_id: string }>;

  const result = {
    total: rows.length,
    valid: 0,
    tampered: [] as Array<{ messageId: string; filePath: string; details: string }>,
  };

  for (const row of rows) {
    const verification = await verifyMessageHash(row.message_id);
    if (verification.valid) {
      result.valid++;
    } else {
      result.tampered.push({
        messageId: row.message_id,
        filePath: verification.filePath,
        details: verification.tampered
          ? `Registry: ${verification.registryHash.slice(0, 8)}... vs Current: ${verification.currentBodyHash.slice(0, 8)}...`
          : 'File not found',
      });
    }
  }

  return result;
}

// ─── Core Operations ─────────────────────────────────────────────────────────

/**
 * Register a new message (called by InboxWatcher)
 * 1. Calculates SHA-256 hash of file BODY (excluding frontmatter)
 * 2. Stamps the hash into the file's frontmatter
 * 3. Stores in registry for verification
 */
export async function registerMessage(input: MessageInput): Promise<RegisteredMessage> {
  await ensureDataDir();
  const database = getDb();

  // Check if already registered (idempotent)
  const existing = database.prepare('SELECT * FROM messages WHERE message_id = ?').get(input.messageId);
  if (existing) {
    logger.info(`[MessageRegistry] Message ${input.messageId} already registered`);
    return rowToMessage(existing as Record<string, unknown>);
  }

  // Calculate body hash and stamp into frontmatter
  // This provides double verification: registry + frontmatter
  const contentHash = await stampFileWithHash(input.filePath);

  const stmt = database.prepare(`
    INSERT INTO messages (
      message_id, terminal, box, from_terminal, to_terminal,
      type, priority, priority_order, status, model,
      ref_message_id, file_path, title, content_preview, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const priorityOrder = PRIORITY_ORDER[input.priority] || 2;

  const result = stmt.run(
    input.messageId,
    input.terminal,
    input.box,
    input.fromTerminal,
    input.toTerminal,
    input.type,
    input.priority,
    priorityOrder,
    input.status,
    input.model || null,
    input.refMessageId || null,
    input.filePath,
    input.title || null,
    input.contentPreview || null,
    contentHash,
    input.createdAt
  );

  // Log initial status
  logStatusChange(input.messageId, null, input.status, 'inbox_watcher', 'Initial registration');

  const id = result.lastInsertRowid as number;
  logger.info(`[MessageRegistry] Registered message #${id}: ${input.messageId} (${input.type}/${input.priority}) [hash: ${contentHash.slice(0, 12)}...]`);

  const selectStmt = database.prepare('SELECT * FROM messages WHERE id = ?');
  return rowToMessage(selectStmt.get(id) as Record<string, unknown>);
}

/**
 * Update message status with audit trail
 * Sets first_read_at on first READ transition (immutable timestamp)
 */
export async function updateStatus(
  messageId: string,
  newStatus: MessageStatus,
  changedBy?: string,
  reason?: string
): Promise<RegisteredMessage | null> {
  const database = getDb();

  const current = database.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined;
  if (!current) {
    logger.warn(`[MessageRegistry] Message ${messageId} not found`);
    return null;
  }

  const oldStatus = current.status as MessageStatus;
  if (oldStatus === newStatus) {
    return rowToMessage(current);
  }

  const now = new Date().toISOString();
  let responseTimeMs: number | null = null;

  // Calculate response time when transitioning to PROCESSED
  if (newStatus === 'PROCESSED' && current.created_at) {
    const createdAt = new Date(current.created_at as string);
    responseTimeMs = Date.now() - createdAt.getTime();
  }

  // Update timestamps based on new status
  let updateSql = 'UPDATE messages SET status = ?';
  const params: (string | number | null)[] = [newStatus];

  // Set first_read_at ONLY on first READ transition (immutable)
  // This timestamp can be used for validation - it should never change
  if (newStatus === 'READ' && oldStatus === 'UNREAD' && !current.first_read_at) {
    updateSql += ', first_read_at = ?';
    params.push(now);
  }

  // Update read_at on any READ transition
  if (newStatus === 'READ') {
    updateSql += ', read_at = ?';
    params.push(now);
  }

  if (newStatus === 'PROCESSED' || newStatus === 'ARCHIVED') {
    updateSql += ', processed_at = ?';
    params.push(now);
    if (responseTimeMs !== null) {
      updateSql += ', response_time_ms = ?';
      params.push(responseTimeMs);
    }
  }

  updateSql += ' WHERE message_id = ?';
  params.push(messageId);

  database.prepare(updateSql).run(...params);

  // Log status change
  logStatusChange(messageId, oldStatus, newStatus, changedBy, reason);

  // Invalidate cache for this terminal
  const terminal = current.terminal as string;
  invalidateModelCache(terminal);

  const isFirstRead = oldStatus === 'UNREAD' && newStatus === 'READ';
  logger.info(`[MessageRegistry] ${messageId}: ${oldStatus} → ${newStatus}${isFirstRead ? ' [FIRST READ]' : ''}${responseTimeMs ? ` (${Math.round(responseTimeMs / 1000)}s)` : ''}`);

  const updated = database.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
  return rowToMessage(updated as Record<string, unknown>);
}

/**
 * Batch update multiple message statuses in a single transaction
 * Much more efficient than calling updateStatus() multiple times
 */
export function batchUpdateStatus(
  updates: Array<{ messageId: string; newStatus: MessageStatus; changedBy?: string; reason?: string }>
): { updated: number; failed: string[] } {
  const database = getDb();
  const failed: string[] = [];
  let updated = 0;

  const terminalsToInvalidate = new Set<string>();

  // Use a transaction for atomicity and performance
  const transaction = database.transaction(() => {
    for (const { messageId, newStatus, changedBy, reason } of updates) {
      try {
        const current = database.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined;
        if (!current) {
          failed.push(messageId);
          continue;
        }

        const oldStatus = current.status as MessageStatus;
        if (oldStatus === newStatus) {
          continue; // Skip if no change
        }

        const now = new Date().toISOString();
        let responseTimeMs: number | null = null;

        if (newStatus === 'PROCESSED' && current.created_at) {
          const createdAt = new Date(current.created_at as string);
          responseTimeMs = Date.now() - createdAt.getTime();
        }

        let updateSql = 'UPDATE messages SET status = ?';
        const params: (string | number | null)[] = [newStatus];

        if (newStatus === 'READ' && oldStatus === 'UNREAD' && !current.first_read_at) {
          updateSql += ', first_read_at = ?';
          params.push(now);
        }

        if (newStatus === 'READ') {
          updateSql += ', read_at = ?';
          params.push(now);
        }

        if (newStatus === 'PROCESSED' || newStatus === 'ARCHIVED') {
          updateSql += ', processed_at = ?';
          params.push(now);
          if (responseTimeMs !== null) {
            updateSql += ', response_time_ms = ?';
            params.push(responseTimeMs);
          }
        }

        updateSql += ' WHERE message_id = ?';
        params.push(messageId);

        database.prepare(updateSql).run(...params);
        logStatusChange(messageId, oldStatus, newStatus, changedBy, reason);

        terminalsToInvalidate.add(current.terminal as string);
        updated++;
      } catch (err) {
        logger.error(`[MessageRegistry] Batch update failed for ${messageId}:`, err);
        failed.push(messageId);
      }
    }
  });

  transaction();

  // Invalidate caches for all affected terminals
  for (const terminal of terminalsToInvalidate) {
    invalidateModelCache(terminal);
  }

  logger.info(`[MessageRegistry] Batch update: ${updated} updated, ${failed.length} failed`);
  return { updated, failed };
}

/**
 * Mark message as READ (convenience method)
 */
export async function markAsRead(messageId: string, changedBy?: string): Promise<RegisteredMessage | null> {
  return updateStatus(messageId, 'READ', changedBy, 'Terminal started processing');
}

/**
 * Mark message as PROCESSED (convenience method)
 */
export async function markAsProcessed(messageId: string, changedBy?: string): Promise<RegisteredMessage | null> {
  return updateStatus(messageId, 'PROCESSED', changedBy, 'Task completed');
}

// ─── Query Operations ────────────────────────────────────────────────────────

/**
 * Query messages with flexible filters
 */
export function queryMessages(query: MessageQuery = {}): RegisteredMessage[] {
  const database = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.terminal) {
    conditions.push('terminal = ?');
    params.push(query.terminal);
  }

  if (query.box) {
    conditions.push('box = ?');
    params.push(query.box);
  }

  if (query.status) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status];
    conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }

  if (query.type) {
    const types = Array.isArray(query.type) ? query.type : [query.type];
    conditions.push(`type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }

  if (query.priority) {
    const priorities = Array.isArray(query.priority) ? query.priority : [query.priority];
    conditions.push(`priority IN (${priorities.map(() => '?').join(',')})`);
    params.push(...priorities);
  }

  if (query.fromTerminal) {
    conditions.push('from_terminal = ?');
    params.push(query.fromTerminal);
  }

  if (query.toTerminal) {
    conditions.push('to_terminal = ?');
    params.push(query.toTerminal);
  }

  if (query.since) {
    conditions.push('created_at >= ?');
    params.push(query.since);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Order by
  let orderColumn = 'detected_at';
  if (query.orderBy === 'createdAt') orderColumn = 'created_at';
  if (query.orderBy === 'priority') orderColumn = 'priority_order';
  const orderDir = query.orderDir || 'DESC';

  const limit = query.limit || 100;
  const offset = query.offset || 0;

  const sql = `
    SELECT * FROM messages
    ${whereClause}
    ORDER BY ${orderColumn} ${orderDir}
    LIMIT ? OFFSET ?
  `;

  params.push(limit, offset);

  const rows = database.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToMessage);
}

/**
 * Get all UNREAD messages for a terminal (with caching)
 */
export function getUnreadMessages(terminal: string, box?: MessageBox): RegisteredMessage[] {
  // Check cache first
  const cacheKey = `${terminal}:${box || 'all'}`;
  const cached = unreadCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  // Query DB
  const result = queryMessages({
    terminal,
    box,
    status: 'UNREAD',
    orderBy: 'priority',
    orderDir: 'DESC',
  });

  // Cache result
  unreadCache.set(cacheKey, {
    data: result,
    expiry: Date.now() + UNREAD_CACHE_TTL_MS,
  });

  return result;
}

/**
 * Get model for terminal from cache or DB
 * Optimized path for frequent model lookups
 */
export function getTerminalModel(terminal: string): ModelType | null {
  // Check cache first
  const cached = getCachedModel(terminal);
  if (cached !== undefined) {
    return cached;
  }

  // Query DB for first UNREAD inbox message with model
  const unread = getUnreadMessages(terminal, 'inbox');
  const model = unread.length > 0 && unread[0].model ? unread[0].model : null;

  // Cache result
  setCachedModel(terminal, model);

  return model;
}

/**
 * Get message by ID
 */
export function getMessage(messageId: string): RegisteredMessage | null {
  const database = getDb();
  const row = database.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
  return row ? rowToMessage(row as Record<string, unknown>) : null;
}

/**
 * Search messages by content
 */
export function searchMessages(query: string, limit: number = 20): RegisteredMessage[] {
  const database = getDb();

  // Escape FTS5 special chars
  const escaped = query.replace(/"/g, '""').replace(/[*^$]/g, ' ').trim();
  const terms = escaped.split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  const matchExpr = terms.map(t => `"${t}"*`).join(' OR ');

  const sql = `
    SELECT m.* FROM messages m
    JOIN messages_fts fts ON m.id = fts.rowid
    WHERE messages_fts MATCH ?
    ORDER BY m.detected_at DESC
    LIMIT ?
  `;

  const rows = database.prepare(sql).all(matchExpr, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMessage);
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/**
 * Get comprehensive message statistics
 */
export function getMessageStats(): MessageStats {
  const database = getDb();

  const total = (database.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;

  // By status
  const byStatus: Record<string, number> = {};
  const statusRows = database.prepare('SELECT status, COUNT(*) as count FROM messages GROUP BY status').all() as Array<{ status: string; count: number }>;
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
  }

  // By type
  const byType: Record<string, number> = {};
  const typeRows = database.prepare('SELECT type, COUNT(*) as count FROM messages GROUP BY type').all() as Array<{ type: string; count: number }>;
  for (const row of typeRows) {
    byType[row.type] = row.count;
  }

  // By priority
  const byPriority: Record<string, number> = {};
  const priorityRows = database.prepare('SELECT priority, COUNT(*) as count FROM messages GROUP BY priority').all() as Array<{ priority: string; count: number }>;
  for (const row of priorityRows) {
    byPriority[row.priority] = row.count;
  }

  // By terminal
  const byTerminal: Record<string, { inbox: number; outbox: number; unread: number }> = {};
  const terminalRows = database.prepare(`
    SELECT terminal, box, status, COUNT(*) as count
    FROM messages
    GROUP BY terminal, box, status
  `).all() as Array<{ terminal: string; box: string; status: string; count: number }>;

  for (const row of terminalRows) {
    if (!byTerminal[row.terminal]) {
      byTerminal[row.terminal] = { inbox: 0, outbox: 0, unread: 0 };
    }
    if (row.box === 'inbox') byTerminal[row.terminal].inbox += row.count;
    if (row.box === 'outbox') byTerminal[row.terminal].outbox += row.count;
    if (row.status === 'UNREAD') byTerminal[row.terminal].unread += row.count;
  }

  // Average response time
  const avgRow = database.prepare(`
    SELECT AVG(response_time_ms) as avg FROM messages
    WHERE response_time_ms IS NOT NULL
  `).get() as { avg: number | null };

  // Oldest unread
  const oldestRow = database.prepare(`
    SELECT * FROM messages
    WHERE status = 'UNREAD'
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;

  return {
    total,
    byStatus: byStatus as Record<MessageStatus, number>,
    byType: byType as Record<MessageType, number>,
    byPriority: byPriority as Record<MessagePriority, number>,
    byTerminal,
    avgResponseTimeMs: avgRow.avg ?? 0,
    oldestUnread: oldestRow ? rowToMessage(oldestRow) : undefined,
  };
}

/**
 * Get status history for a message
 */
export function getStatusHistory(messageId: string): Array<{
  oldStatus: string | null;
  newStatus: string;
  changedAt: string;
  changedBy: string | null;
  reason: string | null;
}> {
  const database = getDb();
  const rows = database.prepare(`
    SELECT old_status, new_status, changed_at, changed_by, reason
    FROM message_status_history
    WHERE message_id = ?
    ORDER BY changed_at ASC
  `).all(messageId) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    oldStatus: row.old_status as string | null,
    newStatus: row.new_status as string,
    changedAt: row.changed_at as string,
    changedBy: row.changed_by as string | null,
    reason: row.reason as string | null,
  }));
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function logStatusChange(
  messageId: string,
  oldStatus: MessageStatus | null,
  newStatus: MessageStatus,
  changedBy?: string,
  reason?: string
): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO message_status_history (message_id, old_status, new_status, changed_by, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(messageId, oldStatus, newStatus, changedBy || null, reason || null);
}

function rowToMessage(row: Record<string, unknown>): RegisteredMessage {
  return {
    id: row.id as number,
    messageId: row.message_id as string,
    terminal: row.terminal as string,
    box: row.box as MessageBox,
    fromTerminal: row.from_terminal as string,
    toTerminal: row.to_terminal as string,
    type: row.type as MessageType,
    priority: row.priority as MessagePriority,
    status: row.status as MessageStatus,
    model: row.model as ModelType | undefined,
    refMessageId: row.ref_message_id as string | undefined,
    filePath: row.file_path as string,
    title: row.title as string | undefined,
    contentPreview: row.content_preview as string | undefined,
    contentHash: row.content_hash as string,
    createdAt: row.created_at as string,
    detectedAt: row.detected_at as string,
    firstReadAt: row.first_read_at as string | undefined,
    readAt: row.read_at as string | undefined,
    processedAt: row.processed_at as string | undefined,
    responseTimeMs: row.response_time_ms as number | undefined,
  };
}

/**
 * Close the database connection
 */
export function closeMessageRegistry(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('[MessageRegistry] Database connection closed');
  }
}

// ─── Sync with Filesystem ────────────────────────────────────────────────────

/**
 * Sync registry with filesystem (call on startup)
 * Scans all terminal inboxes/outboxes and registers any missing messages
 */
export async function syncWithFilesystem(): Promise<{ registered: number; updated: number }> {
  const terminalsRoot = getTerminalsPath();
  let registered = 0;
  let updated = 0;

  try {
    const terminals = await fs.readdir(terminalsRoot);

    for (const terminal of terminals) {
      if (terminal.startsWith('.') || terminal.startsWith('_')) continue;

      const terminalPath = path.join(terminalsRoot, terminal);
      const stat = await fs.stat(terminalPath);
      if (!stat.isDirectory()) continue;

      // Scan inbox
      const inboxPath = path.join(terminalPath, 'inbox');
      try {
        const inboxFiles = await fs.readdir(inboxPath);
        for (const file of inboxFiles.filter(f => f.endsWith('.md'))) {
          const result = await syncMessageFile(path.join(inboxPath, file), terminal, 'inbox');
          if (result === 'registered') registered++;
          if (result === 'updated') updated++;
        }
      } catch { /* inbox doesn't exist */ }

      // Scan outbox
      const outboxPath = path.join(terminalPath, 'outbox');
      try {
        const outboxFiles = await fs.readdir(outboxPath);
        for (const file of outboxFiles.filter(f => f.endsWith('.md'))) {
          const result = await syncMessageFile(path.join(outboxPath, file), terminal, 'outbox');
          if (result === 'registered') registered++;
          if (result === 'updated') updated++;
        }
      } catch { /* outbox doesn't exist */ }
    }

    logger.info(`[MessageRegistry] Sync complete: ${registered} registered, ${updated} updated`);
  } catch (err) {
    logger.error('[MessageRegistry] Sync error:', err);
  }

  return { registered, updated };
}

async function syncMessageFile(
  filePath: string,
  terminal: string,
  box: MessageBox
): Promise<'registered' | 'updated' | 'skipped'> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter || !frontmatter.id) return 'skipped';

    const database = getDb();
    const existing = database.prepare('SELECT * FROM messages WHERE message_id = ?').get(frontmatter.id);

    if (existing) {
      // Update status if changed
      const currentStatus = (existing as Record<string, unknown>).status as string;
      if (currentStatus !== frontmatter.status) {
        await updateStatus(frontmatter.id, frontmatter.status as MessageStatus, 'filesystem_sync', 'Status changed in file');
        return 'updated';
      }
      return 'skipped';
    }

    // Extract title from content
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : undefined;

    // Get content preview (first 200 chars after frontmatter)
    const contentStart = content.indexOf('---', 3);
    const bodyContent = contentStart > 0 ? content.slice(contentStart + 3).trim() : '';
    const contentPreview = bodyContent.slice(0, 200);

    await registerMessage({
      messageId: frontmatter.id,
      terminal,
      box,
      fromTerminal: frontmatter.from || 'unknown',
      toTerminal: frontmatter.to || terminal,
      type: (frontmatter.type as MessageType) || 'task',
      priority: (frontmatter.priority as MessagePriority) || 'medium',
      status: (frontmatter.status as MessageStatus) || 'UNREAD',
      model: frontmatter.model as ModelType | undefined,
      refMessageId: frontmatter.ref,
      filePath,
      title,
      contentPreview,
      createdAt: frontmatter.created || new Date().toISOString().split('T')[0],
    });

    return 'registered';
  } catch (err) {
    logger.error(`[MessageRegistry] Error syncing ${filePath}:`, err);
    return 'skipped';
  }
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}
