/**
 * Conversation Manager for Telegram Messages
 *
 * SQLite-backed storage for tracking conversations between
 * Telegram users and SpaceOS terminals.
 *
 * Features:
 * - Conversation context tracking
 * - Message history (in/out)
 * - Response queue for agent replies
 * - Multi-terminal conversation support
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConversationStatus = 'active' | 'closed' | 'expired';
export type MessageDirection = 'in' | 'out';
export type ResponseStatus = 'pending' | 'sent' | 'failed';

export interface Conversation {
  id: number;
  chatId: number;
  userId: number;
  username: string | null;
  contextTerminal: string | null;  // Current terminal handling this
  taskId: string | null;           // Linked MSG-XXX-NNN if any
  status: ConversationStatus;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: number;
  conversationId: number;
  telegramMessageId: number;
  direction: MessageDirection;
  content: string;
  fromTerminal: string | null;     // For outgoing messages
  replyToMessageId: number | null;
  createdAt: string;
}

export interface ResponseQueueItem {
  id: number;
  chatId: number;
  conversationId: number | null;
  message: string;
  replyToMessageId: number | null;
  fromTerminal: string;
  parseMode: 'HTML' | 'Markdown';
  status: ResponseStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface CreateConversationInput {
  chatId: number;
  userId: number;
  username?: string;
  contextTerminal?: string;
  taskId?: string;
}

export interface AddMessageInput {
  conversationId: number;
  telegramMessageId: number;
  direction: MessageDirection;
  content: string;
  fromTerminal?: string;
  replyToMessageId?: number;
}

export interface QueueResponseInput {
  chatId: number;
  conversationId?: number;
  message: string;
  replyToMessageId?: number;
  fromTerminal: string;
  parseMode?: 'HTML' | 'Markdown';
}

// ─── Constants ───────────────────────────────────────────────────────────────

import { DATA_DIR } from '../config/paths';
import { logger } from '../core/logger';
const DB_PATH = process.env.TELEGRAM_DB_PATH || path.join(DATA_DIR, 'telegram.db');

// Conversation expires after 24 hours of inactivity
const CONVERSATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ─── Database Schema ─────────────────────────────────────────────────────────

const SCHEMA = `
-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  context_terminal TEXT,
  task_id TEXT,
  status TEXT DEFAULT 'active',
  message_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_chat_id ON conversations(chat_id);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conv_terminal ON conversations(context_terminal);

-- Messages in conversations
CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  from_terminal TEXT,
  reply_to_message_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_msg_conv_id ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_direction ON conversation_messages(direction);

-- Response queue (async sending)
CREATE TABLE IF NOT EXISTS response_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  conversation_id INTEGER,
  message TEXT NOT NULL,
  reply_to_message_id INTEGER,
  from_terminal TEXT NOT NULL,
  parse_mode TEXT DEFAULT 'HTML',
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON response_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_chat ON response_queue(chat_id);
`;

// ─── Database Singleton ──────────────────────────────────────────────────────

let db: DatabaseType | null = null;

function getDb(): DatabaseType {
  if (!db) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(SCHEMA);

    logger.info(`[ConversationManager] Database initialized at ${DB_PATH}`);
  }
  return db;
}

// ─── Conversation Functions ──────────────────────────────────────────────────

/**
 * Find active conversation for a chat
 */
export function findActiveConversation(chatId: number): Conversation | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT * FROM conversations
    WHERE chat_id = ? AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(chatId) as any;

  if (!row) return null;

  return mapConversation(row);
}

/**
 * Create a new conversation
 */
export function createConversation(input: CreateConversationInput): Conversation {
  const db = getDb();

  // Close any existing active conversations for this chat
  db.prepare(`
    UPDATE conversations
    SET status = 'closed', updated_at = datetime('now')
    WHERE chat_id = ? AND status = 'active'
  `).run(input.chatId);

  const result = db.prepare(`
    INSERT INTO conversations (chat_id, user_id, username, context_terminal, task_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.chatId,
    input.userId,
    input.username || null,
    input.contextTerminal || null,
    input.taskId || null
  );

  return getConversation(result.lastInsertRowid as number)!;
}

/**
 * Get conversation by ID
 */
export function getConversation(id: number): Conversation | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
  return row ? mapConversation(row) : null;
}

/**
 * Update conversation context
 */
export function updateConversationContext(
  id: number,
  contextTerminal: string,
  taskId?: string
): void {
  const db = getDb();
  db.prepare(`
    UPDATE conversations
    SET context_terminal = ?,
        task_id = COALESCE(?, task_id),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(contextTerminal, taskId || null, id);
}

/**
 * Close a conversation
 */
export function closeConversation(id: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE conversations
    SET status = 'closed', updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

/**
 * Get or create conversation for a chat
 */
export function getOrCreateConversation(input: CreateConversationInput): Conversation {
  const existing = findActiveConversation(input.chatId);
  if (existing) {
    // Update the terminal context if changed
    if (input.contextTerminal && input.contextTerminal !== existing.contextTerminal) {
      updateConversationContext(existing.id, input.contextTerminal, input.taskId);
      return getConversation(existing.id)!;
    }
    return existing;
  }
  return createConversation(input);
}

// ─── Message Functions ───────────────────────────────────────────────────────

/**
 * Add a message to a conversation
 */
export function addMessage(input: AddMessageInput): ConversationMessage {
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO conversation_messages
    (conversation_id, telegram_message_id, direction, content, from_terminal, reply_to_message_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.conversationId,
    input.telegramMessageId,
    input.direction,
    input.content,
    input.fromTerminal || null,
    input.replyToMessageId || null
  );

  // Update conversation message count and timestamp
  db.prepare(`
    UPDATE conversations
    SET message_count = message_count + 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(input.conversationId);

  return getMessage(result.lastInsertRowid as number)!;
}

/**
 * Get message by ID
 */
export function getMessage(id: number): ConversationMessage | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id) as any;
  return row ? mapMessage(row) : null;
}

/**
 * Get recent messages in a conversation
 */
export function getConversationMessages(
  conversationId: number,
  limit: number = 10
): ConversationMessage[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM conversation_messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(conversationId, limit) as any[];

  return rows.map(mapMessage).reverse();
}

/**
 * Get the last incoming message ID for a conversation
 */
export function getLastIncomingMessageId(conversationId: number): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT telegram_message_id FROM conversation_messages
    WHERE conversation_id = ? AND direction = 'in'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(conversationId) as any;

  return row ? row.telegram_message_id : null;
}

// ─── Response Queue Functions ────────────────────────────────────────────────

/**
 * Queue a response to be sent
 */
export function queueResponse(input: QueueResponseInput): ResponseQueueItem {
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO response_queue
    (chat_id, conversation_id, message, reply_to_message_id, from_terminal, parse_mode)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.chatId,
    input.conversationId || null,
    input.message,
    input.replyToMessageId || null,
    input.fromTerminal,
    input.parseMode || 'HTML'
  );

  return getQueueItem(result.lastInsertRowid as number)!;
}

/**
 * Get queue item by ID
 */
export function getQueueItem(id: number): ResponseQueueItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM response_queue WHERE id = ?').get(id) as any;
  return row ? mapQueueItem(row) : null;
}

/**
 * Get pending responses from queue
 */
export function getPendingResponses(limit: number = 10): ResponseQueueItem[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM response_queue
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map(mapQueueItem);
}

/**
 * Mark response as sent
 */
export function markResponseSent(id: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE response_queue
    SET status = 'sent', sent_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

/**
 * Mark response as failed
 */
export function markResponseFailed(id: number, error: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE response_queue
    SET status = 'failed',
        attempts = attempts + 1,
        last_error = ?
    WHERE id = ?
  `).run(error, id);
}

/**
 * Retry failed responses (up to 3 attempts)
 */
export function retryFailedResponses(): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE response_queue
    SET status = 'pending'
    WHERE status = 'failed' AND attempts < 3
  `).run();

  return result.changes;
}

/**
 * Get queue stats
 */
export function getQueueStats(): { pending: number; sent: number; failed: number } {
  const db = getDb();

  const pending = db.prepare("SELECT COUNT(*) as count FROM response_queue WHERE status = 'pending'").get() as any;
  const sent = db.prepare("SELECT COUNT(*) as count FROM response_queue WHERE status = 'sent'").get() as any;
  const failed = db.prepare("SELECT COUNT(*) as count FROM response_queue WHERE status = 'failed'").get() as any;

  return {
    pending: pending.count,
    sent: sent.count,
    failed: failed.count,
  };
}

// ─── Cleanup Functions ───────────────────────────────────────────────────────

/**
 * Expire old conversations
 */
export function expireOldConversations(): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - CONVERSATION_EXPIRY_MS).toISOString();

  const result = db.prepare(`
    UPDATE conversations
    SET status = 'expired'
    WHERE status = 'active' AND updated_at < ?
  `).run(cutoff);

  return result.changes;
}

/**
 * Clean up old sent responses (older than 7 days)
 */
export function cleanupOldResponses(): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    DELETE FROM response_queue
    WHERE status = 'sent' AND sent_at < ?
  `).run(cutoff);

  return result.changes;
}

// ─── Mapping Functions ───────────────────────────────────────────────────────

function mapConversation(row: any): Conversation {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    username: row.username,
    contextTerminal: row.context_terminal,
    taskId: row.task_id,
    status: row.status as ConversationStatus,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: any): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    telegramMessageId: row.telegram_message_id,
    direction: row.direction as MessageDirection,
    content: row.content,
    fromTerminal: row.from_terminal,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
  };
}

function mapQueueItem(row: any): ResponseQueueItem {
  return {
    id: row.id,
    chatId: row.chat_id,
    conversationId: row.conversation_id,
    message: row.message,
    replyToMessageId: row.reply_to_message_id,
    fromTerminal: row.from_terminal,
    parseMode: row.parse_mode as 'HTML' | 'Markdown',
    status: row.status as ResponseStatus,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

// ─── Terminal-specific History ───────────────────────────────────────────────

/**
 * Get recent messages for a specific terminal (for chat session context)
 * Searches across all conversations where this terminal is the target
 */
export function getRecentMessagesForTerminal(
  terminal: string,
  limit: number = 15
): ConversationMessage[] {
  const db = getDb();

  // Get conversation IDs for this terminal
  const conversations = db.prepare(`
    SELECT id FROM conversations
    WHERE context_terminal = ?
    ORDER BY updated_at DESC
    LIMIT 5
  `).all(terminal) as { id: number }[];

  if (conversations.length === 0) {
    return [];
  }

  const conversationIds = conversations.map(c => c.id);
  const placeholders = conversationIds.map(() => '?').join(',');

  // Get recent messages from these conversations
  const rows = db.prepare(`
    SELECT * FROM conversation_messages
    WHERE conversation_id IN (${placeholders})
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...conversationIds, limit) as any[];

  return rows.map(mapMessage).reverse();
}

// ─── Initialize on import ────────────────────────────────────────────────────

// Eagerly initialize DB when module loads
try {
  getDb();
} catch (err) {
  logger.error('[ConversationManager] Failed to initialize database:', err);
}
