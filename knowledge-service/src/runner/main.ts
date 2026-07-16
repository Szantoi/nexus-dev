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
import { SessionLauncher } from './sessionLauncher';
import { startPollLoop } from './pollLoop';

function main(): void {
  const config = loadRunnerConfig();

  const store = new ProcessedStore(path.join(config.log_dir, 'runner-state.json'));
  store.load();

  const client = new ServerClient(config.server_url, config.token);
  const launcher = new SessionLauncher(config);

  logger.info(
    `[Runner] Starting — server=${config.server_url}, terminals=[${Object.keys(config.terminals).join(', ')}], poll=${config.poll_interval_ms}ms`,
  );

  const loop = startPollLoop(config, {
    fetchUnread: (terminal) => client.fetchUnread(terminal),
    launch: (req) => launcher.launch(req),
    isBusy: (terminal) => launcher.isBusy(terminal),
    store,
  });

  const shutdown = (signal: string): void => {
    logger.info(`[Runner] ${signal} received, stopping poll loop...`);
    loop.stop();
    store.save();
    const active = launcher.activeCount();
    if (active > 0) {
      // Sessions are doing real work — let them finish, only the loop stops.
      logger.info(`[Runner] ${active} session(s) still running — not killing them.`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
