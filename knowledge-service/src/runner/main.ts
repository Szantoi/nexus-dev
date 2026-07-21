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
import { startPollLoop } from './pollLoop';
import { startSseListener, type SseListenerHandle } from './sseListener';
import { discoverConfiguredClis } from './cliDiscovery';
import { quarantineExistingBacklog } from './backlogQuarantine';

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

  await quarantineExistingBacklog(
    config,
    store,
    storeLoadState,
    (terminal) => client.fetchUnread(terminal),
  );

  logger.info(
    `[Runner] Starting — server=${config.server_url}, terminals=[${Object.keys(config.terminals).join(', ')}], poll=${config.poll_interval_ms}ms`,
  );

  const loop = startPollLoop(config, {
    fetchUnread: (terminal) => client.fetchUnread(terminal),
    claimTask: (terminal, messageId) => client.claimTask(terminal, messageId),
    releaseTask: (terminal, messageId) => client.releaseTask(terminal, messageId),
    launch: (req) => launcher.launch(req),
    isBusy: (terminal) => launcher.isBusy(terminal),
    store,
  });

  // Second-level wake: one SSE stream per served terminal. Events only
  // nudge the poll loop — the poll stays the single launch authority.
  const sseListeners: SseListenerHandle[] = [];
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

  const shutdown = (signal: string): void => {
    logger.info(`[Runner] ${signal} received, stopping poll loop...`);
    for (const listener of sseListeners) listener.stop();
    loop.stop();
    store.save();
    const cancelled = launcher.cancelAll();
    if (cancelled > 0) logger.info(`[Runner] Cancelling ${cancelled} active session(s).`);
    const forceExit = setTimeout(() => process.exit(0), config.shutdown_grace_ms);
    forceExit.unref();
    const waitForExit = setInterval(() => {
      if (launcher.activeCount() === 0) {
        clearInterval(waitForExit);
        clearTimeout(forceExit);
        process.exit(0);
      }
    }, 100);
    waitForExit.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('[Runner] Fatal startup error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
