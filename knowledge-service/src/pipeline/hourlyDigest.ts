/**
 * hourlyDigest.ts — Hourly Digest for Autonomous Development
 *
 * Sends an hourly summary of SpaceOS autonomous dev activity to Telegram.
 *
 * Schedule: Every hour at :00 minutes
 * Format: Emoji-rich summary with metrics
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { SPACEOS_ROOT, telegram, log } from './common';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DigestData {
  timestamp: Date;
  autonomousCycles: { total: number; skipped: number };
  tasksCompleted: number;
  tasksInProgress: number;
  blockers: number;
  terminals: Record<string, string>;
  nextCycle: Date;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:3456';

// ─── Data Collection ─────────────────────────────────────────────────────────

/**
 * Collect digest data from various sources
 */
export async function collectDigestData(): Promise<DigestData> {
  const timestamp = new Date();
  const nextCycle = new Date(timestamp.getTime() + 60 * 60 * 1000); // +1 hour

  // Default values
  let autonomousCycles = { total: 0, skipped: 0 };
  let tasksCompleted = 0;
  let tasksInProgress = 0;
  let blockers = 0;
  const terminals: Record<string, string> = {};

  try {
    // 1. Autonomous dev status
    const autonomousResponse = await fetch(`${API_BASE}/api/autonomous/status`, {
      signal: AbortSignal.timeout(5000),
    });
    const autonomousData = await autonomousResponse.json() as {
      enabled: boolean;
      cycleCount?: number;
      running?: boolean;
    };

    if (autonomousData.enabled && autonomousData.cycleCount) {
      autonomousCycles.total = autonomousData.cycleCount;

      // Parse recent log for skipped cycles
      try {
        const logFile = path.join(SPACEOS_ROOT, 'logs/dispatcher/nightwatch.log');
        const logContent = await fs.readFile(logFile, 'utf-8');
        const lines = logContent.split('\n').filter(l => l.includes('[AutonomousDev]')).slice(-10);
        const skipped = lines.filter(l => l.includes('skipped')).length;
        autonomousCycles.skipped = skipped;
      } catch {
        // Log file not available
      }
    }
  } catch (err) {
    await log(`[HourlyDigest] Error fetching autonomous status: ${err}`);
  }

  try {
    // 2. Dashboard data (terminal statuses)
    const dashboardResponse = await fetch(`${API_BASE}/api/dashboard`, {
      signal: AbortSignal.timeout(5000),
    });
    const dashboardData = await dashboardResponse.json() as {
      terminals: Array<{
        name: string;
        status: string;
        unreadInbox: number;
        unreadOutbox: number;
      }>;
    };

    // Count tasks in progress (UNREAD inbox)
    tasksInProgress = dashboardData.terminals.reduce((sum, t) => sum + t.unreadInbox, 0);

    // Count blockers (UNREAD outbox with type: blocked)
    for (const terminal of dashboardData.terminals) {
      if (terminal.unreadOutbox > 0) {
        // Scan outbox for BLOCKED messages
        const outboxPath = path.join(SPACEOS_ROOT, 'terminals', terminal.name, 'outbox');
        try {
          const files = await fs.readdir(outboxPath);
          for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const content = await fs.readFile(path.join(outboxPath, file), 'utf-8');
            if (content.includes('type: blocked') && content.includes('status: UNREAD')) {
              blockers++;
            }
          }
        } catch {
          // Outbox not accessible
        }
      }

      // Terminal summary
      if (terminal.status === 'working') {
        terminals[terminal.name] = `⚙️ working`;
      } else if (terminal.unreadInbox > 0) {
        terminals[terminal.name] = `📥 ${terminal.unreadInbox} inbox`;
      } else {
        terminals[terminal.name] = `💤 idle`;
      }
    }
  } catch (err) {
    await log(`[HourlyDigest] Error fetching dashboard data: ${err}`);
  }

  try {
    // 3. Count completed tasks (DONE messages in last hour)
    const oneHourAgo = timestamp.getTime() - 60 * 60 * 1000;
    const terminalsDir = path.join(SPACEOS_ROOT, 'terminals');
    const terminalNames = await fs.readdir(terminalsDir);

    for (const terminal of terminalNames) {
      const outboxPath = path.join(terminalsDir, terminal, 'outbox');
      try {
        const files = await fs.readdir(outboxPath);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(outboxPath, file);
          const stats = await fs.stat(filePath);
          if (stats.mtime.getTime() >= oneHourAgo) {
            const content = await fs.readFile(filePath, 'utf-8');
            if (content.includes('type: done')) {
              tasksCompleted++;
            }
          }
        }
      } catch {
        // Outbox not accessible
      }
    }
  } catch (err) {
    await log(`[HourlyDigest] Error counting completed tasks: ${err}`);
  }

  return {
    timestamp,
    autonomousCycles,
    tasksCompleted,
    tasksInProgress,
    blockers,
    terminals,
    nextCycle,
  };
}

/**
 * Format digest message for Telegram
 */
export function formatDigestMessage(data: DigestData): string {
  const hour = data.timestamp.getHours().toString().padStart(2, '0');
  const nextHour = data.nextCycle.getHours().toString().padStart(2, '0');

  const lines: string[] = [
    `📊 SpaceOS Hourly Digest (${hour}:00)`,
    '━━━━━━━━━━━━━━━━━━━━━━━',
    `🤖 Autonomous cycles: ${data.autonomousCycles.total} (${data.autonomousCycles.skipped} skipped)`,
    `✅ Tasks completed: ${data.tasksCompleted}`,
    `⏳ Tasks in progress: ${data.tasksInProgress}`,
    `🚨 Blockers: ${data.blockers}`,
    '',
    'Terminals:',
  ];

  // Sort terminals: working first, then inbox, then idle
  const sortedTerminals = Object.entries(data.terminals).sort(([, a], [, b]) => {
    if (a.includes('working')) return -1;
    if (b.includes('working')) return 1;
    if (a.includes('inbox')) return -1;
    if (b.includes('inbox')) return 1;
    return 0;
  });

  for (const [terminal, status] of sortedTerminals) {
    lines.push(`• ${terminal}: ${status}`);
  }

  lines.push('');
  lines.push(`Next cycle: ${nextHour}:00`);

  return lines.join('\n');
}

/**
 * Send hourly digest to Telegram
 */
export async function sendHourlyDigest(): Promise<void> {
  try {
    await log('[HourlyDigest] Generating hourly digest');

    const data = await collectDigestData();
    const message = formatDigestMessage(data);

    await telegram(message);
    await log('[HourlyDigest] Digest sent successfully');
  } catch (err) {
    await log(`[HourlyDigest] Error sending digest: ${err}`);
    // Don't throw - scheduler should continue
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let intervalId: NodeJS.Timeout | null = null;

/**
 * Start the hourly digest scheduler
 * Runs at the top of every hour (:00 minutes)
 */
export function startHourlyDigestScheduler(): void {
  if (intervalId) {
    console.log('[HourlyDigest] Scheduler already running');
    return;
  }

  // Calculate time until next hour
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

  console.log(`[HourlyDigest] Scheduler starting - next digest in ${Math.floor(msUntilNextHour / 1000 / 60)} minutes`);

  // Schedule first run at next hour
  setTimeout(() => {
    sendHourlyDigest();

    // Then run every hour
    intervalId = setInterval(sendHourlyDigest, 60 * 60 * 1000);
  }, msUntilNextHour);
}

/**
 * Stop the hourly digest scheduler
 */
export function stopHourlyDigestScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[HourlyDigest] Scheduler stopped');
  }
}

/**
 * Get scheduler status
 */
export function getHourlyDigestStatus(): { running: boolean; nextRun: Date | null } {
  const running = intervalId !== null;
  let nextRun: Date | null = null;

  if (running) {
    const now = new Date();
    nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  }

  return { running, nextRun };
}

// Run standalone for testing
if (require.main === module) {
  console.log('Running hourly digest test...');
  sendHourlyDigest().then(() => {
    console.log('Digest sent successfully');
    process.exit(0);
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
