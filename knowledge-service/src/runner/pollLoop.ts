/**
 * pollLoop.ts — The runner's heartbeat: poll each whitelisted terminal's
 * inbox for UNREAD tasks and launch a local session for new ones.
 *
 * Dependencies are injected so the decision logic is unit-testable
 * without a server or child processes. Connection failures back off
 * exponentially (capped) instead of hammering an unreachable server.
 */

import { logger } from '../core/logger';
import type { ProcessedStore } from './processedStore';
import type { RunnerConfig } from './runnerConfig';
import type { LaunchRequest, LaunchResult } from './sessionLauncher';
import type { UnreadTask } from './serverClient';

export interface PollDeps {
  fetchUnread(terminal: string): Promise<UnreadTask[]>;
  launch(req: LaunchRequest): LaunchResult;
  isBusy(terminal: string): boolean;
  store: ProcessedStore;
}

export interface PollTickResult {
  launched: number;
  skipped: number;
  /** Terminals whose poll failed (network/auth). */
  failedTerminals: string[];
}

export async function pollOnce(
  config: RunnerConfig,
  deps: PollDeps,
  now: Date = new Date(),
): Promise<PollTickResult> {
  const result: PollTickResult = { launched: 0, skipped: 0, failedTerminals: [] };
  let stateDirty = false;

  for (const terminal of Object.keys(config.terminals)) {
    let tasks: UnreadTask[];
    try {
      tasks = await deps.fetchUnread(terminal);
    } catch (err) {
      logger.warn(
        `[Runner] Poll failed for ${terminal}: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.failedTerminals.push(terminal);
      continue;
    }

    for (const task of tasks) {
      // One session per terminal — the rest waits for the next tick.
      if (deps.isBusy(terminal)) {
        result.skipped++;
        continue;
      }
      const eligible = deps.store.shouldLaunch(task.id, {
        maxAttempts: config.max_attempts,
        retryCooldownMs: config.retry_cooldown_ms,
        now,
      });
      if (!eligible) {
        result.skipped++;
        continue;
      }

      const launch = deps.launch({ terminal, messageId: task.id, model: task.model });
      if (launch.started) {
        deps.store.recordLaunch(task.id, terminal, now);
        stateDirty = true;
        result.launched++;
      } else {
        logger.warn(`[Runner] Launch refused (${terminal}/${task.id}): ${launch.reason}`);
        result.skipped++;
      }
    }
  }

  if (stateDirty) {
    deps.store.save(now);
  }
  return result;
}

export interface PollLoopHandle {
  stop(): void;
}

export function startPollLoop(config: RunnerConfig, deps: PollDeps): PollLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let consecutiveFullFailures = 0;
  const terminalCount = Object.keys(config.terminals).length;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await pollOnce(config, deps);
      consecutiveFullFailures =
        res.failedTerminals.length === terminalCount ? consecutiveFullFailures + 1 : 0;
    } catch (err) {
      // pollOnce contains per-terminal handling; this is a true unexpected bug.
      logger.error('[Runner] Unexpected poll error:', err);
      consecutiveFullFailures++;
    }

    const delay = Math.min(
      config.poll_interval_ms * 2 ** consecutiveFullFailures,
      config.max_backoff_ms,
    );
    if (consecutiveFullFailures > 0) {
      logger.warn(`[Runner] Poll failing (server unreachable or error), backing off: next poll in ${delay}ms`);
    }
    if (!stopped) {
      // Referenced timer on purpose: polling IS the runner's main job —
      // an unref'd timer would let the process exit between ticks.
      timer = setTimeout(tick, delay);
    }
  };

  void tick();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
