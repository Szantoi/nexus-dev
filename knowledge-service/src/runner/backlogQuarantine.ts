/**
 * First-start safety barrier.
 *
 * A newly installed runner must not interpret a historical UNREAD backlog as
 * fresh launch requests. Any terminal fetch failure aborts startup so a
 * partial baseline can never become an accidental launch window.
 */

import { logger } from '../core/logger';
import type { ProcessedStore } from './processedStore';
import type { RunnerConfig } from './runnerConfig';
import type { UnreadTask } from './serverClient';

export type StoreLoadState = 'loaded' | 'missing' | 'corrupt';

export async function quarantineExistingBacklog(
  config: RunnerConfig,
  store: ProcessedStore,
  loadState: StoreLoadState,
  fetchUnread: (terminal: string) => Promise<UnreadTask[]>,
  now: Date = new Date(),
): Promise<number> {
  if (!config.quarantine_existing_on_first_start || loadState === 'loaded') return 0;

  const baseline: Array<{ terminal: string; task: UnreadTask }> = [];
  for (const terminal of Object.keys(config.terminals)) {
    let tasks: UnreadTask[];
    try {
      tasks = await fetchUnread(terminal);
    } catch (error) {
      throw new Error(
        `Backlog quarantine failed for ${terminal}; runner will not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    for (const task of tasks) baseline.push({ terminal, task });
  }

  for (const { terminal, task } of baseline) {
    store.recordQuarantine(task.id, terminal, now);
  }
  store.save(now);
  logger.warn(
    `[Runner] First-start backlog quarantine recorded ${baseline.length} existing task(s); only later tasks are launchable.`,
  );
  return baseline.length;
}
