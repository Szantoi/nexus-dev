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
import type { DispatchGate } from './dispatchGate';
import { RuntimeStateError } from '../core/errors';

const MAX_POLL_ERROR_LENGTH = 500;

function boundedPollError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return text.length > MAX_POLL_ERROR_LENGTH
    ? `${text.slice(0, MAX_POLL_ERROR_LENGTH - 1)}…`
    : text;
}

export interface PollDeps {
  fetchUnread(terminal: string): Promise<UnreadTask[]>;
  claimTask(terminal: string, messageId: string): Promise<void>;
  releaseTask(terminal: string, messageId: string): Promise<void>;
  launch(req: LaunchRequest): LaunchResult;
  isBusy(terminal: string): boolean;
  store: ProcessedStore;
  /** Optional single-use, locally managed canary grants. */
  dispatchGate?: DispatchGate;
}

export interface PollTickResult {
  launched: number;
  skipped: number;
  /** Terminals whose poll failed (network/auth). */
  failedTerminals: string[];
}

export class PollLoopDrainError extends Error {
  readonly name = 'PollLoopDrainError';

  constructor(readonly errors: readonly Error[], omitted = 0) {
    const detail = errors
      .slice(0, 3)
      .map((error) => error.message.replace(/[\r\n\t]+/g, ' ').slice(0, 200))
      .join(' | ');
    super(`poll loop cannot drain cleanly: ${detail}${omitted > 0 ? ` | +${omitted} more` : ''}`);
  }
}

export async function pollOnce(
  config: RunnerConfig,
  deps: PollDeps,
  now: Date = new Date(),
  signal?: AbortSignal,
): Promise<PollTickResult> {
  const result: PollTickResult = { launched: 0, skipped: 0, failedTerminals: [] };
  let stateDirty = false;

  for (const terminal of Object.keys(config.terminals)) {
    if (signal?.aborted) break;
    let tasks: UnreadTask[];
    try {
      tasks = await deps.fetchUnread(terminal);
    } catch (err) {
      logger.warn(
        `[Runner] Poll failed for ${terminal}: ${boundedPollError(err)}`,
      );
      result.failedTerminals.push(terminal);
      continue;
    }

    // A shutdown may arrive while fetchUnread is in flight. Do not inspect or
    // claim the returned work after the stop boundary.
    if (signal?.aborted) break;

    for (const task of tasks) {
      if (signal?.aborted) break;
      const allowedMessageIds = config.terminals[terminal].allowed_message_ids;
      const dynamicallyAllowed = deps.dispatchGate?.allows(terminal, task.id) ?? false;
      // A defined list is a deployment gate: leave out-of-scope backlog work
      // untouched (unclaimed and unrecorded) during an isolated canary.
      if (
        allowedMessageIds !== undefined &&
        !allowedMessageIds.includes(task.id) &&
        !dynamicallyAllowed
      ) {
        result.skipped++;
        continue;
      }
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

      try {
        await deps.claimTask(terminal, task.id);
      } catch (err) {
        if (signal?.aborted) {
          throw new RuntimeStateError(
            `claim outcome indeterminate during shutdown (${terminal}/${task.id}): ${boundedPollError(err)}`,
          );
        }
        logger.warn(
          `[Runner] Claim refused (${terminal}/${task.id}): ${boundedPollError(err)}`,
        );
        result.skipped++;
        continue;
      }

      // A claim can win concurrently with shutdown. Release it before the
      // loop reports itself drained; launching after this boundary is forbidden.
      if (signal?.aborted) {
        try {
          await deps.releaseTask(terminal, task.id);
        } catch (err) {
          throw new RuntimeStateError(
            `claim release failed during shutdown (${terminal}/${task.id}): ${boundedPollError(err)}`,
          );
        }
        result.skipped++;
        break;
      }

      let launch: LaunchResult;
      try {
        launch = deps.launch({ terminal, messageId: task.id, model: task.model });
      } catch (launchError) {
        let releaseError: unknown;
        try {
          await deps.releaseTask(terminal, task.id);
        } catch (error) {
          releaseError = error;
        }
        const launchDetail = boundedPollError(launchError);
        const releaseDetail = boundedPollError(releaseError);
        throw new RuntimeStateError(
          `launch threw after claim (${terminal}/${task.id}): ${launchDetail}${
            releaseError ? `; claim release also failed: ${releaseDetail}` : '; claim released'
          }`,
        );
      }
      if (launch.started) {
        deps.store.recordLaunch(task.id, terminal, now);
        stateDirty = true;
        if (dynamicallyAllowed) {
          try {
            // Fail closed on the next task: an unavailable gate file leaves
            // the exact same message grant in place for deliberate recovery.
            deps.dispatchGate?.consume(terminal, task.id);
          } catch (error) {
            logger.error(
              `[Runner] Dispatch gate consumption failed (${terminal}/${task.id}): ${boundedPollError(error)}`,
            );
          }
        }
        result.launched++;
      } else {
        logger.warn(`[Runner] Launch refused (${terminal}/${task.id}): ${launch.reason}`);
        try {
          await deps.releaseTask(terminal, task.id);
        } catch (err) {
          throw new RuntimeStateError(
            `claim release failed (${terminal}/${task.id}): ${boundedPollError(err)}`,
          );
        }
        if (launch.permanentRefusal) {
          deps.store.recordQuarantine(task.id, terminal, now);
          stateDirty = true;
          logger.warn(
            `[Runner] Quarantined permanently refused task (${terminal}/${task.id}): ${launch.reason}`,
          );
        }
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
  /** Request stop immediately. Prefer stopAndDrain during process shutdown. */
  stop(): void;
  /** Stop accepting work and wait for any in-flight fetch/claim/release. */
  stopAndDrain(): Promise<void>;
  /** Trigger an immediate poll (e.g. on an SSE wake event). Safe to call anytime. */
  wake(): void;
}

export function startPollLoop(config: RunnerConfig, deps: PollDeps): PollLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | undefined;
  let wakeRequested = false;
  let consecutiveFullFailures = 0;
  const terminalCount = Object.keys(config.terminals).length;
  const stopController = new AbortController();
  const drainFailures: Error[] = [];
  let omittedDrainFailures = 0;

  const recordDrainFailure = (error: unknown): void => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (drainFailures.length < 20) drainFailures.push(failure);
    else omittedDrainFailures++;
  };

  async function runTick(): Promise<void> {
    try {
      const res = await pollOnce(config, deps, new Date(), stopController.signal);
      if (!stopped) {
        consecutiveFullFailures =
          res.failedTerminals.length === terminalCount ? consecutiveFullFailures + 1 : 0;
      }
    } catch (err) {
      // pollOnce contains per-terminal handling; this is a true unexpected bug.
      logger.error(
        '[Runner] Unexpected poll error:',
        boundedPollError(err),
      );
      recordDrainFailure(err);
      if (!stopped) consecutiveFullFailures++;
    }
  }

  function finishTick(execution: Promise<void>): void {
    if (inFlight !== execution) return;
    inFlight = undefined;
    if (stopped) return;
    const delay = wakeRequested
      ? 0
      : Math.min(config.poll_interval_ms * 2 ** consecutiveFullFailures, config.max_backoff_ms);
    wakeRequested = false;
    if (consecutiveFullFailures > 0) {
      logger.warn(`[Runner] Poll failing (server unreachable or error), backing off: next poll in ${delay}ms`);
    }
    // Referenced timer on purpose: polling IS the runner's main job.
    timer = setTimeout(tick, delay);
  }

  function tick(): void {
    if (stopped || inFlight) {
      // A wake during an in-flight tick queues one follow-up tick.
      if (inFlight && !stopped) wakeRequested = true;
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const execution = runTick();
    inFlight = execution;
    void execution.then(
      () => finishTick(execution),
      () => finishTick(execution),
    );
  }

  tick();

  const requestStop = (): void => {
    if (stopped) return;
    stopped = true;
    stopController.abort();
    wakeRequested = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    stop(): void {
      requestStop();
    },
    async stopAndDrain(): Promise<void> {
      requestStop();
      await inFlight;
      if (drainFailures.length > 0) {
        throw new PollLoopDrainError(drainFailures, omittedDrainFailures);
      }
    },
    wake(): void {
      tick();
    },
  };
}
