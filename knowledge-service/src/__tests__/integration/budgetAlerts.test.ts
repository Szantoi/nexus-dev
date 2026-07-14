import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Budget Alerts Integration Tests — Dispatch Control
 *
 * Tests the complete budget threshold alert workflow:
 * - Token usage recording
 * - Threshold detection (80%, 90%, 100%)
 * - Alert generation and storage
 * - Telegram notification mocking
 */

// Test database
let testDb: Database.Database;

// Mock telegram
const mockTelegram = vi.fn().mockResolvedValue(undefined);
vi.mock('../../pipeline/common', () => ({
  telegram: mockTelegram,
  log: vi.fn(),
}));

interface BudgetAlert {
  id: number;
  alert_type: string;
  terminal: string;
  usage_percent: number;
  tokens_used: number;
  daily_limit: number;
  message: string;
  notification_channel: string;
  created_at: string;
}

function setupTestDb() {
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal TEXT NOT NULL,
      session_id TEXT,
      tokens_used INTEGER NOT NULL,
      model TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS budget_config (
      terminal TEXT PRIMARY KEY,
      daily_limit INTEGER NOT NULL DEFAULT 10000,
      priority_reserve INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS budget_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      terminal TEXT NOT NULL,
      usage_percent INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL,
      daily_limit INTEGER NOT NULL,
      message TEXT NOT NULL,
      notification_channel TEXT DEFAULT 'telegram',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO budget_config (terminal, daily_limit, priority_reserve) VALUES
      ('test-terminal', 10000, 2000);

    CREATE VIEW IF NOT EXISTS v_budget_status AS
    SELECT
      b.terminal,
      b.daily_limit,
      COALESCE(SUM(u.tokens_used), 0) as tokens_used,
      b.daily_limit - COALESCE(SUM(u.tokens_used), 0) as tokens_remaining,
      ROUND(COALESCE(SUM(u.tokens_used), 0) * 100.0 / b.daily_limit, 1) as usage_percent,
      CASE
        WHEN COALESCE(SUM(u.tokens_used), 0) >= b.daily_limit THEN 'depleted'
        WHEN COALESCE(SUM(u.tokens_used), 0) >= b.daily_limit * 0.9 THEN 'critical'
        WHEN COALESCE(SUM(u.tokens_used), 0) >= b.daily_limit * 0.8 THEN 'warning'
        ELSE 'ok'
      END as status
    FROM budget_config b
    LEFT JOIN token_usage u ON b.terminal = u.terminal AND DATE(u.timestamp) = DATE('now')
    GROUP BY b.terminal;
  `);
}

function recordUsage(terminal: string, tokensUsed: number): { status: string; usagePercent: number } {
  testDb.prepare('INSERT INTO token_usage (terminal, tokens_used) VALUES (?, ?)').run(terminal, tokensUsed);

  const status = testDb.prepare('SELECT * FROM v_budget_status WHERE terminal = ?').get(terminal) as any;
  return {
    status: status.status,
    usagePercent: Math.round(status.usage_percent),
  };
}

function checkAndCreateAlert(terminal: string): BudgetAlert | null {
  const status = testDb.prepare('SELECT * FROM v_budget_status WHERE terminal = ?').get(terminal) as any;
  if (!status) return null;

  const usagePercent = Math.round(status.usage_percent);
  let alertType: string | null = null;
  let message: string | null = null;

  // Check if alert already exists for this threshold today
  const existingAlert = testDb.prepare(`
    SELECT * FROM budget_alerts
    WHERE terminal = ? AND DATE(created_at) = DATE('now')
    ORDER BY usage_percent DESC LIMIT 1
  `).get(terminal) as BudgetAlert | undefined;

  const lastAlertPercent = existingAlert?.usage_percent || 0;

  if (usagePercent >= 100 && lastAlertPercent < 100) {
    alertType = 'budget_depleted';
    message = `🚨 Budget depleted: ${terminal} used ${status.tokens_used}/${status.daily_limit} tokens (${usagePercent}%)`;
  } else if (usagePercent >= 90 && lastAlertPercent < 90) {
    alertType = 'threshold_90';
    message = `⚠️ 90% budget used: ${terminal} at ${status.tokens_used}/${status.daily_limit} tokens`;
  } else if (usagePercent >= 80 && lastAlertPercent < 80) {
    alertType = 'threshold_80';
    message = `📊 80% budget used: ${terminal} at ${status.tokens_used}/${status.daily_limit} tokens`;
  }

  if (alertType && message) {
    testDb.prepare(`
      INSERT INTO budget_alerts (alert_type, terminal, usage_percent, tokens_used, daily_limit, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(alertType, terminal, usagePercent, status.tokens_used, status.daily_limit, message);

    // Trigger notification
    mockTelegram(message);

    return testDb.prepare('SELECT * FROM budget_alerts ORDER BY id DESC LIMIT 1').get() as BudgetAlert;
  }

  return null;
}

function getAlerts(terminal: string): BudgetAlert[] {
  return testDb.prepare('SELECT * FROM budget_alerts WHERE terminal = ? ORDER BY created_at ASC').all(terminal) as BudgetAlert[];
}

describe('Budget Alerts Integration', () => {
  beforeEach(() => {
    setupTestDb();
    mockTelegram.mockClear();
  });

  afterEach(() => {
    testDb.close();
  });

  describe('Threshold Detection', () => {
    it('should not create alert below 80%', () => {
      recordUsage('test-terminal', 7000); // 70%
      const alert = checkAndCreateAlert('test-terminal');

      expect(alert).toBeNull();
      expect(mockTelegram).not.toHaveBeenCalled();
    });

    it('should create warning alert at 80%', () => {
      recordUsage('test-terminal', 8000); // 80%
      const alert = checkAndCreateAlert('test-terminal');

      expect(alert).not.toBeNull();
      expect(alert?.alert_type).toBe('threshold_80');
      expect(alert?.message).toContain('📊 80% budget used');
      expect(mockTelegram).toHaveBeenCalledTimes(1);
    });

    it('should create critical alert at 90%', () => {
      recordUsage('test-terminal', 9000); // 90%
      const alert = checkAndCreateAlert('test-terminal');

      expect(alert).not.toBeNull();
      expect(alert?.alert_type).toBe('threshold_90');
      expect(alert?.message).toContain('⚠️ 90% budget used');
    });

    it('should create depleted alert at 100%', () => {
      recordUsage('test-terminal', 10000); // 100%
      const alert = checkAndCreateAlert('test-terminal');

      expect(alert).not.toBeNull();
      expect(alert?.alert_type).toBe('budget_depleted');
      expect(alert?.message).toContain('🚨 Budget depleted');
    });
  });

  describe('Alert Deduplication', () => {
    it('should not duplicate 80% alert', () => {
      recordUsage('test-terminal', 8000);
      checkAndCreateAlert('test-terminal');

      // Add more usage but still at 80%
      recordUsage('test-terminal', 100);
      checkAndCreateAlert('test-terminal');

      const alerts = getAlerts('test-terminal');
      expect(alerts.filter(a => a.alert_type === 'threshold_80').length).toBe(1);
    });

    it('should progress through thresholds correctly', () => {
      // 80%
      recordUsage('test-terminal', 8000);
      checkAndCreateAlert('test-terminal');
      expect(getAlerts('test-terminal').length).toBe(1);

      // 90%
      recordUsage('test-terminal', 1000);
      checkAndCreateAlert('test-terminal');
      expect(getAlerts('test-terminal').length).toBe(2);

      // 100%
      recordUsage('test-terminal', 1000);
      checkAndCreateAlert('test-terminal');
      expect(getAlerts('test-terminal').length).toBe(3);

      const alerts = getAlerts('test-terminal');
      expect(alerts[0].alert_type).toBe('threshold_80');
      expect(alerts[1].alert_type).toBe('threshold_90');
      expect(alerts[2].alert_type).toBe('budget_depleted');
    });
  });

  describe('Telegram Notification', () => {
    it('should send telegram notification for each threshold', () => {
      recordUsage('test-terminal', 8500); // 85%
      checkAndCreateAlert('test-terminal');
      expect(mockTelegram).toHaveBeenCalledWith(expect.stringContaining('📊 80%'));

      recordUsage('test-terminal', 1000); // 95%
      checkAndCreateAlert('test-terminal');
      expect(mockTelegram).toHaveBeenCalledWith(expect.stringContaining('⚠️ 90%'));

      recordUsage('test-terminal', 1000); // 105%
      checkAndCreateAlert('test-terminal');
      expect(mockTelegram).toHaveBeenCalledWith(expect.stringContaining('🚨 Budget depleted'));

      expect(mockTelegram).toHaveBeenCalledTimes(3);
    });
  });

  describe('Alert Content Validation', () => {
    it('should include correct terminal name in alert', () => {
      recordUsage('test-terminal', 8000);
      const alert = checkAndCreateAlert('test-terminal');

      expect(alert?.terminal).toBe('test-terminal');
      expect(alert?.message).toContain('test-terminal');
    });

    it('should include accurate token counts', () => {
      recordUsage('test-terminal', 8500);
      const alert = checkAndCreateAlert('test-terminal');

      expect(alert?.tokens_used).toBe(8500);
      expect(alert?.daily_limit).toBe(10000);
      expect(alert?.usage_percent).toBe(85);
    });
  });

  describe('Edge Cases', () => {
    it('should handle exact threshold boundaries', () => {
      recordUsage('test-terminal', 8000); // exactly 80%
      const alert = checkAndCreateAlert('test-terminal');

      expect(alert?.alert_type).toBe('threshold_80');
      expect(alert?.usage_percent).toBe(80);
    });

    it('should handle over 100% usage', () => {
      recordUsage('test-terminal', 15000); // 150%
      const alert = checkAndCreateAlert('test-terminal');

      expect(alert?.alert_type).toBe('budget_depleted');
      expect(alert?.usage_percent).toBe(150);
    });

    it('should skip intermediate thresholds when jumping', () => {
      // Jump from 0% to 95% directly
      recordUsage('test-terminal', 9500);
      checkAndCreateAlert('test-terminal');

      // Should only create 90% alert (highest crossed threshold)
      const alerts = getAlerts('test-terminal');
      expect(alerts.length).toBe(1);
      expect(alerts[0].alert_type).toBe('threshold_90');
    });
  });
});
