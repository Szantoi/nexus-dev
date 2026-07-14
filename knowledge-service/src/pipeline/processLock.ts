/**
 * processLock.ts — Process lock management for SpaceOS
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Prevents duplicate session starts and ensures single-instance operations.
 * Uses file-based locks with PID tracking for crash recovery.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { log as pipelineLog } from './common';

// Wrapper for log with prefix
const log = (prefix: string, message: string) => pipelineLog(`[${prefix}] ${message}`);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LockInfo {
  pid: number;
  startedAt: string;
  terminal?: string;
  operation?: string;
}

export interface LockResult {
  acquired: boolean;
  holder?: LockInfo;
  reason?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LOCK_DIR = '/tmp/spaceos-locks';
const STALE_LOCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// ─── Lock File Operations ────────────────────────────────────────────────────

function getLockPath(name: string): string {
  // Sanitize name to prevent path traversal
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LOCK_DIR, `${safeName}.lock`);
}

async function ensureLockDir(): Promise<void> {
  try {
    await fs.mkdir(LOCK_DIR, { recursive: true, mode: 0o755 });
  } catch (err) {
    // Directory might already exist
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockFile(lockPath: string): Promise<LockInfo | null> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    return JSON.parse(content) as LockInfo;
  } catch {
    return null;
  }
}

async function writeLockFile(lockPath: string, info: LockInfo): Promise<void> {
  await fs.writeFile(lockPath, JSON.stringify(info, null, 2), { mode: 0o644 });
}

async function removeLockFile(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch {
    // File might not exist
  }
}

// ─── Stale Lock Detection ────────────────────────────────────────────────────

async function isLockStale(lockInfo: LockInfo): Promise<boolean> {
  // Check if the process is still alive
  if (!isProcessAlive(lockInfo.pid)) {
    log('processLock', `Lock holder PID ${lockInfo.pid} is dead`);
    return true;
  }

  // Check if the lock is too old
  const lockAge = Date.now() - new Date(lockInfo.startedAt).getTime();
  if (lockAge > STALE_LOCK_THRESHOLD_MS) {
    log('processLock', `Lock is stale (${Math.round(lockAge / 1000)}s old)`);
    return true;
  }

  return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Acquire a named lock
 *
 * @param name - Unique lock identifier (e.g., 'session-backend', 'inbox-watcher')
 * @param options - Optional lock metadata
 * @returns LockResult with acquisition status
 */
export async function acquireLock(
  name: string,
  options?: { terminal?: string; operation?: string }
): Promise<LockResult> {
  await ensureLockDir();
  const lockPath = getLockPath(name);

  // Check for existing lock
  const existingLock = await readLockFile(lockPath);

  if (existingLock) {
    // Check if the existing lock is stale
    if (await isLockStale(existingLock)) {
      log('processLock', `Removing stale lock: ${name}`);
      await removeLockFile(lockPath);
    } else {
      // Lock is held by another active process
      return {
        acquired: false,
        holder: existingLock,
        reason: `Lock held by PID ${existingLock.pid} since ${existingLock.startedAt}`,
      };
    }
  }

  // Create new lock
  const lockInfo: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    terminal: options?.terminal,
    operation: options?.operation,
  };

  try {
    await writeLockFile(lockPath, lockInfo);
    log('processLock', `Acquired lock: ${name} (PID ${process.pid})`);
    return { acquired: true };
  } catch (err) {
    return {
      acquired: false,
      reason: `Failed to write lock file: ${err}`,
    };
  }
}

/**
 * Release a named lock
 *
 * @param name - Lock identifier to release
 * @param force - Force release even if not owned by current process
 */
export async function releaseLock(name: string, force = false): Promise<void> {
  const lockPath = getLockPath(name);
  const existingLock = await readLockFile(lockPath);

  if (!existingLock) {
    return; // Already released
  }

  // Only release if we own the lock (or force)
  if (existingLock.pid === process.pid || force) {
    await removeLockFile(lockPath);
    log('processLock', `Released lock: ${name}`);
  } else {
    log('processLock', `Cannot release lock ${name} owned by PID ${existingLock.pid}`);
  }
}

/**
 * Check if a lock is currently held
 */
export function isLocked(name: string): boolean {
  const lockPath = getLockPath(name);
  return existsSync(lockPath);
}

/**
 * Get information about a lock holder
 */
export async function getLockHolder(name: string): Promise<LockInfo | null> {
  const lockPath = getLockPath(name);
  return readLockFile(lockPath);
}

/**
 * List all active locks
 */
export async function listLocks(): Promise<Array<{ name: string; info: LockInfo }>> {
  await ensureLockDir();
  const locks: Array<{ name: string; info: LockInfo }> = [];

  try {
    const files = await fs.readdir(LOCK_DIR);

    for (const file of files) {
      if (!file.endsWith('.lock')) continue;

      const name = file.replace('.lock', '');
      const info = await readLockFile(path.join(LOCK_DIR, file));

      if (info) {
        locks.push({ name, info });
      }
    }
  } catch {
    // Directory might not exist
  }

  return locks;
}

/**
 * Clean up stale locks
 *
 * @returns Number of stale locks removed
 */
export async function cleanupStaleLocks(): Promise<number> {
  const locks = await listLocks();
  let cleaned = 0;

  for (const { name, info } of locks) {
    if (await isLockStale(info)) {
      await releaseLock(name, true);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log('processLock', `Cleaned up ${cleaned} stale lock(s)`);
  }

  return cleaned;
}

// ─── Convenience Functions ───────────────────────────────────────────────────

/**
 * Execute a function with a lock
 *
 * @param name - Lock name
 * @param fn - Function to execute while holding the lock
 * @param options - Lock options
 * @returns Function result or null if lock couldn't be acquired
 */
export async function withLock<T>(
  name: string,
  fn: () => Promise<T>,
  options?: { terminal?: string; operation?: string }
): Promise<{ success: true; result: T } | { success: false; reason: string }> {
  const lockResult = await acquireLock(name, options);

  if (!lockResult.acquired) {
    return { success: false, reason: lockResult.reason || 'Failed to acquire lock' };
  }

  try {
    const result = await fn();
    return { success: true, result };
  } finally {
    await releaseLock(name);
  }
}

/**
 * Terminal-specific session lock
 */
export function getSessionLockName(terminal: string): string {
  return `session-${terminal}`;
}

/**
 * Acquire a terminal session lock
 */
export async function acquireSessionLock(terminal: string): Promise<LockResult> {
  return acquireLock(getSessionLockName(terminal), {
    terminal,
    operation: 'session',
  });
}

/**
 * Release a terminal session lock
 */
export async function releaseSessionLock(terminal: string): Promise<void> {
  return releaseLock(getSessionLockName(terminal));
}
