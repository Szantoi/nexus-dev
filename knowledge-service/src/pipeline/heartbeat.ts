/**
 * heartbeat.ts — Hourly Terminal Health Monitoring
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Runs hourly to:
 * - Check health of all terminal sessions
 * - Detect stuck, error, or unresponsive terminals
 * - Send alerts via Telegram if issues found
 * - Log system health metrics
 */

import {
  SESSIONS,
  hasSession,
  hasUnreadInbox,
  getSessionActivity,
  log,
  telegram,
} from './common';
import { detectPaneState, PaneState, stateDescription } from './paneState';

// ─── Types ───────────────────────────────────────────────────────────────────

export type AlertType = 'error' | 'stuck' | 'unread' | 'offline' | 'warning';

export interface Alert {
  terminal: string;
  type: AlertType;
  message: string;
  timestamp: string;
}

export interface TerminalHealth {
  session: string;
  terminal: string;
  exists: boolean;
  state: PaneState;
  stateConfidence: string;
  hasUnreadInbox: boolean;
  idleMinutes: number;
  lastActivity: number;
  healthy: boolean;
  issues: string[];
}

export interface HeartbeatResult {
  timestamp: string;
  durationMs: number;
  terminals: TerminalHealth[];
  alerts: Alert[];
  summary: {
    total: number;
    healthy: number;
    issues: number;
    offline: number;
  };
}

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  alertOnError: boolean;
  alertOnStuck: boolean;
  alertOnUnread: boolean;
  stuckThresholdMinutes: number;
  unreadThresholdMinutes: number;
  sendTelegramAlerts: boolean;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: HeartbeatConfig = {
  enabled: process.env.ENABLE_HEARTBEAT === 'true',
  intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL || '3600000', 10), // 1 hour
  alertOnError: true,
  alertOnStuck: true,
  alertOnUnread: true,
  stuckThresholdMinutes: 30,
  unreadThresholdMinutes: 60,
  sendTelegramAlerts: true,
};

// ─── Health Check Logic ──────────────────────────────────────────────────────

/**
 * Check health of a single terminal session
 */
async function checkTerminalHealth(session: string): Promise<TerminalHealth> {
  const terminal = SESSIONS[session] || session;
  const issues: string[] = [];

  // Check if session exists
  const exists = await hasSession(session);
  if (!exists) {
    return {
      session,
      terminal,
      exists: false,
      state: 'unknown',
      stateConfidence: 'n/a',
      hasUnreadInbox: await hasUnreadInbox(terminal),
      idleMinutes: 0,
      lastActivity: 0,
      healthy: false,
      issues: ['Session not running'],
    };
  }

  // Get pane state
  const paneState = await detectPaneState(session);

  // Get activity timestamp
  const lastActivity = await getSessionActivity(session);
  const now = Math.floor(Date.now() / 1000);
  const idleSeconds = lastActivity > 0 ? now - lastActivity : 0;
  const idleMinutes = Math.floor(idleSeconds / 60);

  // Check inbox
  const unreadInbox = await hasUnreadInbox(terminal);

  // Analyze health
  if (paneState.state === 'error') {
    issues.push(`Error state: ${paneState.details || 'unknown'}`);
  }

  if (paneState.state === 'idle' && unreadInbox && idleMinutes > DEFAULT_CONFIG.stuckThresholdMinutes) {
    issues.push(`Idle with unread inbox for ${idleMinutes} minutes`);
  }

  if (paneState.state === 'unknown' && idleMinutes > 60) {
    issues.push(`Unknown state for ${idleMinutes} minutes`);
  }

  return {
    session,
    terminal,
    exists: true,
    state: paneState.state,
    stateConfidence: paneState.confidence,
    hasUnreadInbox: unreadInbox,
    idleMinutes,
    lastActivity,
    healthy: issues.length === 0,
    issues,
  };
}

/**
 * Generate alerts from terminal health data
 */
function generateAlerts(health: TerminalHealth, config: HeartbeatConfig): Alert[] {
  const alerts: Alert[] = [];
  const timestamp = new Date().toISOString();

  // Session offline
  if (!health.exists) {
    if (health.hasUnreadInbox) {
      alerts.push({
        terminal: health.terminal,
        type: 'offline',
        message: `Session offline with unread inbox`,
        timestamp,
      });
    }
    return alerts;
  }

  // Error state
  if (config.alertOnError && health.state === 'error') {
    alerts.push({
      terminal: health.terminal,
      type: 'error',
      message: health.issues.find((i) => i.includes('Error')) || 'Error state detected',
      timestamp,
    });
  }

  // Stuck (idle with unread inbox)
  if (
    config.alertOnStuck &&
    health.state === 'idle' &&
    health.hasUnreadInbox &&
    health.idleMinutes > config.stuckThresholdMinutes
  ) {
    alerts.push({
      terminal: health.terminal,
      type: 'stuck',
      message: `Idle with unread inbox for ${health.idleMinutes}min`,
      timestamp,
    });
  }

  // Unread inbox without activity
  if (
    config.alertOnUnread &&
    health.hasUnreadInbox &&
    !health.exists
  ) {
    alerts.push({
      terminal: health.terminal,
      type: 'unread',
      message: `Unread inbox but session not running`,
      timestamp,
    });
  }

  return alerts;
}

// ─── Main Functions ──────────────────────────────────────────────────────────

/**
 * Run a full heartbeat check on all terminals
 */
export async function runHeartbeat(
  config: HeartbeatConfig = DEFAULT_CONFIG
): Promise<HeartbeatResult> {
  const startTime = Date.now();
  const terminals: TerminalHealth[] = [];
  const allAlerts: Alert[] = [];

  // Check all registered sessions
  for (const session of Object.keys(SESSIONS)) {
    const health = await checkTerminalHealth(session);
    terminals.push(health);

    const alerts = generateAlerts(health, config);
    allAlerts.push(...alerts);
  }

  // Calculate summary
  const summary = {
    total: terminals.length,
    healthy: terminals.filter((t) => t.healthy).length,
    issues: terminals.filter((t) => !t.healthy && t.exists).length,
    offline: terminals.filter((t) => !t.exists).length,
  };

  // Send alerts
  if (config.sendTelegramAlerts && allAlerts.length > 0) {
    await sendHeartbeatAlerts(allAlerts);
  }

  // Log results
  const durationMs = Date.now() - startTime;
  await log(
    `[Heartbeat] ${summary.healthy}/${summary.total} healthy, ` +
      `${summary.issues} issues, ${summary.offline} offline (${durationMs}ms)`
  );

  return {
    timestamp: new Date().toISOString(),
    durationMs,
    terminals,
    alerts: allAlerts,
    summary,
  };
}

/**
 * Send alerts via Telegram
 */
async function sendHeartbeatAlerts(alerts: Alert[]): Promise<void> {
  if (alerts.length === 0) return;

  // Group alerts by type
  const byType: Record<AlertType, Alert[]> = {
    error: [],
    stuck: [],
    unread: [],
    offline: [],
    warning: [],
  };

  for (const alert of alerts) {
    byType[alert.type].push(alert);
  }

  // Build message
  const lines: string[] = ['💓 *Heartbeat Alert*'];

  if (byType.error.length > 0) {
    lines.push(`🔴 Errors: ${byType.error.map((a) => a.terminal).join(', ')}`);
  }
  if (byType.stuck.length > 0) {
    lines.push(`🟠 Stuck: ${byType.stuck.map((a) => a.terminal).join(', ')}`);
  }
  if (byType.offline.length > 0) {
    lines.push(`⚫ Offline: ${byType.offline.map((a) => a.terminal).join(', ')}`);
  }
  if (byType.unread.length > 0) {
    lines.push(`📬 Unread: ${byType.unread.map((a) => a.terminal).join(', ')}`);
  }

  // Add details
  for (const alert of alerts.slice(0, 5)) {
    lines.push(`  • ${alert.terminal}: ${alert.message}`);
  }

  if (alerts.length > 5) {
    lines.push(`  ... and ${alerts.length - 5} more`);
  }

  await telegram(lines.join('\n'));
}

/**
 * Get a quick status summary (for API endpoints)
 */
export async function getQuickStatus(): Promise<{
  healthy: number;
  total: number;
  issues: string[];
}> {
  const issues: string[] = [];
  let healthy = 0;
  let total = 0;

  for (const session of Object.keys(SESSIONS)) {
    total++;
    const health = await checkTerminalHealth(session);
    if (health.healthy) {
      healthy++;
    } else {
      issues.push(`${health.terminal}: ${health.issues.join(', ')}`);
    }
  }

  return { healthy, total, issues };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the heartbeat scheduler
 */
export function startHeartbeatScheduler(config: HeartbeatConfig = DEFAULT_CONFIG): void {
  if (!config.enabled) {
    console.log('[Heartbeat] Scheduler disabled');
    return;
  }

  // Run immediately
  runHeartbeat(config).catch((err) => {
    console.error('[Heartbeat] Initial run error:', err);
  });

  // Then run on interval
  heartbeatInterval = setInterval(async () => {
    try {
      await runHeartbeat(config);
    } catch (error) {
      console.error('[Heartbeat] Scheduler error:', error);
    }
  }, config.intervalMs);

  console.log(`[Heartbeat] Scheduler started (every ${config.intervalMs / 60000}min)`);
}

/**
 * Stop the heartbeat scheduler
 */
export function stopHeartbeatScheduler(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[Heartbeat] Scheduler stopped');
  }
}

/**
 * Get the default config (for external use)
 */
export function getHeartbeatConfig(): HeartbeatConfig {
  return { ...DEFAULT_CONFIG };
}
