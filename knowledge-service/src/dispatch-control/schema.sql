-- Dispatch Control & Token Budget Schema
-- SpaceOS Knowledge Service
-- Created: 2026-06-23

-- Token usage log (append-only)
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  tokens_used INTEGER NOT NULL,
  model TEXT,  -- haiku, sonnet, opus
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_token_usage_terminal_date
  ON token_usage (terminal, DATE(timestamp));

CREATE INDEX IF NOT EXISTS idx_token_usage_session
  ON token_usage (session_id);

-- Dispatch mode configuration (single row table)
CREATE TABLE IF NOT EXISTS dispatch_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Only one row
  mode TEXT NOT NULL DEFAULT 'manual' CHECK(mode IN ('auto', 'manual', 'scheduled')),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

-- Insert default config
INSERT OR IGNORE INTO dispatch_config (id, mode) VALUES (1, 'manual');

-- Dispatch proposals (Conductor -> Root approval)
CREATE TABLE IF NOT EXISTS dispatch_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT UNIQUE NOT NULL,
  terminal TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reason TEXT,
  estimated_tokens INTEGER,
  proposed_by TEXT NOT NULL,  -- 'conductor', 'root'
  proposed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  decided_by TEXT,
  decided_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_proposals_status
  ON dispatch_proposals (status);

CREATE INDEX IF NOT EXISTS idx_proposals_terminal
  ON dispatch_proposals (terminal, proposed_at);

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

CREATE INDEX IF NOT EXISTS idx_queue_status
  ON dispatch_queue (status, priority);

CREATE INDEX IF NOT EXISTS idx_queue_terminal
  ON dispatch_queue (terminal, status);

-- Budget configuration (per-terminal limits)
CREATE TABLE IF NOT EXISTS budget_config (
  terminal TEXT PRIMARY KEY,
  daily_limit INTEGER NOT NULL DEFAULT 10000,
  hourly_limit INTEGER,
  priority_reserve INTEGER DEFAULT 0,  -- Reserved for critical tasks
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default budgets
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
  notified_via TEXT,  -- 'telegram', 'log', 'both'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alerts_date
  ON budget_alerts (DATE(created_at));

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
