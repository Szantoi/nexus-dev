/**
 * TaskMessageBox Store
 *
 * SQLite-backed message store with automatic .md file rendering.
 * Single source of truth for all task/message operations.
 */

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  Message,
  MessageNote,
  TerminalStatus,
  CreateTaskInput,
  CompleteMessageInput,
  AppendNoteInput,
  MessageFilter,
  CreateResult,
  UpdateResult,
  QueryResult,
  MessageStatus,
  FederationSendInput,
  FederationInboxItem,
  StatusHistoryEntry,
} from './types';
import { isValidTransition, canonicalTypes, canonicalStatuses } from './message-model';

// ─── Constants ───────────────────────────────────────────────────────────────

import { DATA_DIR, TERMINALS_PATH } from '../config/paths';
import { logger } from '../core/logger';

const DB_PATH = path.join(DATA_DIR, 'taskmessagebox.db');
const TERMINALS_ROOT = TERMINALS_PATH;

// ─── Config-driven schema ────────────────────────────────────────────────────
// The message `type` and `status` vocabularies live in config/message-model.yaml
// (the single source of truth). The DB CHECK constraints are DERIVED from it via
// canonicalTypes()/canonicalStatuses() — never hardcoded — so extending the model
// in config keeps the DB constraints in lockstep (no "done vs response" drift).

const quoted = (xs: string[]) => xs.map((x) => `'${x}'`).join(', ');

// Full column list, in schema order — reused by the stale-CHECK rebuild migration.
const MESSAGE_COLUMNS = [
  'id', 'from_terminal', 'to_terminal', 'from_island', 'to_island', 'type', 'priority', 'status',
  'title', 'description', 'acceptance_criteria', 'context', 'completion_summary', 'completion_details',
  'files_changed', 'blocked_reason', 'next_steps', 'ref_id', 'epic_id', 'project_id', 'model',
  'content_hash', 'status_history', 'created_at', 'read_at', 'started_at', 'completed_at', 'updated_at',
  'rendered_path', 'last_rendered_at',
];

/** DDL for the messages table (or a rebuild twin), type/status CHECK from config. */
function messagesTableDDL(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    id TEXT PRIMARY KEY,
    from_terminal TEXT NOT NULL,
    to_terminal TEXT NOT NULL,
    from_island TEXT,
    to_island TEXT,
    type TEXT NOT NULL CHECK (type IN (${quoted(canonicalTypes())})),
    priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN (${quoted(canonicalStatuses())})),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    acceptance_criteria TEXT,
    context TEXT,
    completion_summary TEXT,
    completion_details TEXT,
    files_changed TEXT,
    blocked_reason TEXT,
    next_steps TEXT,
    ref_id TEXT,
    epic_id TEXT,
    project_id TEXT,
    model TEXT CHECK (model IN ('haiku', 'sonnet', 'opus')),
    content_hash TEXT NOT NULL,
    status_history TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    rendered_path TEXT,
    last_rendered_at TEXT,
    FOREIGN KEY (ref_id) REFERENCES messages(id)
)`;
}

// Index DDL for the messages table (recreated after a rebuild migration).
const MESSAGE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_messages_to_terminal ON messages(to_terminal);
CREATE INDEX IF NOT EXISTS idx_messages_from_terminal ON messages(from_terminal);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
CREATE INDEX IF NOT EXISTS idx_messages_epic ON messages(epic_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`;

function buildSchema(): string {
  return `
-- TaskMessageBox SQLite Schema (type/status CHECKs generated from message-model.yaml)
${messagesTableDDL('messages')};
${MESSAGE_INDEXES}
-- idx_messages_to_island is created in the migration block below, AFTER the
-- to_island column is guaranteed (ALTER on pre-existing DBs).

CREATE TABLE IF NOT EXISTS message_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    section TEXT NOT NULL CHECK (section IN ('notes', 'implementation', 'feedback', 'blockers', 'progress')),
    content TEXT NOT NULL,
    author TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_message ON message_notes(message_id);

CREATE TABLE IF NOT EXISTS terminal_status (
    terminal TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'blocked')),
    current_task_id TEXT,
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (current_task_id) REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS message_sequence (
    terminal TEXT PRIMARY KEY,
    last_number INTEGER NOT NULL DEFAULT 0
);
`;
}

/**
 * Rebuild the messages table when its `type` CHECK constraint has drifted from the
 * canonical model (e.g. a DB created before `response` became a type, or when it
 * still carries legacy `done`/`blocked` as *types*). SQLite cannot ALTER a CHECK,
 * so we do the documented 12-step table rebuild — inside a transaction, preserving
 * every row and its status_history. No-op when the constraint already matches.
 */
function migrateTypeCheckIfStale(db: Database.Database): void {
  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'`)
    .get() as { sql: string } | undefined)?.sql || '';
  const m = ddl.match(/type\s+TEXT[^,]*?CHECK\s*\(\s*type\s+IN\s*\(([^)]*)\)/i);
  if (!m) return; // unrecognized shape — leave it alone
  const present = (m[1].match(/'([^']*)'/g) || []).map((s) => s.replace(/'/g, ''));
  const canon = canonicalTypes();
  const sameSet = canon.length === present.length && canon.every((t) => present.includes(t));
  if (sameSet) return; // already canonical

  logger.info(`[TaskMessageBox] messages.type CHECK drift ${JSON.stringify(present)} → ${JSON.stringify(canon)}; rebuilding table (config-driven).`);
  const oldCols = new Set((db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((c) => c.name));
  const colList = MESSAGE_COLUMNS.filter((c) => oldCols.has(c)).join(', ');

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(messagesTableDDL('messages_new') + ';');
    db.exec(`INSERT INTO messages_new (${colList}) SELECT ${colList} FROM messages`);
    db.exec(`DROP TABLE messages`);
    db.exec(`ALTER TABLE messages_new RENAME TO messages`);
    db.exec(MESSAGE_INDEXES); // indexes were dropped with the old table
  })();
  db.pragma('foreign_keys = ON');
}

// ─── Database Instance ───────────────────────────────────────────────────────

let db: Database.Database | null = null;

export async function initDatabase(): Promise<void> {
  // Ensure data directory exists
  await fs.mkdir(DATA_DIR, { recursive: true });

  // Open database
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema (type/status CHECKs generated from the canonical message-model)
  db.exec(buildSchema());

  // Migration: add federation island columns to pre-existing message tables.
  // (CREATE TABLE IF NOT EXISTS won't add columns to an already-created table.)
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  const has = (c: string) => cols.some(col => col.name === c);
  if (!has('from_island')) db.exec(`ALTER TABLE messages ADD COLUMN from_island TEXT`);
  if (!has('to_island')) db.exec(`ALTER TABLE messages ADD COLUMN to_island TEXT`);
  if (!has('status_history')) db.exec(`ALTER TABLE messages ADD COLUMN status_history TEXT`);

  // Migration: rebuild the table if its type CHECK drifted from the canonical model
  // (must run AFTER the island columns exist so the rebuild copies them).
  migrateTypeCheckIfStale(db);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_to_island ON messages(to_island)`);

  logger.info('[TaskMessageBox] Database initialized:', DB_PATH);
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('[TaskMessageBox] Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function generateContentHash(title: string, description: string): string {
  return crypto.createHash('sha256').update(title + description).digest('hex');
}

function generateMessageId(terminal: string): string {
  const db = getDb();

  // Get or create sequence
  const seq = db.prepare(`
    INSERT INTO message_sequence (terminal, last_number)
    VALUES (?, 0)
    ON CONFLICT(terminal) DO UPDATE SET last_number = last_number + 1
    RETURNING last_number
  `).get(terminal.toLowerCase()) as { last_number: number };

  const num = (seq?.last_number || 0) + 1;

  // Update if it was an insert
  if (!seq || seq.last_number === 0) {
    db.prepare('UPDATE message_sequence SET last_number = ? WHERE terminal = ?')
      .run(num, terminal.toLowerCase());
  }

  return `MSG-${terminal.toUpperCase()}-${num.toString().padStart(3, '0')}`;
}

function formatDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

// ─── File Rendering ──────────────────────────────────────────────────────────

async function renderMessageToFile(message: Message): Promise<string> {
  const terminalDir = path.join(TERMINALS_ROOT, message.to_terminal);
  const boxDir = message.type === 'done' || message.type === 'blocked'
    ? path.join(terminalDir, 'outbox')
    : path.join(terminalDir, 'inbox');

  await fs.mkdir(boxDir, { recursive: true });

  // Generate filename
  // created_at may be ISO ("2026-07-12T13:37:09Z") or SQLite ("2026-07-12 13:37:09").
  // Take the date part only — a time with colons is an illegal Windows filename char.
  const date = message.created_at.split(/[ T]/)[0];
  const num = message.id.split('-').pop() || '001';
  const slug = message.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  const filename = `${date}_${num}_${slug}.md`;
  const filePath = path.join(boxDir, filename);

  // Build frontmatter
  const frontmatter: Record<string, string | undefined> = {
    id: message.id,
    from: message.from_terminal,
    to: message.to_terminal,
    type: message.type,
    priority: message.priority,
    status: message.status.toUpperCase(),
    model: message.model,
    ref: message.ref_id,
    epic_id: message.epic_id,
    project_id: message.project_id,
    created: message.created_at,
    completed: message.completed_at,
    content_hash: message.content_hash,
  };

  const frontmatterYaml = Object.entries(frontmatter)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  // Build body
  let body = `# ${message.title}\n\n`;
  body += message.description;

  if (message.acceptance_criteria && message.acceptance_criteria.length > 0) {
    body += '\n\n## Acceptance Criteria\n\n';
    body += message.acceptance_criteria.map(c => `- [ ] ${c}`).join('\n');
  }

  if (message.context) {
    body += `\n\n## Context\n\n${message.context}`;
  }

  // Add completion info if present
  if (message.completion_summary) {
    body += `\n\n---\n\n## ${message.status === 'completed' ? 'Completion' : 'Blocked'} Report\n`;
    body += `*${message.completed_at}*\n\n`;
    body += `### Summary\n${message.completion_summary}\n`;

    if (message.completion_details) {
      body += `\n### Details\n${message.completion_details}\n`;
    }

    if (message.files_changed && message.files_changed.length > 0) {
      body += `\n### Files Changed\n`;
      body += message.files_changed.map(f => `- \`${f}\``).join('\n') + '\n';
    }

    if (message.blocked_reason) {
      body += `\n### Blocked Reason\n${message.blocked_reason}\n`;
    }

    if (message.next_steps) {
      body += `\n### Next Steps\n${message.next_steps}\n`;
    }
  }

  // Add notes if present
  if (message.notes && message.notes.length > 0) {
    for (const note of message.notes) {
      const authorLine = note.author ? ` (by ${note.author})` : '';
      body += `\n\n---\n\n## ${note.section.charAt(0).toUpperCase() + note.section.slice(1)}${authorLine}\n`;
      body += `*Added: ${note.created_at}*\n\n`;
      body += note.content;
    }
  }

  const fileContent = `---\n${frontmatterYaml}\n---\n\n${body}\n`;
  await fs.writeFile(filePath, fileContent, 'utf-8');

  // Update rendered path in DB
  getDb().prepare(`
    UPDATE messages
    SET rendered_path = ?, last_rendered_at = datetime('now')
    WHERE id = ?
  `).run(filePath, message.id);

  return filePath;
}

// ─── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Create a new task/message
 */
export async function createTask(input: CreateTaskInput): Promise<CreateResult> {
  try {
    const db = getDb();
    const id = generateMessageId(input.to);
    const contentHash = generateContentHash(input.title, input.description);

    const stmt = db.prepare(`
      INSERT INTO messages (
        id, from_terminal, to_terminal, from_island, to_island, type, priority, status,
        title, description, acceptance_criteria, context,
        ref_id, epic_id, project_id, model, content_hash
      ) VALUES (
        ?, ?, ?, ?, ?, 'task', ?, 'unread',
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      id,
      input.from,
      input.to,
      input.from_island || null,
      input.to_island || null,
      input.priority,
      input.title,
      input.description,
      input.acceptance_criteria ? JSON.stringify(input.acceptance_criteria) : null,
      input.context || null,
      input.ref_id || null,
      input.epic_id || null,
      input.project_id || null,
      input.model || null,
      contentHash
    );

    // Get full message for rendering
    const message = await getMessage(id);
    if (!message) {
      return { success: false, error: 'Failed to retrieve created message' };
    }

    const renderedPath = await renderMessageToFile(message);

    return { success: true, id, rendered_path: renderedPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Get a single message by ID
 */
export async function getMessage(id: string): Promise<Message | null> {
  const db = getDb();

  const row = db.prepare(`
    SELECT m.*,
           (SELECT COUNT(*) FROM message_notes n WHERE n.message_id = m.id) as note_count
    FROM messages m
    WHERE m.id = ?
  `).get(id) as (Message & { acceptance_criteria: string | null; files_changed: string | null }) | undefined;

  if (!row) return null;

  // Parse JSON fields
  const message: Message = {
    ...row,
    acceptance_criteria: row.acceptance_criteria ? JSON.parse(row.acceptance_criteria) : undefined,
    files_changed: row.files_changed ? JSON.parse(row.files_changed) : undefined,
  };

  // Load notes
  const notes = db.prepare(`
    SELECT * FROM message_notes WHERE message_id = ? ORDER BY created_at
  `).all(id) as MessageNote[];

  message.notes = notes;

  return message;
}

/**
 * Read a message (marks as read)
 */
export async function readMessage(id: string): Promise<QueryResult<Message>> {
  try {
    const db = getDb();

    // Update status to read
    db.prepare(`
      UPDATE messages
      SET status = 'read', read_at = datetime('now')
      WHERE id = ? AND status = 'unread'
    `).run(id);

    const message = await getMessage(id);
    if (!message) {
      return { success: false, error: `Message ${id} not found` };
    }

    // Re-render file with updated status
    await renderMessageToFile(message);

    return { success: true, data: message };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Complete a message (done/blocked)
 */
export async function completeMessage(input: CompleteMessageInput): Promise<UpdateResult> {
  try {
    const db = getDb();

    const status: MessageStatus = input.status === 'completed' ? 'completed' : 'blocked';

    db.prepare(`
      UPDATE messages
      SET status = ?,
          completion_summary = ?,
          completion_details = ?,
          files_changed = ?,
          blocked_reason = ?,
          next_steps = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(
      status,
      input.summary,
      input.details || null,
      input.files_changed ? JSON.stringify(input.files_changed) : null,
      input.blocked_reason || null,
      input.next_steps || null,
      input.message_id
    );

    // Get full message for rendering
    const message = await getMessage(input.message_id);
    if (!message) {
      return { success: false, error: `Message ${input.message_id} not found` };
    }

    const renderedPath = await renderMessageToFile(message);

    return { success: true, rendered_path: renderedPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Append a note to a message
 */
export async function appendNote(input: AppendNoteInput): Promise<UpdateResult> {
  try {
    const db = getDb();

    db.prepare(`
      INSERT INTO message_notes (message_id, section, content, author)
      VALUES (?, ?, ?, ?)
    `).run(input.message_id, input.section, input.content, input.author || null);

    // Get full message for rendering
    const message = await getMessage(input.message_id);
    if (!message) {
      return { success: false, error: `Message ${input.message_id} not found` };
    }

    const renderedPath = await renderMessageToFile(message);

    return { success: true, rendered_path: renderedPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Query messages with filters
 */
export async function queryMessages(filter: MessageFilter): Promise<QueryResult<Message[]>> {
  try {
    const db = getDb();

    let sql = 'SELECT * FROM messages WHERE 1=1';
    const params: unknown[] = [];

    if (filter.terminal) {
      sql += ' AND to_terminal = ?';
      params.push(filter.terminal);
    }

    if (filter.type) {
      if (Array.isArray(filter.type)) {
        sql += ` AND type IN (${filter.type.map(() => '?').join(',')})`;
        params.push(...filter.type);
      } else {
        sql += ' AND type = ?';
        params.push(filter.type);
      }
    }

    if (filter.status) {
      if (Array.isArray(filter.status)) {
        sql += ` AND status IN (${filter.status.map(() => '?').join(',')})`;
        params.push(...filter.status);
      } else {
        sql += ' AND status = ?';
        params.push(filter.status);
      }
    }

    if (filter.priority) {
      if (Array.isArray(filter.priority)) {
        sql += ` AND priority IN (${filter.priority.map(() => '?').join(',')})`;
        params.push(...filter.priority);
      } else {
        sql += ' AND priority = ?';
        params.push(filter.priority);
      }
    }

    if (filter.epic_id) {
      sql += ' AND epic_id = ?';
      params.push(filter.epic_id);
    }

    if (filter.project_id) {
      sql += ' AND project_id = ?';
      params.push(filter.project_id);
    }

    sql += ' ORDER BY created_at DESC';

    if (filter.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    if (filter.offset) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    const rows = db.prepare(sql).all(...params) as Message[];

    // Parse JSON fields
    const messages = rows.map(row => ({
      ...row,
      acceptance_criteria: (row as unknown as { acceptance_criteria: string | null }).acceptance_criteria
        ? JSON.parse((row as unknown as { acceptance_criteria: string }).acceptance_criteria)
        : undefined,
      files_changed: (row as unknown as { files_changed: string | null }).files_changed
        ? JSON.parse((row as unknown as { files_changed: string }).files_changed)
        : undefined,
    }));

    return { success: true, data: messages, count: messages.length };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Get inbox for a terminal
 */
export async function getInbox(terminal: string, statusFilter?: 'unread' | 'read' | 'all'): Promise<QueryResult<Message[]>> {
  const status = statusFilter === 'all' ? undefined : statusFilter;
  return queryMessages({
    terminal,
    type: ['task', 'question', 'info'],
    status: status ? [status] : ['unread', 'read', 'in_progress'],
  });
}

/**
 * Get outbox for a terminal (messages sent by terminal)
 */
export async function getOutbox(terminal: string): Promise<QueryResult<Message[]>> {
  try {
    const db = getDb();

    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE from_terminal = ? AND type IN ('done', 'blocked')
      ORDER BY created_at DESC
    `).all(terminal) as Message[];

    return { success: true, data: rows, count: rows.length };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Federation (cross-island) ───────────────────────────────────────────────

/**
 * Send a cross-island federation message. Writes to the same canonical
 * task-message-box table (single source of truth), tagged with island fields.
 * Deduped on content_hash: re-sending identical content returns the existing id.
 */
export async function sendFederationMessage(input: FederationSendInput): Promise<CreateResult> {
  try {
    const db = getDb();
    const contentHash = generateContentHash(input.subject, input.body);

    // Dedup: identical (subject+body) to the same destination → return existing id.
    const existing = db.prepare(`
      SELECT id FROM messages
      WHERE content_hash = ? AND to_island = ? AND to_terminal = ?
    `).get(contentHash, input.to_island, input.to_terminal) as { id: string } | undefined;
    if (existing) {
      return { success: true, id: existing.id };
    }

    const id = generateMessageId(input.to_terminal);
    db.prepare(`
      INSERT INTO messages (
        id, from_terminal, to_terminal, from_island, to_island, type, priority, status,
        title, description, ref_id, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?)
    `).run(
      id,
      input.from_terminal,
      input.to_terminal,
      input.from_island,
      input.to_island,
      input.type,
      input.priority,
      input.subject,
      input.body,
      input.ref_id || null,
      contentHash
    );

    // The DB row is the source of truth. The .md render is an optional projection —
    // if it fails (e.g. a filesystem quirk), the federation message still stands.
    try {
      const message = await getMessage(id);
      if (message) await renderMessageToFile(message);
    } catch { /* best-effort render; DB write already committed */ }
    return { success: true, id };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Token-optimized federation inbox: metadata rows only (NO body/description).
 * The librarian/pipeline fetches full content via getMessage(id) only when needed.
 */
export async function getFederationInbox(
  toIsland: string,
  statusFilter: MessageStatus | 'all' = 'unread'
): Promise<QueryResult<FederationInboxItem[]>> {
  try {
    const db = getDb();
    let sql = `
      SELECT id, from_island, from_terminal, to_island, to_terminal,
             type, priority, status, title AS subject, ref_id, created_at
      FROM messages
      WHERE to_island = ?
    `;
    const params: unknown[] = [toIsland];
    if (statusFilter !== 'all') {
      sql += ` AND status = ?`;
      params.push(statusFilter);
    }
    sql += ` ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at ASC`;
    const rows = db.prepare(sql).all(...params) as FederationInboxItem[];
    return { success: true, data: rows, count: rows.length };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Canonical status transitions + audit trail ──────────────────────────────

/**
 * Transition a message to a new status, enforcing the config-driven lifecycle
 * state machine (see message-model.yaml) and appending to its status_history
 * audit trail. This is the ONE way status should change — it guarantees only
 * valid transitions land and every change is recorded (who, when, from→to).
 *
 * Returns an error (does not throw) on an invalid transition or missing message.
 */
export async function updateMessageStatus(
  id: string,
  toStatus: MessageStatus,
  changedBy?: string
): Promise<UpdateResult> {
  try {
    const db = getDb();
    const row = db.prepare('SELECT status, status_history FROM messages WHERE id = ?')
      .get(id) as { status: MessageStatus; status_history: string | null } | undefined;
    if (!row) return { success: false, error: `Message not found: ${id}` };

    const from = row.status;
    if (!isValidTransition(from, toStatus)) {
      const msg = `Invalid status transition for ${id}: ${from} → ${toStatus}`;
      logger.warn(`[TaskMessageBox] ⚠️ ${msg}`);
      return { success: false, error: msg };
    }

    const history: StatusHistoryEntry[] = row.status_history ? JSON.parse(row.status_history) : [];
    history.push({ from, to: toStatus, at: new Date().toISOString(), by: changedBy || 'system' });

    // Stamp the matching lifecycle timestamp column, if any.
    const tsCol =
      toStatus === 'read' ? 'read_at' :
      toStatus === 'in_progress' ? 'started_at' :
      toStatus === 'completed' ? 'completed_at' : null;

    db.prepare(
      `UPDATE messages SET status = ?, status_history = ?, updated_at = datetime('now')` +
      (tsCol ? `, ${tsCol} = datetime('now')` : '') +
      ` WHERE id = ?`
    ).run(toStatus, JSON.stringify(history), id);

    logger.info(`[TaskMessageBox] ${id}: ${from} → ${toStatus} (by ${changedBy || 'system'})`);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Read a message's status-transition audit trail (chronological). */
export function getStatusHistory(id: string): StatusHistoryEntry[] {
  const db = getDb();
  const row = db.prepare('SELECT status_history FROM messages WHERE id = ?')
    .get(id) as { status_history: string | null } | undefined;
  if (!row || !row.status_history) return [];
  try { return JSON.parse(row.status_history) as StatusHistoryEntry[]; }
  catch { return []; }
}

// ─── Content integrity (hash verification) ────────────────────────────────────

/**
 * Verify a single message's stored content_hash still matches its content.
 * Detects tampering / drift between the DB row and its recorded hash.
 */
export function verifyMessageHash(id: string): { valid: boolean; expected?: string; actual?: string; error?: string } {
  const db = getDb();
  const row = db.prepare('SELECT title, description, content_hash FROM messages WHERE id = ?')
    .get(id) as { title: string; description: string; content_hash: string } | undefined;
  if (!row) return { valid: false, error: `Message not found: ${id}` };
  const actual = generateContentHash(row.title, row.description);
  return { valid: actual === row.content_hash, expected: row.content_hash, actual };
}

/** Verify every message's content_hash. Returns the ids of any that fail. */
export function verifyAllMessages(): { total: number; valid: number; invalid: string[] } {
  const db = getDb();
  const rows = db.prepare('SELECT id, title, description, content_hash FROM messages')
    .all() as Array<{ id: string; title: string; description: string; content_hash: string }>;
  const invalid: string[] = [];
  for (const r of rows) {
    if (generateContentHash(r.title, r.description) !== r.content_hash) invalid.push(r.id);
  }
  if (invalid.length > 0) {
    logger.warn(`[TaskMessageBox] ⚠️ Hash verification: ${invalid.length}/${rows.length} messages FAILED integrity check`);
  }
  return { total: rows.length, valid: rows.length - invalid.length, invalid };
}

// ─── Terminal Status ─────────────────────────────────────────────────────────

export function setTerminalStatus(
  terminal: string,
  status: 'idle' | 'working' | 'blocked',
  taskId?: string
): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO terminal_status (terminal, status, current_task_id, last_activity_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(terminal) DO UPDATE SET
      status = excluded.status,
      current_task_id = excluded.current_task_id,
      last_activity_at = datetime('now')
  `).run(terminal, status, taskId || null);
}

export function getTerminalStatus(terminal?: string): TerminalStatus | TerminalStatus[] | null {
  const db = getDb();

  if (terminal) {
    return db.prepare('SELECT * FROM terminal_status WHERE terminal = ?').get(terminal) as TerminalStatus | undefined || null;
  }

  return db.prepare('SELECT * FROM terminal_status').all() as TerminalStatus[];
}

// ─── Export ──────────────────────────────────────────────────────────────────

export default {
  initDatabase,
  createTask,
  getMessage,
  readMessage,
  completeMessage,
  appendNote,
  queryMessages,
  getInbox,
  getOutbox,
  setTerminalStatus,
  getTerminalStatus,
};
