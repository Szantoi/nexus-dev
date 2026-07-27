/**
 * Durable runner completion receipts.
 *
 * A long-lived PTY has no per-task process exit, and terminal output is not a
 * trustworthy business signal. These append-only receipts are therefore the
 * runner's durable proof that the MCP complete_task command succeeded.
 *
 * The store is deliberately constructed with the epic-router database: task
 * completion and receipt creation can then share one SQLite transaction.
 */

import type Database from 'better-sqlite3';
import { InvalidStateError, RuntimeStateError } from '../core/errors';

export type CompletionReceiptSource = 'mcp_complete_task';

export interface RunnerCompletionReceipt {
  sequence: number;
  islandId: string;
  terminalId: string;
  messageId: string;
  completedAt: string;
  source: CompletionReceiptSource;
}

export interface CompletionReceiptPage {
  receipts: RunnerCompletionReceipt[];
  nextCursor: number;
  hasMore: boolean;
}

interface CompletionReceiptRow {
  sequence: number;
  island_id: string;
  terminal_id: string;
  message_id: string;
  completed_at: string;
  source: CompletionReceiptSource;
}

const MAX_PAGE_SIZE = 500;

function assertCursor(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function mapRow(row: CompletionReceiptRow): RunnerCompletionReceipt {
  return {
    sequence: row.sequence,
    islandId: row.island_id,
    terminalId: row.terminal_id,
    messageId: row.message_id,
    completedAt: row.completed_at,
    source: row.source,
  };
}

export class CompletionReceiptStore {
  private readonly insert: Database.Statement;
  private readonly getByTask: Database.Statement;
  private readonly listAfter: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runner_completion_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        island_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('mcp_complete_task')),
        UNIQUE(island_id, terminal_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_runner_completion_receipts_scope_sequence
        ON runner_completion_receipts(island_id, terminal_id, sequence);
    `);

    this.insert = db.prepare(`
      INSERT INTO runner_completion_receipts (
        island_id, terminal_id, message_id, completed_at, source
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(island_id, terminal_id, message_id) DO NOTHING
    `);
    this.getByTask = db.prepare(`
      SELECT sequence, island_id, terminal_id, message_id, completed_at, source
      FROM runner_completion_receipts
      WHERE island_id = ? AND terminal_id = ? AND message_id = ?
    `);
    this.listAfter = db.prepare(`
      SELECT sequence, island_id, terminal_id, message_id, completed_at, source
      FROM runner_completion_receipts
      WHERE island_id = ? AND terminal_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `);
  }

  record(input: {
    islandId: string;
    terminalId: string;
    messageId: string;
    source: CompletionReceiptSource;
    completedAt?: string;
  }): RunnerCompletionReceipt {
    if (!input.islandId || !input.terminalId || !input.messageId) {
      throw new InvalidStateError('Completion receipt scope and message ID must be non-empty');
    }
    const completedAt = input.completedAt ?? new Date().toISOString();
    this.insert.run(
      input.islandId,
      input.terminalId,
      input.messageId,
      completedAt,
      input.source,
    );

    const receipt = this.get(input.islandId, input.terminalId, input.messageId);
    if (!receipt) {
      throw new RuntimeStateError('Completion receipt insert did not produce a durable row');
    }
    return receipt;
  }

  get(islandId: string, terminalId: string, messageId: string): RunnerCompletionReceipt | undefined {
    const row = this.getByTask.get(islandId, terminalId, messageId) as
      | CompletionReceiptRow
      | undefined;
    return row ? mapRow(row) : undefined;
  }

  list(islandId: string, terminalId: string, after: number, limit = 100): CompletionReceiptPage {
    if (!islandId || !terminalId) {
      throw new InvalidStateError('Completion receipt scope must be non-empty');
    }
    assertCursor(after, 'after');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new RangeError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }

    const rows = this.listAfter.all(islandId, terminalId, after, limit + 1) as CompletionReceiptRow[];
    const hasMore = rows.length > limit;
    const receipts = rows.slice(0, limit).map(mapRow);
    return {
      receipts,
      nextCursor: receipts.length > 0 ? receipts[receipts.length - 1].sequence : after,
      hasMore,
    };
  }
}
