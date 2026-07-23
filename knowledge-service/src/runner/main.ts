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
import { selectRunnerSink } from './sinkFactory';
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
  const storeLoadState = store.load();

  const client = new ServerClient(config.server_url, config.token);
  clearStaleSessionMarkers(config);
  const launcher = new SessionLauncher(config);
  // Build the immutable per-terminal router. Until the provider-specific
  // attached assembly lands, configured attached terminals remain fail-closed
  // because no attached sink is registered here.
  const sink = selectRunnerSink(config, launcher);
  assertRunnerShutdownBudget(sink, config.shutdown_grace_ms);
  const sseListeners: SseListenerHandle[] = [];
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
    });
    coordinator.registerIngressStopper(() => stopRunnerIngress(loop, sseListeners));

    // Second-level wake: events only nudge the poll; it remains launch authority.
    if (config.sse_enabled) {
      for (const terminal of Object.keys(config.terminals)) {
        sseListeners.push(
          startSseListener({
            serverUrl: config.server_url,
            token: config.token,
            terminal,
            maxBackoffMs: config.max_backoff_ms,
            onWake: () => loop.wake(),
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
