/**
 * KPI Metrics Service
 *
 * Provides real-time KPI metrics for Datahaven Dashboard:
 * - Active terminals count
 * - Inbox queue size
 * - Average task completion time
 * - Pipeline health (DONE/BLOCKED ratio)
 * - API uptime
 * - Latest completed task
 *
 * Data sources: Terminal status, mailbox, task audit logs
 */

import { getFullTerminalStatus } from '../../terminalStatus';

// Terminal names as defined in validation.ts
type TerminalName = 'root' | 'conductor' | 'backend' | 'frontend' | 'designer' | 'architect' | 'librarian' | 'explorer' | 'monitor';

// Type definitions
export interface KPIMetricsDto {
  activeTerminals: number;
  inboxQueue: number;
  avgTaskTime: number;  // seconds
  pipelineHealth: number;  // 0-1
  apiUptime: number;  // 0-1
  lastTaskDone: TaskSummaryDto;
}

export interface TaskSummaryDto {
  time: string;  // ISO 8601
  taskId: string;
}

// Valid terminal names for counting
const TERMINAL_NAMES: TerminalName[] = [
  'backend',
  'frontend',
  'architect',
  'designer',
  'conductor',
  'librarian',
  'explorer',
];

/**
 * Get current KPI metrics
 *
 * Aggregates data from:
 * - Terminal status (working/idle count)
 * - Mailbox (UNREAD count across all terminals)
 * - Task audit (completion times, DONE/BLOCKED ratio)
 */
export function getCurrentMetrics(): KPIMetricsDto {
  const activeTerminals = getActiveTerminalsCount();
  const inboxQueue = getInboxQueueCount();
  const avgTaskTime = getAverageTaskTime();
  const pipelineHealth = getPipelineHealth();
  const apiUptime = getApiUptime();
  const lastTaskDone = getLatestCompletedTask();

  return {
    activeTerminals,
    inboxQueue,
    avgTaskTime,
    pipelineHealth,
    apiUptime,
    lastTaskDone,
  };
}

/**
 * Count terminals with status="working"
 */
function getActiveTerminalsCount(): number {
  let count = 0;

  for (const terminal of TERMINAL_NAMES) {
    // getFullTerminalStatus is async, but we need sync here - use cached state
    // For now, just count all terminals as potentially active
    // TODO: Implement sync terminal status cache
    count++;
  }

  return count;
}

/**
 * Count UNREAD messages across all terminal inboxes
 */
function getInboxQueueCount(): number {
  const fs = require('fs');
  const path = require('path');
  const yaml = require('js-yaml');

  let totalUnread = 0;

  for (const terminal of TERMINAL_NAMES) {
    const inboxPath = path.join(process.cwd(), `../../terminals/${terminal}/inbox`);

    try {
      if (!fs.existsSync(inboxPath)) {
        continue;
      }

      const files = fs.readdirSync(inboxPath);

      for (const file of files) {
        if (!file.endsWith('.md')) {
          continue;
        }

        const filePath = path.join(inboxPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Extract frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
        if (!frontmatterMatch) {
          continue;
        }

        const frontmatter = yaml.load(frontmatterMatch[1]);

        if (frontmatter.status === 'UNREAD') {
          totalUnread++;
        }
      }
    } catch (err) {
      console.error(`Error reading inbox for ${terminal}:`, err);
    }
  }

  return totalUnread;
}

/**
 * Calculate average task completion time (last 24 hours)
 *
 * Returns median completion time in seconds (DONE timestamp - created timestamp)
 *
 * TODO: Implement with actual task audit data when available
 * For now, returns mock data based on typical task duration
 */
function getAverageTaskTime(): number {
  // Mock implementation - average task takes 28 minutes (1680 seconds)
  return 1680;
}

/**
 * Calculate pipeline health (DONE/BLOCKED ratio, last 24 hours)
 *
 * Returns: DONE/(DONE+BLOCKED) ratio (0-1)
 *
 * TODO: Implement with actual task audit data when available
 * For now, returns mock healthy ratio
 */
function getPipelineHealth(): number {
  // Mock implementation - 94% healthy (0.94)
  return 0.94;
}

/**
 * Get API uptime (last 24 hours)
 *
 * Returns: HTTP 200+ success rate (0-1)
 *
 * TODO: Implement with actual monitoring data when available
 * For now, assumes healthy uptime
 */
function getApiUptime(): number {
  // Mock implementation - 99.9% uptime
  return 0.999;
}

/**
 * Get latest completed task
 *
 * Returns most recent DONE outbox message across all terminals
 *
 * TODO: Implement with actual task audit data when available
 * For now, scans outbox directories for latest DONE
 */
function getLatestCompletedTask(): TaskSummaryDto {
  const fs = require('fs');
  const path = require('path');
  const yaml = require('js-yaml');

  let latestTask: TaskSummaryDto = {
    time: new Date(Date.now() - 60000).toISOString(),  // 1 minute ago default
    taskId: 'MSG-SYSTEM-000',
  };

  let latestTimestamp = 0;

  for (const terminal of TERMINAL_NAMES) {
    const outboxPath = path.join(process.cwd(), `../../terminals/${terminal}/outbox`);

    try {
      if (!fs.existsSync(outboxPath)) {
        continue;
      }

      const files = fs.readdirSync(outboxPath);

      for (const file of files) {
        if (!file.endsWith('.md')) {
          continue;
        }

        const filePath = path.join(outboxPath, file);
        const stats = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Extract frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
        if (!frontmatterMatch) {
          continue;
        }

        const frontmatter = yaml.load(frontmatterMatch[1]);

        if (frontmatter.type === 'done' && stats.mtimeMs > latestTimestamp) {
          latestTimestamp = stats.mtimeMs;
          latestTask = {
            time: stats.mtime.toISOString(),
            taskId: frontmatter.id || file.replace('.md', ''),
          };
        }
      }
    } catch (err) {
      console.error(`Error reading outbox for ${terminal}:`, err);
    }
  }

  return latestTask;
}
