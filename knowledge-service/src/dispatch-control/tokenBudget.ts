/**
 * Token Budget Tracker — Dispatch Control Phase 2
 *
 * Tracks token usage per terminal with daily/hourly budgets.
 * Provides budget checks before session dispatch.
 *
 * Features:
 * - Daily/hourly token limits per terminal
 * - Real-time budget status
 * - Threshold alerts (80%, 90%, 100%)
 * - Priority reserve for critical tasks
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { telegram, log } from '../pipeline/common';

// ── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || '/opt/spaceos/spaceos-nexus/knowledge-service/data';
const DB_PATH = path.join(DATA_DIR, 'dispatch.db');

// Default daily budget (tokens)
const DEFAULT_DAILY_BUDGET = 100000;

// Alert thresholds
const THRESHOLD_WARNING = 0.8;   // 80%
const THRESHOLD_CRITICAL = 0.9; // 90%

// ── Types ────────────────────────────────────────────────────────────────────

export type DispatchMode = 'auto' | 'manual' | 'scheduled';

export interface TokenUsage {
  terminal: string;
  sessionId?: string;
  taskId?: string;
  tokensUsed: number;
  model?: string;
}

export interface BudgetStatus {
  terminal: string;
  dailyLimit: number;
  tokensUsed: number;
  tokensRemaining: number;
  usagePercent: number;
  status: 'ok' | 'warning' | 'critical' | 'depleted';
}

export interface DailyBudgetSummary {
  date: string;
  totalLimit: number;
  totalUsed: number;
  totalRemaining: number;
  byTerminal: Record<string, BudgetStatus>;
  resetAt: string;
}

export interface DispatchCheck {
  allowed: boolean;
  reason?: string;
  budgetRemaining?: number;
  estimatedAfter?: number;
}

// ── Database Initialization ──────────────────────────────────────────────────

let db: Database.Database | null = null;

// Inline schema for reliability (no file dependency)
const SCHEMA = `
-- Token usage log (append-only)
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  tokens_used INTEGER NOT NULL,
  model TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_token_usage_terminal_date ON token_usage (terminal, DATE(timestamp));
CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage (session_id);

-- Dispatch mode configuration (single row table)
CREATE TABLE IF NOT EXISTS dispatch_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'manual' CHECK(mode IN ('auto', 'manual', 'scheduled')),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

INSERT OR IGNORE INTO dispatch_config (id, mode) VALUES (1, 'manual');

-- Dispatch proposals (Conductor -> Root approval)
CREATE TABLE IF NOT EXISTS dispatch_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT UNIQUE NOT NULL,
  terminal TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reason TEXT,
  estimated_tokens INTEGER,
  proposed_by TEXT NOT NULL,
  proposed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  decided_by TEXT,
  decided_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON dispatch_proposals (status);
CREATE INDEX IF NOT EXISTS idx_proposals_terminal ON dispatch_proposals (terminal, proposed_at);

-- Dispatch queue (active dispatch requests)
CREATE TABLE IF NOT EXISTS dispatch_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  terminal TEXT NOT NULL,
  priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical', 'high', 'medium', 'low')),
  estimated_tokens INTEGER,
  queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'executing', 'completed', 'failed', 'cancelled')),
  session_id TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  tokens_actual INTEGER,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON dispatch_queue (status, priority);
CREATE INDEX IF NOT EXISTS idx_queue_terminal ON dispatch_queue (terminal, status);

-- Budget configuration (per-terminal limits)
CREATE TABLE IF NOT EXISTS budget_config (
  terminal TEXT PRIMARY KEY,
  daily_limit INTEGER NOT NULL DEFAULT 10000,
  hourly_limit INTEGER,
  priority_reserve INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO budget_config (terminal, daily_limit, priority_reserve) VALUES
  ('root', 20000, 5000),
  ('conductor', 15000, 3000),
  ('backend', 10000, 2000),
  ('frontend', 10000, 2000),
  ('architect', 10000, 2000),
  ('librarian', 5000, 1000),
  ('explorer', 5000, 1000),
  ('designer', 5000, 1000);

-- Alert log
CREATE TABLE IF NOT EXISTS budget_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL CHECK(alert_type IN ('threshold_80', 'threshold_90', 'budget_depleted', 'terminal_over')),
  terminal TEXT,
  threshold_percent INTEGER,
  tokens_used INTEGER,
  tokens_limit INTEGER,
  message TEXT,
  notified_via TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alerts_date ON budget_alerts (DATE(created_at));

-- View: Today's usage summary
CREATE VIEW IF NOT EXISTS v_today_usage AS
SELECT
  terminal,
  SUM(tokens_used) as tokens_today,
  COUNT(*) as session_count
FROM token_usage
WHERE DATE(timestamp) = DATE('now')
GROUP BY terminal;

-- View: Budget status per terminal
CREATE VIEW IF NOT EXISTS v_budget_status AS
SELECT
  b.terminal,
  b.daily_limit,
  COALESCE(u.tokens_today, 0) as tokens_used,
  b.daily_limit - COALESCE(u.tokens_today, 0) as tokens_remaining,
  ROUND(COALESCE(u.tokens_today, 0) * 100.0 / b.daily_limit, 1) as usage_percent,
  CASE
    WHEN COALESCE(u.tokens_today, 0) >= b.daily_limit THEN 'depleted'
    WHEN COALESCE(u.tokens_today, 0) >= b.daily_limit * 0.9 THEN 'critical'
    WHEN COALESCE(u.tokens_today, 0) >= b.daily_limit * 0.8 THEN 'warning'
    ELSE 'ok'
  END as status
FROM budget_config b
LEFT JOIN v_today_usage u ON b.terminal = u.terminal;
`;

export function initDispatchDb(): Database.Database {
  if (db) return db;

  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Execute inline schema
  db.exec(SCHEMA);

  console.log('[DispatchDB] Initialized at', DB_PATH);
  return db;
}

export function closeDispatchDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function getDb(): Database.Database {
  if (!db) {
    return initDispatchDb();
  }
  return db;
}

// ── Dispatch Mode ────────────────────────────────────────────────────────────

export function getDispatchMode(): DispatchMode {
  const row = getDb().prepare('SELECT mode FROM dispatch_config WHERE id = 1').get() as { mode: string } | undefined;
  return (row?.mode as DispatchMode) || 'manual';
}

export function setDispatchMode(mode: DispatchMode, updatedBy: string = 'system'): void {
  getDb().prepare(`
    UPDATE dispatch_config
    SET mode = ?, updated_at = datetime('now'), updated_by = ?
    WHERE id = 1
  `).run(mode, updatedBy);

  log(`[DispatchControl] Mode set to: ${mode} (by ${updatedBy})`);
}

// ── Token Usage Recording ────────────────────────────────────────────────────

export function recordTokenUsage(usage: TokenUsage): void {
  getDb().prepare(`
    INSERT INTO token_usage (terminal, session_id, task_id, tokens_used, model)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    usage.terminal,
    usage.sessionId || null,
    usage.taskId || null,
    usage.tokensUsed,
    usage.model || null
  );

  // Check thresholds and send alerts
  checkAndAlert(usage.terminal);
}

// ── Budget Queries ───────────────────────────────────────────────────────────

export function getTerminalBudgetStatus(terminal: string): BudgetStatus {
  const row = getDb().prepare(`
    SELECT * FROM v_budget_status WHERE terminal = ?
  `).get(terminal) as {
    terminal: string;
    daily_limit: number;
    tokens_used: number;
    tokens_remaining: number;
    usage_percent: number;
    status: string;
  } | undefined;

  if (!row) {
    // Terminal not in config, return default
    return {
      terminal,
      dailyLimit: 10000,
      tokensUsed: 0,
      tokensRemaining: 10000,
      usagePercent: 0,
      status: 'ok',
    };
  }

  return {
    terminal: row.terminal,
    dailyLimit: row.daily_limit,
    tokensUsed: row.tokens_used,
    tokensRemaining: row.tokens_remaining,
    usagePercent: row.usage_percent,
    status: row.status as BudgetStatus['status'],
  };
}

export function getDailyBudgetSummary(date?: string): DailyBudgetSummary {
  const targetDate = date || new Date().toISOString().split('T')[0];

  // Get all terminal statuses
  const rows = getDb().prepare(`
    SELECT * FROM v_budget_status
  `).all() as Array<{
    terminal: string;
    daily_limit: number;
    tokens_used: number;
    tokens_remaining: number;
    usage_percent: number;
    status: string;
  }>;

  const byTerminal: Record<string, BudgetStatus> = {};
  let totalLimit = 0;
  let totalUsed = 0;

  for (const row of rows) {
    byTerminal[row.terminal] = {
      terminal: row.terminal,
      dailyLimit: row.daily_limit,
      tokensUsed: row.tokens_used,
      tokensRemaining: row.tokens_remaining,
      usagePercent: row.usage_percent,
      status: row.status as BudgetStatus['status'],
    };
    totalLimit += row.daily_limit;
    totalUsed += row.tokens_used;
  }

  // Calculate reset time (midnight Budapest time)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  return {
    date: targetDate,
    totalLimit,
    totalUsed,
    totalRemaining: totalLimit - totalUsed,
    byTerminal,
    resetAt: tomorrow.toISOString(),
  };
}

// ── Dispatch Check ───────────────────────────────────────────────────────────

export function canDispatch(terminal: string, estimatedTokens: number = 5000, priority: string = 'medium'): DispatchCheck {
  const mode = getDispatchMode();

  // In manual mode, always require explicit approval
  if (mode === 'manual') {
    return {
      allowed: false,
      reason: 'Manual mode - requires explicit dispatch approval',
    };
  }

  const status = getTerminalBudgetStatus(terminal);

  // Check if budget depleted
  if (status.status === 'depleted') {
    // Critical priority can use reserve
    if (priority === 'critical') {
      const config = getDb().prepare(`
        SELECT priority_reserve FROM budget_config WHERE terminal = ?
      `).get(terminal) as { priority_reserve: number } | undefined;

      const reserve = config?.priority_reserve || 0;
      if (reserve > 0 && estimatedTokens <= reserve) {
        return {
          allowed: true,
          reason: 'Using priority reserve',
          budgetRemaining: reserve - estimatedTokens,
          estimatedAfter: status.tokensUsed + estimatedTokens,
        };
      }
    }

    return {
      allowed: false,
      reason: `Budget depleted for ${terminal}`,
      budgetRemaining: 0,
    };
  }

  // Check if estimated tokens fit within remaining budget
  if (estimatedTokens > status.tokensRemaining) {
    return {
      allowed: false,
      reason: `Insufficient budget: need ${estimatedTokens}, have ${status.tokensRemaining}`,
      budgetRemaining: status.tokensRemaining,
    };
  }

  return {
    allowed: true,
    budgetRemaining: status.tokensRemaining - estimatedTokens,
    estimatedAfter: status.tokensUsed + estimatedTokens,
  };
}

// ── Alert System ─────────────────────────────────────────────────────────────

async function checkAndAlert(terminal: string): Promise<void> {
  const status = getTerminalBudgetStatus(terminal);

  // Check if we should send an alert
  let alertType: string | null = null;
  let message: string | null = null;

  if (status.status === 'depleted') {
    alertType = 'budget_depleted';
    message = `🚨 Budget depleted: ${terminal} used ${status.tokensUsed}/${status.dailyLimit} tokens (${status.usagePercent}%)`;
  } else if (status.status === 'critical' && status.usagePercent >= 90) {
    alertType = 'threshold_90';
    message = `⚠️ 90% budget used: ${terminal} at ${status.tokensUsed}/${status.dailyLimit} tokens`;
  } else if (status.status === 'warning' && status.usagePercent >= 80 && status.usagePercent < 90) {
    alertType = 'threshold_80';
    message = `📊 80% budget used: ${terminal} at ${status.tokensUsed}/${status.dailyLimit} tokens`;
  }

  if (!alertType || !message) return;

  // Check if we already sent this alert today
  const existingAlert = getDb().prepare(`
    SELECT id FROM budget_alerts
    WHERE alert_type = ? AND terminal = ? AND DATE(created_at) = DATE('now')
  `).get(alertType, terminal);

  if (existingAlert) return; // Already alerted

  // Log alert
  getDb().prepare(`
    INSERT INTO budget_alerts (alert_type, terminal, threshold_percent, tokens_used, tokens_limit, message, notified_via)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    alertType,
    terminal,
    Math.round(status.usagePercent),
    status.tokensUsed,
    status.dailyLimit,
    message,
    'telegram'
  );

  // Send Telegram notification
  try {
    await telegram(message);
    await log(`[BudgetAlert] ${message}`);
  } catch (err) {
    console.error('[BudgetAlert] Failed to send:', err);
  }
}

// ── Budget Configuration ─────────────────────────────────────────────────────

export function setTerminalBudget(terminal: string, dailyLimit: number, priorityReserve: number = 0): void {
  getDb().prepare(`
    INSERT INTO budget_config (terminal, daily_limit, priority_reserve, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(terminal) DO UPDATE SET
      daily_limit = excluded.daily_limit,
      priority_reserve = excluded.priority_reserve,
      updated_at = datetime('now')
  `).run(terminal, dailyLimit, priorityReserve);
}

export function getAllBudgetConfigs(): Array<{ terminal: string; dailyLimit: number; priorityReserve: number }> {
  const rows = getDb().prepare(`
    SELECT terminal, daily_limit, priority_reserve FROM budget_config
  `).all() as Array<{ terminal: string; daily_limit: number; priority_reserve: number }>;

  return rows.map(r => ({
    terminal: r.terminal,
    dailyLimit: r.daily_limit,
    priorityReserve: r.priority_reserve,
  }));
}

// ── Dispatch Queue ───────────────────────────────────────────────────────────

export interface QueuedDispatch {
  messageId: string;
  terminal: string;
  priority: string;
  estimatedTokens: number;
  queuedAt: string;
  status: string;
}

export function queueDispatch(
  messageId: string,
  terminal: string,
  priority: string = 'medium',
  estimatedTokens: number = 5000
): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO dispatch_queue (message_id, terminal, priority, estimated_tokens, status)
    VALUES (?, ?, ?, ?, 'queued')
  `).run(messageId, terminal, priority, estimatedTokens);
}

export function getDispatchQueue(): QueuedDispatch[] {
  const rows = getDb().prepare(`
    SELECT message_id, terminal, priority, estimated_tokens, queued_at, status
    FROM dispatch_queue
    WHERE status IN ('queued', 'executing')
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
      END,
      queued_at ASC
  `).all() as Array<{
    message_id: string;
    terminal: string;
    priority: string;
    estimated_tokens: number;
    queued_at: string;
    status: string;
  }>;

  return rows.map(r => ({
    messageId: r.message_id,
    terminal: r.terminal,
    priority: r.priority,
    estimatedTokens: r.estimated_tokens,
    queuedAt: r.queued_at,
    status: r.status,
  }));
}

export function markDispatchExecuting(messageId: string, sessionId: string): void {
  getDb().prepare(`
    UPDATE dispatch_queue
    SET status = 'executing', session_id = ?, started_at = datetime('now')
    WHERE message_id = ?
  `).run(sessionId, messageId);
}

export function markDispatchCompleted(messageId: string, tokensActual?: number): void {
  getDb().prepare(`
    UPDATE dispatch_queue
    SET status = 'completed', completed_at = datetime('now'), tokens_actual = ?
    WHERE message_id = ?
  `).run(tokensActual || null, messageId);
}

export function markDispatchFailed(messageId: string, errorMessage: string): void {
  getDb().prepare(`
    UPDATE dispatch_queue
    SET status = 'failed', completed_at = datetime('now'), error_message = ?
    WHERE message_id = ?
  `).run(errorMessage, messageId);
}

// ── Usage Statistics ─────────────────────────────────────────────────────────

export interface UsageStats {
  today: number;
  thisWeek: number;
  thisMonth: number;
  byModel: Record<string, number>;
}

export function getUsageStats(terminal?: string): UsageStats {
  const whereClause = terminal ? 'WHERE terminal = ?' : '';
  const params = terminal ? [terminal] : [];

  const today = getDb().prepare(`
    SELECT COALESCE(SUM(tokens_used), 0) as total
    FROM token_usage
    ${whereClause}
    ${whereClause ? 'AND' : 'WHERE'} DATE(timestamp) = DATE('now')
  `).get(...params) as { total: number };

  const thisWeek = getDb().prepare(`
    SELECT COALESCE(SUM(tokens_used), 0) as total
    FROM token_usage
    ${whereClause}
    ${whereClause ? 'AND' : 'WHERE'} timestamp >= datetime('now', '-7 days')
  `).get(...params) as { total: number };

  const thisMonth = getDb().prepare(`
    SELECT COALESCE(SUM(tokens_used), 0) as total
    FROM token_usage
    ${whereClause}
    ${whereClause ? 'AND' : 'WHERE'} timestamp >= datetime('now', 'start of month')
  `).get(...params) as { total: number };

  const byModelRows = getDb().prepare(`
    SELECT model, SUM(tokens_used) as total
    FROM token_usage
    ${whereClause}
    ${whereClause ? 'AND' : 'WHERE'} DATE(timestamp) = DATE('now')
    GROUP BY model
  `).all(...params) as Array<{ model: string | null; total: number }>;

  const byModel: Record<string, number> = {};
  for (const row of byModelRows) {
    byModel[row.model || 'unknown'] = row.total;
  }

  return {
    today: today.total,
    thisWeek: thisWeek.total,
    thisMonth: thisMonth.total,
    byModel,
  };
}
