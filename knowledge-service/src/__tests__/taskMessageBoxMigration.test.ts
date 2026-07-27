import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const runId = crypto.randomBytes(6).toString('hex');
const dataDir = path.join(os.tmpdir(), `task-message-migration-${runId}`);
process.env.DATA_DIR = dataDir;
process.env.TERMINALS_PATH = path.join(os.tmpdir(), `task-message-terminals-${runId}`);

let store: typeof import('../task-message-box/store');

beforeAll(async () => {
  const fs = await import('node:fs/promises');
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'taskmessagebox.db'));
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      from_terminal TEXT NOT NULL,
      to_terminal TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('task', 'question', 'done', 'blocked', 'info')),
      priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      status TEXT NOT NULL DEFAULT 'unread',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      epic_id TEXT,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE VIEW v_inbox AS SELECT id, to_terminal FROM messages;
    INSERT INTO messages (id, from_terminal, to_terminal, type, priority, status, title, description, content_hash)
      VALUES ('MSG-LEGACY-1', 'root', 'explorer', 'task', 'low', 'unread', 'legacy task', 'body', 'hash');
  `);
  db.close();

  store = await import('../task-message-box/store');
  await store.initDatabase();
});

describe('TaskMessageBox legacy CHECK migration', () => {
  it('preserves a legacy view while rebuilding the messages table', () => {
    const db = store.getDb();
    expect(db.prepare('SELECT id, to_terminal FROM v_inbox').get()).toEqual({
      id: 'MSG-LEGACY-1',
      to_terminal: 'explorer',
    });
    expect(() => db.prepare(`INSERT INTO messages (id, from_terminal, to_terminal, type, priority, status, title, description, content_hash)
      VALUES ('MSG-RESPONSE-1', 'root', 'explorer', 'response', 'low', 'unread', 'response', 'body', 'hash-2')`).run()).not.toThrow();
  });
});
