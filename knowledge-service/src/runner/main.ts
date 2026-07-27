/**
 * main.ts — Runner entry point.
 *
 * Start (from repo root): node scripts/runner-start.mjs
 * Requires config/runner.yaml (see runner.yaml.example) and RUNNER_TOKEN.
 */

import * as path from 'node:path';
import { logger } from '../core/logger';
import { loadRunnerConfig } from './runnerConfig';
import { ProcessedStore } from './processedStore';
import { ServerClient } from './serverClient';
import { clearStaleSessionMarkers, SessionLauncher } from './sessionLauncher';
import { buildAttachedAssembly, selectRunnerSink } from './sinkFactory';
import {
  AttachedCompletionPump,
  startAttachedCompletionPump,
  type AttachedPumpHandle,
} from './attachedCompletionPump';
import { CompletionCursorStore } from './completionCursorStore';
import { FileDispatchGate } from './dispatchGate';
import { startPollLoop } from './pollLoop';
import { startSseListener, type SseListenerHandle } from './sseListener';
import { discoverConfiguredClis } from './cliDiscovery';
import { quarantineExistingBacklog } from './backlogQuarantine';
import {
  assertRunnerShutdownBudget,
  RunnerShutdownCoordinator,
  RunnerStartupInterruptedError,
  stopRunnerIngress,
} from './runnerLifecycle';

async function main(): Promise<void> {
  const config = loadRunnerConfig();

  const discoveries = await discoverConfiguredClis(config);
  const unavailable = discoveries.filter((result) => !result.available);
  for (const result of discoveries) {
    logger.info(
      result.available
        ? `[Runner] CLI ready: provider=${result.provider} version=${result.version || 'unknown'}`
        : `[Runner] CLI unavailable: provider=${result.provider} error=${result.error || 'unknown'}`,
    );
  }
  if (unavailable.length > 0) {
    throw new Error(
      `Runner preflight failed for provider(s): ${unavailable.map((item) => item.provider).join(', ')}`,
    );
  }

  const store = new ProcessedStore(path.join(config.log_dir, 'runner-state.json'));
  const dispatchGate = new FileDispatchGate(path.join(config.log_dir, 'dispatch-gates.json'));
  const storeLoadState = store.load();

  const client = new ServerClient(config.server_url, config.token);
  clearStaleSessionMarkers(config);
  const launcher = new SessionLauncher(config);
  // Attached runtime (one shared PTY host + marker store + manager) for every
  // mode: attached terminal; unsupported providers or missing credentials
  // fail startup closed instead of silently degrading to headless.
  const attached = buildAttachedAssembly(config);
  const sink = selectRunnerSink(config, launcher, attached.sinks);
  assertRunnerShutdownBudget(sink, config.shutdown_grace_ms);
  const sseListeners: SseListenerHandle[] = [];
  let pumpHandle: AttachedPumpHandle | undefined;
  const coordinator = new RunnerShutdownCoordinator({
    sink,
    graceMs: config.shutdown_grace_ms,
    saveState: () => store.save(),
    exit: (code) => process.exit(code),
    logger,
  });
  // Register immediately after sink creation so a signal during PTY preflight
  // cannot bypass awaited cleanup.
  process.on('SIGINT', () => void coordinator.begin('SIGINT'));
  process.on('SIGTERM', () => void coordinator.begin('SIGTERM'));

  try {
    // Persistent sinks must be ready before backlog handling or polling can
    // claim work. Any later startup failure rolls the prepared sinks back.
    await sink.ensureReady?.();
    coordinator.throwIfStopping();

    await quarantineExistingBacklog(
      config,
      store,
      storeLoadState,
      (terminal) => client.fetchUnread(terminal),
    );
    coordinator.throwIfStopping();

    logger.info(
      `[Runner] Starting — server=${config.server_url}, terminals=[${Object.keys(config.terminals).join(', ')}], poll=${config.poll_interval_ms}ms`,
    );

    const loop = startPollLoop(config, {
      fetchUnread: (terminal) => client.fetchUnread(terminal),
      claimTask: (terminal, messageId) => client.claimTask(terminal, messageId),
      releaseTask: (terminal, messageId) => client.releaseTask(terminal, messageId),
      launch: (req) => sink.dispatch(req),
      isBusy: (terminal) => sink.isBusy(terminal),
      store,
      dispatchGate,
    });
    coordinator.registerIngressStopper(async () => {
      await stopRunnerIngress(loop, sseListeners);
      // Terminal cleanup may already be running concurrently (the coordinator
      // starts it alongside ingress draining); that is safe because shutdown
      // flips every session state synchronously and all manager entry points
      // then reject. Awaiting here still guarantees the pump is fully stopped
      // before the coordinator reports the runner drained.
      await pumpHandle?.stop();
    });

    // Attached terminals: consume durable completion receipts + stable-idle
    // proofs on the poll cadence. SSE stays wake-only for the pump as well.
    // expected_island_id presence is enforced by the config schema and the
    // assembly whenever attached terminals exist.
    if (attached.manager && attached.terminals.length > 0 && config.expected_island_id) {
      const cursors = new CompletionCursorStore(
        path.join(config.log_dir, 'completion-cursors.json'),
      );
      if (cursors.load() === 'corrupt') {
        // Safe restart from 0: delivery is idempotent and historical receipts
        // advance the cursor without side effects.
        logger.warn('[Runner] Completion cursor store was corrupt; replaying from 0');
      }
      const pump = new AttachedCompletionPump({
        terminals: attached.terminals,
        expectedIslandId: config.expected_island_id,
        limits: {
          completionIdleTimeoutMs: config.attached_defaults.completion_idle_timeout_ms,
          taskStallTimeoutMs: config.attached_defaults.task_stall_timeout_ms,
        },
        client,
        cursors,
        manager: attached.manager,
        logger,
      });
      pumpHandle = startAttachedCompletionPump(pump, config.poll_interval_ms, logger);
      logger.info(
        `[Runner] Attached completion pump started for ${attached.terminals.length} terminal(s)`,
      );
    }

    // Second-level wake: events only nudge the poll; it remains launch authority.
    if (config.sse_enabled) {
      for (const terminal of Object.keys(config.terminals)) {
        sseListeners.push(
          startSseListener({
            serverUrl: config.server_url,
            token: config.token,
            terminal,
            maxBackoffMs: config.max_backoff_ms,
            onWake: () => {
              loop.wake();
              pumpHandle?.wake();
            },
          }),
        );
      }
      logger.info(`[Runner] SSE wake enabled for ${sseListeners.length} terminal(s)`);
    }
    coordinator.throwIfStopping();
  } catch (error) {
    await coordinator.begin(
      'startup-failure',
      error instanceof RunnerStartupInterruptedError ? undefined : error,
    );
  }
}

main().catch((error) => {
  logger.error('[Runner] Fatal startup error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
