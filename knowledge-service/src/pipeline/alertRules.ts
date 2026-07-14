/**
 * alertRules.ts — Alert Rules for Autonomous Development
 *
 * Triggers:
 * 1. Session stuck (>30 min no activity)
 * 2. Consecutive skips (3+ autonomous skip)
 * 3. BLOCKED timeout (>2h unresolved)
 * 4. No activity (>2h no task)
 *
 * Integrates with nightwatch.ts (2 min cycle)
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { SPACEOS_ROOT, telegram, log } from './common';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AlertRule {
  id: string;
  trigger: 'session_stuck' | 'consecutive_skips' | 'blocked_timeout' | 'no_activity';
  threshold: number; // minutes
  cooldown: number; // minutes
}

export interface AlertState {
  lastFired: Record<string, string>; // alertId -> ISO timestamp
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ALERT_STATE_FILE = path.join(SPACEOS_ROOT, '.alertState.json');

const ALERT_RULES: AlertRule[] = [
  { id: 'session_stuck', trigger: 'session_stuck', threshold: 30, cooldown: 30 },
  { id: 'consecutive_skips', trigger: 'consecutive_skips', threshold: 3, cooldown: 30 },
  { id: 'blocked_timeout', trigger: 'blocked_timeout', threshold: 120, cooldown: 30 },
  { id: 'no_activity', trigger: 'no_activity', threshold: 120, cooldown: 30 },
];

const API_BASE = process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:3456';

// ─── State Management ────────────────────────────────────────────────────────

async function loadAlertState(): Promise<AlertState> {
  try {
    const content = await fs.readFile(ALERT_STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { lastFired: {} };
  }
}

async function saveAlertState(state: AlertState): Promise<void> {
  await fs.writeFile(ALERT_STATE_FILE, JSON.stringify(state, null, 2));
}

async function shouldFireAlert(alertId: string, cooldownMinutes: number): Promise<boolean> {
  const state = await loadAlertState();
  const lastFired = state.lastFired[alertId];

  if (!lastFired) return true;

  const lastFiredAt = new Date(lastFired).getTime();
  const now = Date.now();
  const cooldownMs = cooldownMinutes * 60 * 1000;

  return now - lastFiredAt >= cooldownMs;
}

async function markAlertFired(alertId: string): Promise<void> {
  const state = await loadAlertState();
  state.lastFired[alertId] = new Date().toISOString();
  await saveAlertState(state);
}

// ─── Alert Checks ────────────────────────────────────────────────────────────

/**
 * 1. Session Stuck (>30 min no activity)
 */
export async function checkSessionStuck(): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/all`, {
      signal: AbortSignal.timeout(5000),
    });
    const sessions = await response.json();

    if (!Array.isArray(sessions)) return null;

    const now = Date.now();
    const threshold = 30 * 60 * 1000; // 30 minutes

    for (const session of sessions) {
      if (!session.active) continue;

      const lastActivity = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
      const inactiveDuration = now - lastActivity;

      if (inactiveDuration >= threshold) {
        const terminal = session.terminal || 'unknown';
        const minutes = Math.floor(inactiveDuration / 60000);
        const alertId = `session_stuck_${terminal}`;

        if (await shouldFireAlert(alertId, 30)) {
          await markAlertFired(alertId);
          return `🔴 [ALERT] ${terminal} stuck >${minutes}min`;
        }
      }
    }
  } catch (err) {
    await log(`[AlertRules] checkSessionStuck error: ${err}`);
  }

  return null;
}

/**
 * 2. Consecutive Skips (3+ autonomous skip)
 *
 * Note: The autonomous status endpoint doesn't currently return recentSkips.
 * We'll check for 3+ consecutive cycles with "skipped" status.
 */
export async function checkConsecutiveSkips(): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/api/autonomous/status`, {
      signal: AbortSignal.timeout(5000),
    });
    const status = await response.json() as { enabled: boolean };

    // Check if autonomous dev is enabled
    if (!status.enabled) return null;

    // Read recent cycle history from logs
    const logDir = path.join(SPACEOS_ROOT, 'logs/dispatcher');
    const logFile = path.join(logDir, 'nightwatch.log');

    try {
      const content = await fs.readFile(logFile, 'utf-8');
      const lines = content.split('\n').filter(line => line.includes('[AutonomousDev]'));
      const recentLines = lines.slice(-10); // last 10 cycles

      // Count consecutive skips
      let consecutiveSkips = 0;
      for (let i = recentLines.length - 1; i >= 0; i--) {
        if (recentLines[i].includes('skipped')) {
          consecutiveSkips++;
        } else if (recentLines[i].includes('dispatched')) {
          break; // Stop at first non-skip
        }
      }

      if (consecutiveSkips >= 3) {
        const alertId = 'consecutive_skips';
        if (await shouldFireAlert(alertId, 30)) {
          await markAlertFired(alertId);
          return `⚠️ [WARNING] Túl sok párhuzamos munka (${consecutiveSkips}+ skip)`;
        }
      }
    } catch {
      // Log file doesn't exist or can't be read
    }
  } catch (err) {
    await log(`[AlertRules] checkConsecutiveSkips error: ${err}`);
  }

  return null;
}

/**
 * 3. BLOCKED Timeout (>2h unresolved)
 */
export async function checkBlockedTimeout(): Promise<string | null> {
  try {
    const terminalsDir = path.join(SPACEOS_ROOT, 'terminals');
    const terminals = await fs.readdir(terminalsDir);

    const now = Date.now();
    const threshold = 120 * 60 * 1000; // 2 hours

    for (const terminal of terminals) {
      const outboxPath = path.join(terminalsDir, terminal, 'outbox');

      try {
        const files = await fs.readdir(outboxPath);

        for (const file of files) {
          if (!file.endsWith('.md')) continue;

          const filePath = path.join(outboxPath, file);
          const content = await fs.readFile(filePath, 'utf-8');

          // Parse frontmatter
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (!frontmatterMatch) continue;

          const frontmatter = frontmatterMatch[1];

          // Check if BLOCKED and UNREAD
          if (!frontmatter.includes('type: blocked')) continue;
          if (!frontmatter.includes('status: UNREAD')) continue;

          // Extract created date
          const createdMatch = frontmatter.match(/created:\s*(\d{4}-\d{2}-\d{2})/);
          if (!createdMatch) continue;

          const createdDate = new Date(createdMatch[1]).getTime();
          const blockedDuration = now - createdDate;

          if (blockedDuration >= threshold) {
            const hours = Math.floor(blockedDuration / 3600000);
            const taskId = file.replace('.md', '');
            const alertId = `blocked_timeout_${taskId}`;

            if (await shouldFireAlert(alertId, 30)) {
              await markAlertFired(alertId);
              return `🟡 [ESCALATION] ${terminal}/${taskId} blocked >${hours}h`;
            }
          }
        }
      } catch {
        // Outbox directory doesn't exist
      }
    }
  } catch (err) {
    await log(`[AlertRules] checkBlockedTimeout error: ${err}`);
  }

  return null;
}

/**
 * 4. No Activity (>2h no task)
 */
export async function checkNoActivity(): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/all`, {
      signal: AbortSignal.timeout(5000),
    });
    const sessions = await response.json();

    if (!Array.isArray(sessions)) return null;

    const now = Date.now();
    const threshold = 120 * 60 * 1000; // 2 hours

    // Find max lastActivity across all sessions
    let maxLastActivity = 0;
    for (const session of sessions) {
      if (session.lastActivity) {
        const lastActivity = new Date(session.lastActivity).getTime();
        if (lastActivity > maxLastActivity) {
          maxLastActivity = lastActivity;
        }
      }
    }

    if (maxLastActivity === 0) return null;

    const inactiveDuration = now - maxLastActivity;

    if (inactiveDuration >= threshold) {
      const hours = Math.floor(inactiveDuration / 3600000);
      const alertId = 'no_activity';

      if (await shouldFireAlert(alertId, 30)) {
        await markAlertFired(alertId);
        return `ℹ️ [INFO] Nincs aktív fejlesztés >${hours}h`;
      }
    }
  } catch (err) {
    await log(`[AlertRules] checkNoActivity error: ${err}`);
  }

  return null;
}

/**
 * 5. Memory Overflow (MEMORY.md >threshold)
 *
 * Daily check for terminal memory file sizes.
 * Thresholds: 50KB (conductor/root/backend), 35KB (others)
 * Actions: WARNING (>threshold), CRITICAL (>2×threshold), AUTO-TASK (>100KB)
 */
export async function checkMemoryOverflow(): Promise<string | null> {
  try {
    const terminals = ['root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer', 'monitor'];
    const alerts: Array<{ terminal: string; sizeKB: number; threshold: number; severity: string }> = [];

    for (const terminal of terminals) {
      const memoryPath = path.join(SPACEOS_ROOT, 'terminals', terminal, 'MEMORY.md');

      try {
        const stat = await fs.stat(memoryPath);
        const sizeKB = Math.round(stat.size / 1024);

        // Thresholds by terminal type
        const threshold = ['conductor', 'root', 'backend'].includes(terminal) ? 50 : 35;

        if (sizeKB > threshold) {
          const severity = sizeKB > threshold * 2 ? 'critical' : 'warning';
          alerts.push({ terminal, sizeKB, threshold, severity });
        }
      } catch {
        // MEMORY.md doesn't exist (skip)
      }
    }

    if (alerts.length === 0) return null;

    // Group by severity
    const critical = alerts.filter(a => a.severity === 'critical');
    const warning = alerts.filter(a => a.severity === 'warning');

    // Check if we should fire alert (daily cooldown)
    const alertId = 'memory_overflow';
    const cooldownHours = 24; // Daily check
    if (!(await shouldFireAlert(alertId, cooldownHours * 60))) {
      return null;
    }

    await markAlertFired(alertId);

    // Build alert message
    let message = '';
    if (critical.length > 0) {
      const terminalList = critical.map(a => `${a.terminal}(${a.sizeKB}KB)`).join(', ');
      message = `🔴 [CRITICAL] Memory overflow: ${terminalList}`;

      // Auto-create Librarian cleanup task for >100KB terminals
      const oversized = critical.filter(a => a.sizeKB > 100);
      if (oversized.length > 0) {
        await log(`[AlertRules] Auto-creating Librarian cleanup task for ${oversized.length} terminals`);
        // TODO: Implement auto-task creation via MCP API
      }
    } else if (warning.length > 0) {
      const terminalList = warning.map(a => `${a.terminal}(${a.sizeKB}KB)`).join(', ');
      message = `🟡 [WARNING] Memory approaching threshold: ${terminalList}`;
    }

    return message;
  } catch (err) {
    await log(`[AlertRules] checkMemoryOverflow error: ${err}`);
  }

  return null;
}

// ─── Main Runner ─────────────────────────────────────────────────────────────

/**
 * Run all alert rules and send Telegram notifications
 */
export async function runAlertRules(): Promise<void> {
  await log('[AlertRules] Checking alert rules');

  const checks = [
    checkSessionStuck(),
    checkConsecutiveSkips(),
    checkBlockedTimeout(),
    checkNoActivity(),
    checkMemoryOverflow(),
  ];

  const results = await Promise.allSettled(checks);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const message = result.value;
      await telegram(message);
      await log(`[AlertRules] Alert fired: ${message}`);
    }
  }
}
