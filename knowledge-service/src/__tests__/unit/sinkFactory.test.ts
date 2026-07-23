import { describe, expect, it, vi } from 'vitest';
import type { LaunchRequest, LaunchResult } from '../../runner/sessionLauncher';
import { resolveTerminalSink, selectRunnerSink } from '../../runner/sinkFactory';
import type { TerminalSink } from '../../runner/terminalSink';
import { TerminalSinkRouter } from '../../runner/terminalSinkRouter';
import type { RunnerConfig } from '../../runner/runnerConfig';

function sink(): TerminalSink {
  return {
    dispatch: vi.fn<(request: LaunchRequest) => LaunchResult>(() => ({ started: true })),
    isBusy: vi.fn(() => false),
    cancel: vi.fn(() => false),
    cancelAll: vi.fn(() => 0),
    activeCount: vi.fn(() => 0),
    ensureReady: vi.fn(async () => Promise.resolve()),
  };
}

function config(): RunnerConfig {
  return {
    server_url: 'http://127.0.0.1:3466',
    token: 'test-token',
    poll_interval_ms: 1000,
    sse_enabled: false,
    max_backoff_ms: 10_000,
    max_attempts: 3,
    retry_cooldown_ms: 10_000,
    quarantine_existing_on_first_start: true,
    session_timeout_ms: 60_000,
    max_output_bytes: 1024,
    shutdown_grace_ms: 1000,
    mcp_server_name: 'spaceos-knowledge',
    default_provider: 'codex',
    providers: {
      codex: {
        binary: 'codex',
        sandbox: 'read-only',
        ephemeral: true,
        skip_git_repo_check: false,
        extra_args: [],
      },
    },
    log_dir: 'logs/runner',
    terminals: {
      backend: {
        workdir: '.',
        models: ['gpt-5.6-terra'],
        default_model: 'gpt-5.6-terra',
        additional_write_dirs: [],
        mode: 'headless',
      },
      explorer: {
        workdir: '.',
        models: ['gpt-5.6-terra'],
        default_model: 'gpt-5.6-terra',
        additional_write_dirs: [],
        mode: 'attached',
      },
    },
  };
}

describe('sinkFactory mixed-mode routing', () => {
  it('resolves a registered terminal-scoped attached sink', () => {
    const headless = sink();
    const attached = sink();

    expect(
      resolveTerminalSink(
        'explorer',
        'attached',
        headless,
        new Map([['explorer', attached]]),
      ),
    ).toBe(attached);
  });

  it('builds a router only when every configured terminal resolves', () => {
    const headless = sink();
    const attached = sink();
    const router = selectRunnerSink(
      config(),
      headless,
      new Map([['explorer', attached]]),
    );

    expect(router).toBeInstanceOf(TerminalSinkRouter);
    router.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    router.dispatch({ terminal: 'explorer', messageId: 'MSG-2' });
    expect(headless.dispatch).toHaveBeenCalledTimes(1);
    expect(attached.dispatch).toHaveBeenCalledTimes(1);
  });

  it('throws before returning a partial router when an attached route is missing', () => {
    expect(() => selectRunnerSink(config(), sink())).toThrow(
      "AttachedSink unavailable for configured terminal 'explorer'",
    );
  });
});
