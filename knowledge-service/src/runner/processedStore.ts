/**
 * processedStore.ts — Persisted launch-attempt state for the runner.
 *
 * Prevents double-launching a task: a message stays UNREAD on the server
 * until the agent acks it via MCP, so the poll keeps returning it. The
 * store remembers which message IDs were already launched, how many times,
 * and when — so a crashed session gets a bounded number of retries after
 * a cooldown instead of an infinite launch loop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../core/logger';

export interface ProcessedEntry {
  terminal: string;
  attempts: number;
  lastLaunchAt: string; // ISO timestamp
  /** Existing unread work captured before this runner became launch authority. */
  disposition?: 'launch' | 'quarantine';
}

const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export class ProcessedStore {
  private entries: Record<string, ProcessedEntry> = {};

  constructor(private readonly filePath: string) {}

  load(): 'loaded' | 'missing' | 'corrupt' {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.entries = {};
        return 'corrupt';
      }
      this.entries = parsed;
      return 'loaded';
    } catch (error) {
      this.entries = {};
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt';
    }
  }

  /**
   * Never throws: the in-memory state stays authoritative for this run,
   * so a failed persist only risks a bounded re-launch after a restart.
   */
  save(now: Date = new Date()): void {
    for (const [id, entry] of Object.entries(this.entries)) {
      if (
        entry.disposition !== 'quarantine' &&
        now.getTime() - new Date(entry.lastLaunchAt).getTime() > PRUNE_AFTER_MS
      ) {
        delete this.entries[id];
      }
    }
    const json = JSON.stringify(this.entries, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, json, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Windows can EPERM a rename over a transiently locked file —
      // fall back to a direct (non-atomic) write before giving up.
      try {
        fs.writeFileSync(this.filePath, json, 'utf-8');
      } catch (err) {
        logger.warn(
          `[Runner] State persist failed (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  get(messageId: string): ProcessedEntry | undefined {
    return this.entries[messageId];
  }

  /**
   * A task may launch if it was never launched, or if it is still pending
   * after a cooldown and has attempts left.
   */
  shouldLaunch(
    messageId: string,
    opts: { maxAttempts: number; retryCooldownMs: number; now?: Date },
  ): boolean {
    const entry = this.entries[messageId];
    if (!entry) return true;
    if (entry.disposition === 'quarantine') return false;
    if (entry.attempts >= opts.maxAttempts) return false;
    const now = opts.now ?? new Date();
    const elapsed = now.getTime() - new Date(entry.lastLaunchAt).getTime();
    return elapsed >= opts.retryCooldownMs;
  }

  recordLaunch(messageId: string, terminal: string, now: Date = new Date()): void {
    const prev = this.entries[messageId];
    this.entries[messageId] = {
      terminal,
      attempts: (prev?.attempts ?? 0) + 1,
      lastLaunchAt: now.toISOString(),
      disposition: 'launch',
    };
  }

  /** Permanently excludes unread work that predates first safe startup. */
  recordQuarantine(messageId: string, terminal: string, now: Date = new Date()): void {
    this.entries[messageId] = {
      terminal,
      attempts: 0,
      lastLaunchAt: now.toISOString(),
      disposition: 'quarantine',
    };
  }
}
