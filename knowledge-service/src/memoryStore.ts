/**
 * MemoryStore - SQLite WAL-based memory management for dual-session architecture
 *
 * Part of ADR-049 Phase 1: Dual-Session Chat/Work Architecture
 *
 * Features:
 * - WAL (Write-Ahead Logging) for concurrent read/write from chat + work sessions
 * - Section-based separation: chat, work, shared
 * - Markdown export for session initialization
 * - Automatic timestamping and authorship
 *
 * Usage:
 *   const store = new MemoryStore('backend');
 *   store.append('chat', 'Telegram conversation summary', 'backend-chat');
 *   const recent = store.read('chat', 20);
 *   const markdown = store.exportToMarkdown();
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { getTerminalsRoot } from './config/terminals';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: number;
  section: 'chat' | 'work' | 'shared';
  content: string;
  author: string;
  timestamp: string;
}

export type MemorySection = 'chat' | 'work' | 'shared';

// ─── MemoryStore Class ────────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database.Database;
  private terminal: string;

  /**
   * Initialize MemoryStore for a terminal
   * @param terminal - Terminal name (e.g., 'backend', 'conductor')
   */
  constructor(terminal: string) {
    this.terminal = terminal;

    const terminalsDir = getTerminalsRoot();
    const dbPath = path.join(terminalsDir, terminal, 'memory.db');

    this.db = new Database(dbPath);

    // Enable WAL mode for concurrent access
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000'); // 5 second timeout for locks

    this.initSchema();

    console.log(`[MemoryStore] Initialized for terminal: ${terminal} (WAL mode)`);
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        section TEXT NOT NULL CHECK(section IN ('chat', 'work', 'shared')),
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_section ON memory_log(section);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON memory_log(timestamp);
    `);
  }

  /**
   * Append a memory entry
   * @param section - Memory section (chat/work/shared)
   * @param content - Memory content (markdown formatted)
   * @param author - Author identifier (e.g., 'backend-chat', 'backend-work-001')
   * @returns Inserted row ID
   */
  append(section: MemorySection, content: string, author: string): number {
    const stmt = this.db.prepare(
      'INSERT INTO memory_log (section, content, author, timestamp) VALUES (?, ?, ?, ?)'
    );

    const result = stmt.run(section, content, author, new Date().toISOString());
    return result.lastInsertRowid as number;
  }

  /**
   * Read memory entries from a section
   * @param section - Memory section to read from
   * @param limit - Maximum number of entries to return (default: 50)
   * @returns Array of memory entries, ordered by timestamp DESC
   */
  read(section: MemorySection, limit: number = 50): MemoryEntry[] {
    const stmt = this.db.prepare(
      'SELECT * FROM memory_log WHERE section = ? ORDER BY timestamp DESC, id DESC LIMIT ?'
    );

    return stmt.all(section, limit) as MemoryEntry[];
  }

  /**
   * Read all memory entries (all sections)
   * @param limit - Maximum number of entries per section
   * @returns Object with entries grouped by section
   */
  readAll(limit: number = 50): Record<MemorySection, MemoryEntry[]> {
    return {
      chat: this.read('chat', limit),
      work: this.read('work', limit),
      shared: this.read('shared', limit),
    };
  }

  /**
   * Export memory to Markdown format for session initialization
   * @param includeSections - Sections to include (default: all)
   * @param entriesPerSection - Number of entries per section (default: 20)
   * @returns Markdown formatted memory content
   */
  exportToMarkdown(
    includeSections: MemorySection[] = ['chat', 'work', 'shared'],
    entriesPerSection: number = 20
  ): string {
    let markdown = `# ${this.terminal.toUpperCase()} Terminal Memory\n\n`;
    markdown += `_Generated: ${new Date().toISOString()}_\n\n`;
    markdown += `---\n\n`;

    for (const section of includeSections) {
      const entries = this.read(section, entriesPerSection);

      if (entries.length === 0) {
        continue; // Skip empty sections
      }

      markdown += `## ${section.toUpperCase()} Section\n\n`;

      // Reverse to show chronological order (oldest first)
      for (const entry of entries.reverse()) {
        const timestamp = new Date(entry.timestamp).toISOString();
        markdown += `### ${timestamp} (${entry.author})\n\n`;
        markdown += `${entry.content}\n\n`;
      }

      markdown += `---\n\n`;
    }

    return markdown;
  }

  /**
   * Get memory statistics
   * @returns Object with entry counts per section
   */
  getStats(): Record<MemorySection, number> {
    const stmt = this.db.prepare(
      'SELECT section, COUNT(*) as count FROM memory_log GROUP BY section'
    );

    const rows = stmt.all() as Array<{ section: MemorySection; count: number }>;

    // Initialize all sections to 0
    const stats: Record<MemorySection, number> = {
      chat: 0,
      work: 0,
      shared: 0,
    };

    // Fill in actual counts
    for (const row of rows) {
      stats[row.section] = row.count;
    }

    return stats;
  }

  /**
   * Clear memory for a specific section (use with caution!)
   * @param section - Section to clear
   * @returns Number of deleted entries
   */
  clearSection(section: MemorySection): number {
    const stmt = this.db.prepare('DELETE FROM memory_log WHERE section = ?');
    const result = stmt.run(section);
    return result.changes;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
    console.log(`[MemoryStore] Closed database for terminal: ${this.terminal}`);
  }

  /**
   * Vacuum the database (compact and optimize)
   */
  vacuum(): void {
    this.db.exec('VACUUM');
    console.log(`[MemoryStore] Vacuumed database for terminal: ${this.terminal}`);
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────────

/**
 * Get or create a MemoryStore instance for a terminal
 * @param terminal - Terminal name
 * @returns MemoryStore instance
 */
export function getMemoryStore(terminal: string): MemoryStore {
  return new MemoryStore(terminal);
}
