/**
 * memoryStore.ts — FTS5-based memory system for SpaceOS
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Provides hybrid search combining:
 * - SQLite FTS5 for fast full-text keyword matching
 * - ChromaDB for semantic vector search (existing)
 *
 * Memory types:
 * - semantic: User preferences, facts, decisions
 * - episodic: Conversation summaries, daily digests
 * - procedural: How-to knowledge, patterns
 */

import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { log as pipelineLog } from './common';

const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryType = 'semantic' | 'episodic' | 'procedural';
export type MemorySource = 'conversation' | 'document' | 'skill' | 'digest' | 'manual';
export type MemoryTier = 'hot' | 'warm' | 'cold' | 'shared';

export interface Memory {
  id: number;
  type: MemoryType;
  source: MemorySource;
  content: string;
  keywords: string;
  terminal?: string;
  context?: string;
  salience: number; // 0.0 - 1.0, higher = more important
  accessCount: number;
  createdAt: string;
  accessedAt: string;
  expiresAt?: string;
}

export interface TieredMemory extends Memory {
  tier: MemoryTier;
  promotedFrom?: MemoryTier;
  promotionCount: number;
  lastPromotionAt?: string;
}

export interface MemoryInput {
  type: MemoryType;
  source: MemorySource;
  content: string;
  keywords?: string;
  terminal?: string;
  context?: string;
  salience?: number;
  expiresAt?: string;
}

export interface TieredMemoryInput {
  tier: MemoryTier;
  type: MemoryType;
  source: MemorySource;
  content: string;
  keywords?: string;
  terminal?: string;
  context?: string;
  salience?: number;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  matchType: 'fts' | 'recent' | 'hybrid';
}

// ─── Constants ───────────────────────────────────────────────────────────────

import { DATA_DIR, MEMORY_DB } from '../config/paths';
// MEMORY_DB already honors the MEMORY_DB_PATH legacy alias (config/paths.ts)
const DB_PATH = MEMORY_DB;

const SALIENCE_DECAY_RATE = 0.05; // 5% decay per day (default)
const MIN_SALIENCE = 0.1; // Minimum salience before archival consideration
const DEFAULT_SALIENCE = 0.5;

// Tier-specific policies (ADR-046)
interface TierPolicy {
  tier: MemoryTier;
  maxAge: string;
  decayRate: number;
  autoPromote: boolean;
  terminalScoped: boolean;
}

export const TIER_POLICIES: Record<MemoryTier, TierPolicy> = {
  hot: {
    tier: 'hot',
    maxAge: '48h',
    decayRate: 0.15, // 15% per day — aggressive decay
    autoPromote: true,
    terminalScoped: true,
  },
  warm: {
    tier: 'warm',
    maxAge: '14d',
    decayRate: 0.05, // 5% per day
    autoPromote: true,
    terminalScoped: true,
  },
  cold: {
    tier: 'cold',
    maxAge: '365d',
    decayRate: 0.01, // 1% per day — slow decay
    autoPromote: false,
    terminalScoped: true,
  },
  shared: {
    tier: 'shared',
    maxAge: 'forever',
    decayRate: 0, // no decay
    autoPromote: false,
    terminalScoped: false,
  },
};

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

  // Main memories table
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('semantic', 'episodic', 'procedural')),
      source TEXT NOT NULL CHECK (source IN ('conversation', 'document', 'skill', 'digest', 'manual')),
      content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      terminal TEXT,
      context TEXT,
      salience REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      tier TEXT NOT NULL DEFAULT 'hot' CHECK (tier IN ('hot', 'warm', 'cold', 'shared')),
      promoted_from TEXT,
      promotion_count INTEGER NOT NULL DEFAULT 0,
      last_promotion_at TEXT
    )
  `);

  // FTS5 virtual table for full-text search
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      keywords,
      content='memories',
      content_rowid='id'
    )
  `);

  // Triggers to keep FTS5 in sync with memories table
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, keywords)
      VALUES (new.id, new.content, new.keywords);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
      VALUES ('delete', old.id, old.content, old.keywords);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
      VALUES ('delete', old.id, old.content, old.keywords);
      INSERT INTO memories_fts(rowid, content, keywords)
      VALUES (new.id, new.content, new.keywords);
    END
  `);

  // Indexes for common queries
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_terminal ON memories(terminal);
    CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
  `);

  // Shared memories table (cross-terminal, ADR-046)
  database.exec(`
    CREATE TABLE IF NOT EXISTS shared_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      context TEXT,
      salience REAL NOT NULL DEFAULT 0.7,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // FTS5 for shared memories
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS shared_memories_fts USING fts5(
      content,
      keywords,
      content='shared_memories',
      content_rowid='id'
    )
  `);

  // Shared memories FTS5 triggers
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS shared_memories_ai AFTER INSERT ON shared_memories BEGIN
      INSERT INTO shared_memories_fts(rowid, content, keywords)
      VALUES (new.id, new.content, new.keywords);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS shared_memories_ad AFTER DELETE ON shared_memories BEGIN
      INSERT INTO shared_memories_fts(shared_memories_fts, rowid, content, keywords)
      VALUES ('delete', old.id, old.content, old.keywords);
    END
  `);

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS shared_memories_au AFTER UPDATE ON shared_memories BEGIN
      INSERT INTO shared_memories_fts(shared_memories_fts, rowid, content, keywords)
      VALUES ('delete', old.id, old.content, old.keywords);
      INSERT INTO shared_memories_fts(rowid, content, keywords)
      VALUES (new.id, new.content, new.keywords);
    END
  `);

  log('memoryStore', 'Database schema initialized (with tier support)');
}

// ─── FTS5 Query Building ─────────────────────────────────────────────────────

function escapeFts5(query: string): string {
  // Escape special FTS5 characters
  return query
    .replace(/"/g, '""')
    .replace(/[*^$]/g, ' ')
    .trim();
}

function buildFtsMatchExpression(query: string): string {
  const escaped = escapeFts5(query);
  const terms = escaped.split(/\s+/).filter(t => t.length > 1);

  if (terms.length === 0) return '';

  // Build OR query with prefix matching
  return terms.map(t => `"${t}"*`).join(' OR ');
}

// ─── Core Memory Operations ──────────────────────────────────────────────────

/**
 * Store a new memory
 */
export async function saveMemory(input: MemoryInput): Promise<number> {
  await ensureDataDir();
  const database = getDb();

  const stmt = database.prepare(`
    INSERT INTO memories (type, source, content, keywords, terminal, context, salience, expires_at, tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hot')
  `);

  const keywords = input.keywords || extractKeywords(input.content);
  const salience = input.salience ?? DEFAULT_SALIENCE;

  const result = stmt.run(
    input.type,
    input.source,
    input.content,
    keywords,
    input.terminal || null,
    input.context || null,
    salience,
    input.expiresAt || null
  );

  log('memoryStore', `Saved memory #${result.lastInsertRowid} (${input.type}/${input.source}, tier=hot)`);
  return result.lastInsertRowid as number;
}

/**
 * Save a tiered memory (ADR-046 Track A)
 */
export async function saveTieredMemory(input: TieredMemoryInput): Promise<TieredMemory> {
  await ensureDataDir();
  const database = getDb();

  const keywords = input.keywords || extractKeywords(input.content);
  const salience = input.salience ?? DEFAULT_SALIENCE;

  const stmt = database.prepare(`
    INSERT INTO memories (tier, type, source, content, keywords, terminal, context, salience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    input.tier,
    input.type,
    input.source,
    input.content,
    keywords,
    input.terminal || null,
    input.context || null,
    salience
  );

  const id = result.lastInsertRowid as number;
  log('memoryStore', `Saved tiered memory #${id} (${input.type}/${input.source}, tier=${input.tier})`);

  // Return the full tiered memory object
  const selectStmt = database.prepare('SELECT * FROM memories WHERE id = ?');
  const row = selectStmt.get(id) as Record<string, unknown>;
  return rowToTieredMemory(row);
}

/**
 * Query memories by tier (ADR-046 Track A)
 */
export function queryByTier(terminal: string, tiers: MemoryTier[], limit: number = 20): TieredMemory[] {
  const database = getDb();
  const placeholders = tiers.map(() => '?').join(',');

  const sql = `
    SELECT * FROM memories
    WHERE tier IN (${placeholders})
      AND (terminal = ? OR tier = 'shared')
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY salience DESC, accessed_at DESC
    LIMIT ?
  `;

  const stmt = database.prepare(sql);
  const rows = stmt.all(...tiers, terminal, limit) as Array<Record<string, unknown>>;

  return rows.map(rowToTieredMemory);
}

/**
 * Promote memory to a higher tier (ADR-046 Track A)
 */
export async function promoteMemory(id: number, newTier: MemoryTier, reason: string): Promise<void> {
  const database = getDb();

  // Get current memory
  const selectStmt = database.prepare('SELECT * FROM memories WHERE id = ?');
  const current = selectStmt.get(id) as Record<string, unknown> | undefined;

  if (!current) {
    throw new Error(`Memory #${id} not found`);
  }

  const currentTier = current.tier as MemoryTier;

  // Update memory with promotion metadata
  const updateStmt = database.prepare(`
    UPDATE memories
    SET tier = ?,
        promoted_from = ?,
        promotion_count = promotion_count + 1,
        last_promotion_at = datetime('now')
    WHERE id = ?
  `);

  updateStmt.run(newTier, currentTier, id);

  log('memoryStore', `Promoted memory #${id} from ${currentTier} → ${newTier} (reason: ${reason})`);
}

/**
 * Extract keywords from content (simple implementation)
 */
function extractKeywords(content: string): string {
  // Extract significant words (length > 3, not common words)
  const stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they',
    'this', 'that', 'with', 'from', 'what', 'when', 'where', 'which', 'will',
    'hogy', 'egy', 'van', 'nem', 'meg', 'ezt', 'azt', 'ami', 'aki', 'már',
  ]);

  const words = content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));

  // Get unique words, limit to 20
  const unique = [...new Set(words)].slice(0, 20);
  return unique.join(' ');
}

/**
 * Search memories using FTS5
 */
export function searchMemories(query: string, limit: number = 10): SearchResult[] {
  const database = getDb();
  const matchExpr = buildFtsMatchExpression(query);

  if (!matchExpr) return [];

  const stmt = database.prepare(`
    SELECT m.*, bm25(memories_fts) as rank
    FROM memories m
    JOIN memories_fts fts ON m.id = fts.rowid
    WHERE memories_fts MATCH ?
      AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))
    ORDER BY rank
    LIMIT ?
  `);

  const rows = stmt.all(matchExpr, limit) as Array<Memory & { rank: number }>;

  // Update access timestamps
  if (rows.length > 0) {
    const updateStmt = database.prepare(`
      UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1
      WHERE id = ?
    `);
    for (const row of rows) {
      updateStmt.run(row.id);
    }
  }

  return rows.map(row => ({
    memory: rowToMemory(row as unknown as Record<string, unknown>),
    score: Math.abs(row.rank), // bm25 returns negative, lower is better
    matchType: 'fts' as const,
  }));
}

/**
 * Get recent memories
 */
export function recentMemories(limit: number = 20, terminal?: string): SearchResult[] {
  const database = getDb();

  const sql = terminal
    ? `SELECT * FROM memories WHERE terminal = ? AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY accessed_at DESC LIMIT ?`
    : `SELECT * FROM memories WHERE (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY accessed_at DESC LIMIT ?`;

  const stmt = database.prepare(sql);
  const rows = terminal ? stmt.all(terminal, limit) : stmt.all(limit);

  return (rows as Array<Record<string, unknown>>).map((row, idx) => ({
    memory: rowToMemory(row),
    score: 1 - idx * 0.05, // Decreasing score by recency
    matchType: 'recent' as const,
  }));
}

/**
 * Hybrid search combining FTS5 and recency
 */
export function hybridSearch(
  query: string,
  options: { limit?: number; terminal?: string; weights?: { fts: number; recent: number } } = {}
): SearchResult[] {
  const { limit = 10, terminal, weights = { fts: 0.7, recent: 0.3 } } = options;

  // Get FTS results
  const ftsResults = searchMemories(query, limit * 2);

  // Get recent results
  const recentResults = recentMemories(limit, terminal);

  // Merge and deduplicate
  const seen = new Set<number>();
  const merged: SearchResult[] = [];

  // Add FTS results with weighted score
  for (const result of ftsResults) {
    if (!seen.has(result.memory.id)) {
      seen.add(result.memory.id);
      merged.push({
        ...result,
        score: result.score * weights.fts,
        matchType: 'hybrid',
      });
    }
  }

  // Add recent results with weighted score
  for (const result of recentResults) {
    if (!seen.has(result.memory.id)) {
      seen.add(result.memory.id);
      merged.push({
        ...result,
        score: result.score * weights.recent,
        matchType: 'hybrid',
      });
    } else {
      // Boost score if found in both
      const existing = merged.find(m => m.memory.id === result.memory.id);
      if (existing) {
        existing.score += result.score * weights.recent;
      }
    }
  }

  // Sort by combined score and limit
  return merged
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── Memory Maintenance ──────────────────────────────────────────────────────

/**
 * Run salience decay on all memories with tier-specific rates (ADR-046 Track A)
 */
export function runSalienceDecay(): number {
  const database = getDb();
  let totalAffected = 0;

  // Apply tier-specific decay rates
  for (const [tierName, policy] of Object.entries(TIER_POLICIES)) {
    if (policy.decayRate === 0) continue; // Skip tiers with no decay (e.g., shared)

    const stmt = database.prepare(`
      UPDATE memories
      SET salience = MAX(?, salience * (1 - ? * (julianday('now') - julianday(accessed_at))))
      WHERE tier = ? AND salience > ?
    `);

    const result = stmt.run(MIN_SALIENCE, policy.decayRate, tierName, MIN_SALIENCE);
    totalAffected += result.changes;
  }

  if (totalAffected > 0) {
    log('memoryStore', `Decay applied to ${totalAffected} memories (tier-specific rates)`);
  }

  return totalAffected;
}

/**
 * Clean up expired and low-salience memories
 */
export function cleanupMemories(options: { minSalience?: number; archiveInsteadOfDelete?: boolean } = {}): number {
  const { minSalience = MIN_SALIENCE, archiveInsteadOfDelete = false } = options;
  const database = getDb();

  if (archiveInsteadOfDelete) {
    // Move to archive table instead of deleting
    database.exec(`
      CREATE TABLE IF NOT EXISTS memories_archive AS SELECT * FROM memories WHERE 0
    `);

    const archiveStmt = database.prepare(`
      INSERT INTO memories_archive SELECT * FROM memories
      WHERE salience < ? OR (expires_at IS NOT NULL AND expires_at < datetime('now'))
    `);
    archiveStmt.run(minSalience);
  }

  const stmt = database.prepare(`
    DELETE FROM memories
    WHERE salience < ? OR (expires_at IS NOT NULL AND expires_at < datetime('now'))
  `);

  const result = stmt.run(minSalience);
  const deleted = result.changes;

  if (deleted > 0) {
    log('memoryStore', `Cleaned up ${deleted} memories`);
  }

  return deleted;
}

/**
 * Get memory statistics
 */
export function getMemoryStats(): {
  total: number;
  byType: Record<MemoryType, number>;
  bySource: Record<MemorySource, number>;
  avgSalience: number;
  oldestAccess: string | null;
} {
  const database = getDb();

  const total = (database.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;

  const byType: Record<string, number> = {};
  const typeRows = database.prepare('SELECT type, COUNT(*) as count FROM memories GROUP BY type').all() as Array<{ type: string; count: number }>;
  for (const row of typeRows) {
    byType[row.type] = row.count;
  }

  const bySource: Record<string, number> = {};
  const sourceRows = database.prepare('SELECT source, COUNT(*) as count FROM memories GROUP BY source').all() as Array<{ source: string; count: number }>;
  for (const row of sourceRows) {
    bySource[row.source] = row.count;
  }

  const avgRow = database.prepare('SELECT AVG(salience) as avg FROM memories').get() as { avg: number | null };
  const oldestRow = database.prepare('SELECT MIN(accessed_at) as oldest FROM memories').get() as { oldest: string | null };

  return {
    total,
    byType: byType as Record<MemoryType, number>,
    bySource: bySource as Record<MemorySource, number>,
    avgSalience: avgRow.avg ?? 0,
    oldestAccess: oldestRow.oldest,
  };
}

// ─── Context Building ────────────────────────────────────────────────────────

/**
 * Build memory context for a chat/terminal
 */
export function buildMemoryContext(query: string, terminal?: string): string {
  const results = hybridSearch(query, { limit: 5, terminal });

  if (results.length === 0) {
    return '';
  }

  const lines = ['## Relevant Memories\n'];

  for (const { memory, score } of results) {
    const typeEmoji = memory.type === 'semantic' ? '💡' : memory.type === 'episodic' ? '📝' : '🔧';
    const salience = memory.salience > 0.7 ? '⭐' : '';
    lines.push(`${typeEmoji}${salience} ${memory.content}`);
    if (memory.context) {
      lines.push(`   _Context: ${memory.context}_`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as number,
    type: row.type as MemoryType,
    source: row.source as MemorySource,
    content: row.content as string,
    keywords: row.keywords as string,
    terminal: row.terminal as string | undefined,
    context: row.context as string | undefined,
    salience: row.salience as number,
    accessCount: row.access_count as number,
    createdAt: row.created_at as string,
    accessedAt: row.accessed_at as string,
    expiresAt: row.expires_at as string | undefined,
  };
}

function rowToTieredMemory(row: Record<string, unknown>): TieredMemory {
  return {
    ...rowToMemory(row),
    tier: row.tier as MemoryTier,
    promotedFrom: row.promoted_from as MemoryTier | undefined,
    promotionCount: row.promotion_count as number,
    lastPromotionAt: row.last_promotion_at as string | undefined,
  };
}

/**
 * Close the database connection
 */
export function closeMemoryStore(): void {
  if (db) {
    db.close();
    db = null;
    log('memoryStore', 'Database connection closed');
  }
}

// ─── Conversation Memory Helpers ─────────────────────────────────────────────

/**
 * Check if a message should be saved as memory
 */
export function shouldSaveAsMemory(message: string): boolean {
  // Patterns that indicate preference/fact worth remembering
  const memoryPatterns = [
    /prefer|szeretné?m|mindig|soha|fontos|ne felejt/i,
    /remember|note|save|jegyezd meg|mentsd el/i,
    /my (favorite|preferred|usual)|az én kedvenc/i,
    /always use|mindig használ/i,
    /the rule is|a szabály/i,
  ];

  return memoryPatterns.some(p => p.test(message));
}

/**
 * Save a conversation turn as memory if relevant
 */
export async function saveConversationMemory(
  userMessage: string,
  assistantResponse: string,
  terminal?: string
): Promise<number | null> {
  if (!shouldSaveAsMemory(userMessage)) {
    return null;
  }

  // Extract the relevant part (simplified)
  const content = `User: ${userMessage.slice(0, 200)}${userMessage.length > 200 ? '...' : ''}`;

  return saveMemory({
    type: 'semantic',
    source: 'conversation',
    content,
    terminal,
    salience: 0.6,
  });
}
