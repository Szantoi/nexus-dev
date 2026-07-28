// startupInboxWatcher.test.ts — TASK-QC-013: the documented
// ENABLE_INBOX_WATCHER key must actually gate the inbox watcher (before the
// fix the watcher started unconditionally and the DEV isolation claim in the
// conductor CLAUDE.md was false).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const watcherMocks = vi.hoisted(() => ({
  startInboxWatcher: vi.fn(),
  scanExistingUnread: vi.fn(async () => []),
  initializeRegistry: vi.fn(async () => {}),
}));

const envState = vi.hoisted(() => ({ ENABLE_INBOX_WATCHER: true }));

vi.mock('../../inboxWatcher', async () => {
  const { EventEmitter } = await import('node:events');
  return { ...watcherMocks, inboxEvents: new EventEmitter() };
});

vi.mock('../../config/env', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const realEnv = actual.env as Record<string, unknown>;
  return {
    ...actual,
    env: new Proxy(realEnv, {
      get(target, prop) {
        if (prop === 'ENABLE_INBOX_WATCHER') return envState.ENABLE_INBOX_WATCHER;
        return target[prop as string];
      },
    }),
  };
});

import { startInboxWatcherIfEnabled } from '../../bootstrap/startup';

describe('startInboxWatcherIfEnabled (TASK-QC-013)', () => {
  beforeEach(() => {
    watcherMocks.startInboxWatcher.mockClear();
  });

  it('does NOT start the watcher when ENABLE_INBOX_WATCHER is false (DEV isolation)', () => {
    envState.ENABLE_INBOX_WATCHER = false;
    expect(startInboxWatcherIfEnabled()).toBe(false);
    expect(watcherMocks.startInboxWatcher).not.toHaveBeenCalled();
  });

  it('starts the watcher when the flag is enabled (production default)', () => {
    envState.ENABLE_INBOX_WATCHER = true;
    expect(startInboxWatcherIfEnabled()).toBe(true);
    expect(watcherMocks.startInboxWatcher).toHaveBeenCalledTimes(1);
  });
});
