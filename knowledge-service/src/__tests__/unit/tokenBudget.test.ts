import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import Database from 'better-sqlite3';

/**
 * Token Budget Tests — Dispatch Control Phase 2
 *
 * Tests budget tracking, dispatch mode, and queue management.
 * Uses in-memory database for isolation.
 */

// In-memory test database
let testDb: Database.Database;

// Helper functions that work directly on test database
function resetTestDb() {
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      tokens_used INTEGER NOT NULL,
      model TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dispatch_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL DEFAULT 'manual',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    );

    INSERT OR IGNORE INTO dispatch_config (id, mode) VALUES (1, 'manual');

    CREATE TABLE IF NOT EXISTS dispatch_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE NOT NULL,
      terminal TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      estimated_tokens INTEGER,
      queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'queued',
      session_id TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      tokens_actual INTEGER,
      error_message TEXT
    );

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

    CREATE VIEW IF NOT EXISTS v_today_usage AS
    SELECT terminal, SUM(tokens_used) as tokens_today, COUNT(*) as session_count
    FROM token_usage WHERE DATE(timestamp) = DATE('now') GROUP BY terminal;

    CREATE VIEW IF NOT EXISTS v_budget_status AS
    SELECT b.terminal, b.daily_limit,
      COALESCE(u.tokens_today, 0) as tokens_used,
      b.daily_limit - COALESCE(u.tokens_today, 0) as tokens_remaining,
      ROUND(COALESCE(u.tokens_today, 0) * 100.0 / b.daily_limit, 1) as usage_percent,
      CASE
        WHEN COALESCE(u.tokens_today, 0) >= b.daily_limit THEN 'depleted'
        WHEN COALESCE(u.tokens_today, 0) >= b.daily_limit * 0.9 THEN 'critical'
        WHEN COALESCE(u.tokens_today, 0) >= b.daily_limit * 0.8 THEN 'warning'
        ELSE 'ok'
      END as status
    FROM budget_config b LEFT JOIN v_today_usage u ON b.terminal = u.terminal;
  `);
}

// Test helpers using testDb
function getMode(): string {
  const row = testDb.prepare('SELECT mode FROM dispatch_config WHERE id = 1').get() as { mode: string };
  return row?.mode || 'manual';
}

function setMode(mode: string, by: string) {
  testDb.prepare('UPDATE dispatch_config SET mode = ?, updated_by = ? WHERE id = 1').run(mode, by);
}

function recordUsage(terminal: string, tokensUsed: number, sessionId?: string, taskId?: string, model?: string) {
  testDb.prepare('INSERT INTO token_usage (terminal, session_id, task_id, tokens_used, model) VALUES (?, ?, ?, ?, ?)')
    .run(terminal, sessionId, taskId, tokensUsed, model);
}

function getStats(terminal?: string) {
  const where = terminal ? 'WHERE terminal = ?' : '';
  const params = terminal ? [terminal] : [];

  const today = testDb.prepare(`SELECT COALESCE(SUM(tokens_used), 0) as total FROM token_usage ${where} ${where ? 'AND' : 'WHERE'} DATE(timestamp) = DATE('now')`).get(...params) as { total: number };

  const byModelRows = testDb.prepare(`SELECT model, SUM(tokens_used) as total FROM token_usage ${where} ${where ? 'AND' : 'WHERE'} DATE(timestamp) = DATE('now') GROUP BY model`).all(...params) as Array<{ model: string; total: number }>;

  const byModel: Record<string, number> = {};
  for (const row of byModelRows) {
    byModel[row.model || 'unknown'] = row.total;
  }

  return { today: today.total, byModel };
}

function getBudgetStatus(terminal: string) {
  const row = testDb.prepare('SELECT * FROM v_budget_status WHERE terminal = ?').get(terminal) as any;
  if (!row) return { terminal, dailyLimit: 10000, tokensUsed: 0, tokensRemaining: 10000, usagePercent: 0, status: 'ok' };
  return {
    terminal: row.terminal,
    dailyLimit: row.daily_limit,
    tokensUsed: row.tokens_used,
    tokensRemaining: row.tokens_remaining,
    usagePercent: row.usage_percent,
    status: row.status,
  };
}

function getDailySummary() {
  const rows = testDb.prepare('SELECT * FROM v_budget_status').all() as any[];
  let totalUsed = 0;
  const byTerminal: Record<string, any> = {};
  for (const row of rows) {
    byTerminal[row.terminal] = { tokensUsed: row.tokens_used };
    totalUsed += row.tokens_used;
  }
  return { totalUsed, byTerminal };
}

function checkCanDispatch(terminal: string, estimated: number, priority: string = 'medium') {
  const mode = getMode();
  if (mode === 'manual') return { allowed: false, reason: 'Manual mode - requires explicit dispatch approval' };

  const status = getBudgetStatus(terminal);
  if (status.status === 'depleted') {
    if (priority === 'critical') {
      const cfg = testDb.prepare('SELECT priority_reserve FROM budget_config WHERE terminal = ?').get(terminal) as { priority_reserve: number };
      if (cfg?.priority_reserve > 0 && estimated <= cfg.priority_reserve) {
        return { allowed: true, reason: 'Using priority reserve', budgetRemaining: cfg.priority_reserve - estimated };
      }
    }
    return { allowed: false, reason: `Budget depleted for ${terminal}`, budgetRemaining: 0 };
  }
  if (estimated > status.tokensRemaining) {
    return { allowed: false, reason: `Insufficient budget: need ${estimated}, have ${status.tokensRemaining}`, budgetRemaining: status.tokensRemaining };
  }
  return { allowed: true, budgetRemaining: status.tokensRemaining - estimated };
}

function queueItem(messageId: string, terminal: string, priority: string, estimated: number) {
  testDb.prepare("INSERT OR REPLACE INTO dispatch_queue (message_id, terminal, priority, estimated_tokens, status) VALUES (?, ?, ?, ?, 'queued')").run(messageId, terminal, priority, estimated);
}

function getQueue() {
  return testDb.prepare(`SELECT message_id, terminal, priority, estimated_tokens, queued_at, status FROM dispatch_queue WHERE status IN ('queued', 'executing') ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, queued_at ASC`).all() as any[];
}

function markExecuting(messageId: string, sessionId: string) {
  testDb.prepare("UPDATE dispatch_queue SET status = 'executing', session_id = ? WHERE message_id = ?").run(sessionId, messageId);
}

function markCompleted(messageId: string) {
  testDb.prepare("UPDATE dispatch_queue SET status = 'completed' WHERE message_id = ?").run(messageId);
}

function markFailed(messageId: string, error: string) {
  testDb.prepare("UPDATE dispatch_queue SET status = 'failed', error_message = ? WHERE message_id = ?").run(error, messageId);
}

function setBudget(terminal: string, limit: number, reserve: number) {
  testDb.prepare('INSERT INTO budget_config (terminal, daily_limit, priority_reserve) VALUES (?, ?, ?) ON CONFLICT(terminal) DO UPDATE SET daily_limit = excluded.daily_limit, priority_reserve = excluded.priority_reserve').run(terminal, limit, reserve);
}

function getAllBudgets() {
  return testDb.prepare('SELECT terminal, daily_limit as dailyLimit, priority_reserve as priorityReserve FROM budget_config').all();
}

describe('TokenBudget', () => {
  beforeEach(() => {
    resetTestDb();
  });

  describe('Dispatch Mode', () => {
    it('should default to manual mode', () => {
      expect(getMode()).toBe('manual');
    });

    it('should set dispatch mode', () => {
      setMode('auto', 'test');
      expect(getMode()).toBe('auto');

      setMode('scheduled', 'test');
      expect(getMode()).toBe('scheduled');

      setMode('manual', 'test');
      expect(getMode()).toBe('manual');
    });
  });

  describe('Token Usage Recording', () => {
    it('should record token usage', () => {
      recordUsage('backend', 5000, 'session-1', 'MSG-BACKEND-001', 'sonnet');

      const stats = getStats('backend');
      expect(stats.today).toBe(5000);
    });

    it('should accumulate token usage', () => {
      recordUsage('backend', 3000);
      recordUsage('backend', 2000);

      const stats = getStats('backend');
      expect(stats.today).toBe(5000);
    });

    it('should track usage by model', () => {
      recordUsage('backend', 3000, undefined, undefined, 'sonnet');
      recordUsage('backend', 1000, undefined, undefined, 'haiku');

      const stats = getStats('backend');
      expect(stats.byModel.sonnet).toBe(3000);
      expect(stats.byModel.haiku).toBe(1000);
    });
  });

  describe('Budget Status', () => {
    it('should return budget status for terminal', () => {
      const status = getBudgetStatus('backend');

      expect(status.terminal).toBe('backend');
      expect(status.dailyLimit).toBe(10000);
      expect(status.tokensUsed).toBe(0);
      expect(status.tokensRemaining).toBe(10000);
      expect(status.usagePercent).toBe(0);
      expect(status.status).toBe('ok');
    });

    it('should update status after token usage', () => {
      recordUsage('backend', 8000);

      const status = getBudgetStatus('backend');
      expect(status.tokensUsed).toBe(8000);
      expect(status.tokensRemaining).toBe(2000);
      expect(status.usagePercent).toBe(80);
      expect(status.status).toBe('warning');
    });

    it('should show critical status at 90%', () => {
      recordUsage('backend', 9000);

      const status = getBudgetStatus('backend');
      expect(status.status).toBe('critical');
    });

    it('should show depleted status at 100%', () => {
      recordUsage('backend', 10000);

      const status = getBudgetStatus('backend');
      expect(status.status).toBe('depleted');
    });
  });

  describe('Daily Budget Summary', () => {
    it('should return summary for all terminals', () => {
      recordUsage('backend', 5000);
      recordUsage('frontend', 3000);

      const summary = getDailySummary();

      expect(summary.totalUsed).toBe(8000);
      expect(summary.byTerminal.backend.tokensUsed).toBe(5000);
      expect(summary.byTerminal.frontend.tokensUsed).toBe(3000);
    });
  });

  describe('Dispatch Check', () => {
    it('should reject dispatch in manual mode', () => {
      setMode('manual', 'test');

      const check = checkCanDispatch('backend', 5000);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('Manual mode');
    });

    it('should allow dispatch in auto mode with budget', () => {
      setMode('auto', 'test');

      const check = checkCanDispatch('backend', 5000);
      expect(check.allowed).toBe(true);
      expect(check.budgetRemaining).toBe(5000);
    });

    it('should reject dispatch when budget depleted', () => {
      setMode('auto', 'test');
      recordUsage('backend', 10000);

      const check = checkCanDispatch('backend', 1000);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('depleted');
    });

    it('should reject dispatch when insufficient budget', () => {
      setMode('auto', 'test');
      recordUsage('backend', 8000);

      const check = checkCanDispatch('backend', 5000);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('Insufficient budget');
    });

    it('should allow critical priority to use reserve', () => {
      setMode('auto', 'test');
      recordUsage('backend', 10000);

      const check = checkCanDispatch('backend', 1000, 'critical');
      expect(check.allowed).toBe(true);
      expect(check.reason).toContain('priority reserve');
    });
  });

  describe('Budget Configuration', () => {
    it('should set terminal budget', () => {
      setBudget('test-terminal', 25000, 5000);

      const configs = getAllBudgets() as any[];
      const testConfig = configs.find(c => c.terminal === 'test-terminal');

      expect(testConfig).toBeDefined();
      expect(testConfig?.dailyLimit).toBe(25000);
      expect(testConfig?.priorityReserve).toBe(5000);
    });

    it('should update existing terminal budget', () => {
      setBudget('backend', 15000, 3000);

      const status = getBudgetStatus('backend');
      expect(status.dailyLimit).toBe(15000);
    });
  });

  describe('Dispatch Queue', () => {
    it('should queue dispatch request', () => {
      queueItem('MSG-BACKEND-001', 'backend', 'high', 5000);

      const queue = getQueue();
      expect(queue.length).toBe(1);
      expect(queue[0].message_id).toBe('MSG-BACKEND-001');
      expect(queue[0].terminal).toBe('backend');
      expect(queue[0].priority).toBe('high');
      expect(queue[0].status).toBe('queued');
    });

    it('should order queue by priority', () => {
      queueItem('msg-low', 'backend', 'low', 1000);
      queueItem('msg-critical', 'backend', 'critical', 1000);
      queueItem('msg-high', 'backend', 'high', 1000);

      const queue = getQueue();
      expect(queue[0].message_id).toBe('msg-critical');
      expect(queue[1].message_id).toBe('msg-high');
      expect(queue[2].message_id).toBe('msg-low');
    });

    it('should mark dispatch as executing', () => {
      queueItem('MSG-001', 'backend', 'high', 5000);
      markExecuting('MSG-001', 'session-abc');

      const queue = getQueue();
      const item = queue.find(q => q.message_id === 'MSG-001');
      expect(item?.status).toBe('executing');
    });

    it('should mark dispatch as completed', () => {
      queueItem('MSG-001', 'backend', 'high', 5000);
      markExecuting('MSG-001', 'session-abc');
      markCompleted('MSG-001');

      const queue = getQueue();
      const item = queue.find(q => q.message_id === 'MSG-001');
      expect(item).toBeUndefined();
    });

    it('should mark dispatch as failed', () => {
      queueItem('MSG-001', 'backend', 'high', 5000);
      markExecuting('MSG-001', 'session-abc');
      markFailed('MSG-001', 'Session timeout');

      const queue = getQueue();
      const item = queue.find(q => q.message_id === 'MSG-001');
      expect(item).toBeUndefined();
    });
  });

  describe('Usage Statistics', () => {
    it('should return usage stats for all terminals', () => {
      recordUsage('backend', 5000);
      recordUsage('frontend', 3000);

      const stats = getStats();
      expect(stats.today).toBe(8000);
    });

    it('should return usage stats for specific terminal', () => {
      recordUsage('backend', 5000);
      recordUsage('frontend', 3000);

      const backendStats = getStats('backend');
      expect(backendStats.today).toBe(5000);

      const frontendStats = getStats('frontend');
      expect(frontendStats.today).toBe(3000);
    });
  });
});
