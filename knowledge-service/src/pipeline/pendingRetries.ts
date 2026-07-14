/**
 * pendingRetries.ts — Retry queue for failed operations
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Manages a queue of failed operations that should be retried.
 * Uses JSON file storage (not SQLite) to maintain git audit trail compatibility.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { log as pipelineLog } from './common';

// Wrapper for log with prefix
const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);
import { acquireLock, releaseLock } from './processLock';

// ─── Types ───────────────────────────────────────────────────────────────────

export type OperationType =
  | 'session_start'
  | 'message_send'
  | 'inbox_write'
  | 'outbox_write'
  | 'telegram_send'
  | 'slack_send'
  | 'knowledge_index'
  | 'reviewer_run';

export interface RetryEntry {
  id: string;
  operation: OperationType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  lastAttemptAt?: string;
  nextRetryAt: string;
  createdAt: string;
  terminal?: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export interface RetryQueueStats {
  total: number;
  pending: number;
  failed: number;
  byOperation: Record<string, number>;
  byPriority: Record<string, number>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const QUEUE_DIR = process.env.DATA_DIR || `${SPACEOS_ROOT}/spaceos-nexus/knowledge-service/data`;
const QUEUE_FILE = 'pending-retries.json';
const QUEUE_PATH = path.join(QUEUE_DIR, QUEUE_FILE);
const LOCK_NAME = 'pending-retries';

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS: Record<number, number> = {
  1: 30 * 1000,      // 30 seconds after 1st failure
  2: 2 * 60 * 1000,  // 2 minutes after 2nd failure
  3: 10 * 60 * 1000, // 10 minutes after 3rd failure
  4: 30 * 60 * 1000, // 30 minutes after 4th failure
  5: 60 * 60 * 1000, // 1 hour after 5th failure
};

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ─── Queue Storage ───────────────────────────────────────────────────────────

async function ensureQueueDir(): Promise<void> {
  if (!existsSync(QUEUE_DIR)) {
    await fs.mkdir(QUEUE_DIR, { recursive: true });
  }
}

async function readQueue(): Promise<RetryEntry[]> {
  try {
    const content = await fs.readFile(QUEUE_PATH, 'utf-8');
    return JSON.parse(content) as RetryEntry[];
  } catch {
    return [];
  }
}

async function writeQueue(entries: RetryEntry[]): Promise<void> {
  await ensureQueueDir();
  await fs.writeFile(QUEUE_PATH, JSON.stringify(entries, null, 2));
}

function generateId(): string {
  return `retry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function calculateNextRetry(attempts: number): string {
  const delayMs = RETRY_DELAYS_MS[attempts] || RETRY_DELAYS_MS[5];
  return new Date(Date.now() + delayMs).toISOString();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Add a failed operation to the retry queue
 */
export async function addRetry(entry: {
  operation: OperationType;
  payload: Record<string, unknown>;
  error: string;
  terminal?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  maxAttempts?: number;
}): Promise<string> {
  const lockResult = await acquireLock(LOCK_NAME);
  if (!lockResult.acquired) {
    throw new Error(`Cannot acquire queue lock: ${lockResult.reason}`);
  }

  try {
    const queue = await readQueue();

    const newEntry: RetryEntry = {
      id: generateId(),
      operation: entry.operation,
      payload: entry.payload,
      attempts: 1,
      maxAttempts: entry.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      lastError: entry.error,
      lastAttemptAt: new Date().toISOString(),
      nextRetryAt: calculateNextRetry(1),
      createdAt: new Date().toISOString(),
      terminal: entry.terminal,
      priority: entry.priority || 'medium',
    };

    queue.push(newEntry);
    await writeQueue(queue);

    log('pendingRetries', `Added retry: ${newEntry.id} (${entry.operation})`);
    return newEntry.id;
  } finally {
    await releaseLock(LOCK_NAME);
  }
}

/**
 * Get the next entry ready for retry
 *
 * Returns entries sorted by priority and nextRetryAt
 */
export async function getNextRetry(): Promise<RetryEntry | null> {
  const lockResult = await acquireLock(LOCK_NAME);
  if (!lockResult.acquired) {
    return null;
  }

  try {
    const queue = await readQueue();
    const now = new Date().toISOString();

    // Filter entries that are ready for retry and haven't exceeded max attempts
    const ready = queue
      .filter(e => e.nextRetryAt <= now && e.attempts < e.maxAttempts)
      .sort((a, b) => {
        // Sort by priority first
        const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        // Then by nextRetryAt
        return a.nextRetryAt.localeCompare(b.nextRetryAt);
      });

    return ready[0] || null;
  } finally {
    await releaseLock(LOCK_NAME);
  }
}

/**
 * Get all pending retries
 */
export async function getAllRetries(): Promise<RetryEntry[]> {
  return readQueue();
}

/**
 * Mark a retry as successful (remove from queue)
 */
export async function markSuccess(id: string): Promise<void> {
  const lockResult = await acquireLock(LOCK_NAME);
  if (!lockResult.acquired) {
    throw new Error(`Cannot acquire queue lock: ${lockResult.reason}`);
  }

  try {
    const queue = await readQueue();
    const filtered = queue.filter(e => e.id !== id);

    if (filtered.length < queue.length) {
      await writeQueue(filtered);
      log('pendingRetries', `Marked success: ${id}`);
    }
  } finally {
    await releaseLock(LOCK_NAME);
  }
}

/**
 * Mark a retry as failed (increment attempts, update nextRetryAt)
 */
export async function markRetryFailed(id: string, error: string): Promise<boolean> {
  const lockResult = await acquireLock(LOCK_NAME);
  if (!lockResult.acquired) {
    throw new Error(`Cannot acquire queue lock: ${lockResult.reason}`);
  }

  try {
    const queue = await readQueue();
    const entry = queue.find(e => e.id === id);

    if (!entry) {
      return false;
    }

    entry.attempts++;
    entry.lastError = error;
    entry.lastAttemptAt = new Date().toISOString();

    if (entry.attempts >= entry.maxAttempts) {
      log('pendingRetries', `Max attempts reached for ${id}, keeping in queue as failed`);
      // Keep in queue but don't set nextRetryAt (won't be picked up)
    } else {
      entry.nextRetryAt = calculateNextRetry(entry.attempts);
      log('pendingRetries', `Marked failed: ${id} (attempt ${entry.attempts}/${entry.maxAttempts})`);
    }

    await writeQueue(queue);
    return entry.attempts < entry.maxAttempts;
  } finally {
    await releaseLock(LOCK_NAME);
  }
}

/**
 * Remove old failed entries from the queue
 */
export async function cleanup(olderThanDays: number = 7): Promise<number> {
  const lockResult = await acquireLock(LOCK_NAME);
  if (!lockResult.acquired) {
    return 0;
  }

  try {
    const queue = await readQueue();
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

    const filtered = queue.filter(e => {
      // Keep if created recently
      if (e.createdAt > cutoff) return true;
      // Keep if still has retries available
      if (e.attempts < e.maxAttempts) return true;
      // Remove old failed entries
      return false;
    });

    const removed = queue.length - filtered.length;
    if (removed > 0) {
      await writeQueue(filtered);
      log('pendingRetries', `Cleaned up ${removed} old entries`);
    }

    return removed;
  } finally {
    await releaseLock(LOCK_NAME);
  }
}

/**
 * Get queue statistics
 */
export async function getStats(): Promise<RetryQueueStats> {
  const queue = await readQueue();
  const now = new Date().toISOString();

  const stats: RetryQueueStats = {
    total: queue.length,
    pending: 0,
    failed: 0,
    byOperation: {},
    byPriority: {},
  };

  for (const entry of queue) {
    // Count by operation
    stats.byOperation[entry.operation] = (stats.byOperation[entry.operation] || 0) + 1;

    // Count by priority
    stats.byPriority[entry.priority] = (stats.byPriority[entry.priority] || 0) + 1;

    // Count pending vs failed
    if (entry.attempts >= entry.maxAttempts) {
      stats.failed++;
    } else {
      stats.pending++;
    }
  }

  return stats;
}

/**
 * Process the next retry entry
 *
 * @param handler - Function to execute the retry
 * @returns Result of the retry operation
 */
export async function processNextRetry(
  handler: (entry: RetryEntry) => Promise<void>
): Promise<{ processed: boolean; entry?: RetryEntry; error?: string }> {
  const entry = await getNextRetry();

  if (!entry) {
    return { processed: false };
  }

  try {
    await handler(entry);
    await markSuccess(entry.id);
    return { processed: true, entry };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const hasMoreRetries = await markRetryFailed(entry.id, error);
    return { processed: true, entry, error: hasMoreRetries ? undefined : `Max retries exceeded: ${error}` };
  }
}

/**
 * Run the retry processor loop
 *
 * @param handler - Function to execute each retry
 * @param intervalMs - Interval between checks (default: 30 seconds)
 */
export function startRetryProcessor(
  handler: (entry: RetryEntry) => Promise<void>,
  intervalMs: number = 30000
): { stop: () => void } {
  let running = true;

  const process = async () => {
    while (running) {
      try {
        const result = await processNextRetry(handler);

        if (result.processed && result.entry) {
          log('pendingRetries', `Processed: ${result.entry.id} (${result.entry.operation})`);
          if (result.error) {
            log('pendingRetries', `Final failure: ${result.error}`);
          }
        }
      } catch (err) {
        log('pendingRetries', `Processor error: ${err}`);
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  };

  // Start processing
  process();

  return {
    stop: () => {
      running = false;
    },
  };
}
