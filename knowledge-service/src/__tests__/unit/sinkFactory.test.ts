import { describe, expect, it, vi } from 'vitest';
import { AttachedSessionManager } from '../../runner/attachedSessionManager';
import type { AttachedTaskMarkerStore } from '../../runner/attachedTaskMarkerStore';
import type { PtyHost } from '../../runner/ptyHost';
import type { LaunchRequest, LaunchResult } from '../../runner/sessionLauncher';
import {
  buildAttachedAssembly,
  resolveTerminalSink,
  selectRunnerSink,
} from '../../runner/sinkFactory';
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

describe('buildAttachedAssembly', () => {
  const ATTACHED_DEFAULTS = {
    startup_timeout_ms: 30_000,
    ready_confirm_samples: 2,
    idle_settle_ms: 1_500,
    idle_confirm_samples: 2,
    completion_idle_timeout_ms: 30_000,
    task_stall_timeout_ms: 600_000,
    cols: 120,
    rows: 36,
  };

  function assemblyConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
    return {
      ...config(),
      expected_island_id: 'island-a',
      attached_defaults: ATTACHED_DEFAULTS,
      providers: {
        codex: {
          binary: 'codex',
          auth_env_var: 'NEXUS_AGENT_TOKEN',
          sandbox: 'read-only',
          ephemeral: true,
          skip_git_repo_check: false,
          extra_args: [],
        },
      },
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
          credential_env: 'NEXUS_AGENT_TOKEN_EXPLORER',
          mode: 'attached',
        },
        reviewer: {
          workdir: '.',
          models: ['gpt-5.6-terra'],
          default_model: 'gpt-5.6-terra',
          additional_write_dirs: [],
          credential_env: 'NEXUS_AGENT_TOKEN_REVIEWER',
          mode: 'attached',
        },
      },
      ...overrides,
    } as RunnerConfig;
  }

  function deps() {
    const markerStore: AttachedTaskMarkerStore = {
      load: vi.fn(() => undefined),
      save: vi.fn(),
      clear: vi.fn(() => false),
    };
    const ptyHost: PtyHost = {
      cleanupDeadlineMs: 5_000,
      spawnDeadlineMs: 10_000,
      spawn: vi.fn(async () => {
        throw new Error('no real spawn in tests');
      }),
    };
    const createMarkerStore = vi.fn(() => markerStore);
    const createPtyHost = vi.fn(() => ptyHost);
    const env = {
      NEXUS_AGENT_TOKEN_EXPLORER: 'secret-e',
      NEXUS_AGENT_TOKEN_REVIEWER: 'secret-r',
    };
    return { createMarkerStore, createPtyHost, env, markerStore, ptyHost };
  }

  it('returns an empty assembly when no terminal is attached', () => {
    const cfg = assemblyConfig();
    cfg.terminals = { backend: cfg.terminals.backend };

    const assembly = buildAttachedAssembly(cfg, deps());

    expect(assembly.manager).toBeUndefined();
    expect(assembly.terminals).toEqual([]);
    expect(assembly.sinks.size).toBe(0);
  });

  it('builds one shared manager and routes for every attached terminal', () => {
    const seams = deps();
    const assembly = buildAttachedAssembly(assemblyConfig(), seams);

    expect(assembly.manager).toBeInstanceOf(AttachedSessionManager);
    expect(assembly.terminals).toEqual(['explorer', 'reviewer']);
    expect(assembly.sinks.get('explorer')).toBe(assembly.manager);
    expect(assembly.sinks.get('reviewer')).toBe(assembly.manager);
    expect(seams.createMarkerStore).toHaveBeenCalledWith(
      expect.stringMatching(/attached-markers$/),
    );
    expect(seams.createPtyHost).toHaveBeenCalledTimes(1);

    // The assembled routes satisfy the fail-closed router preflight and an
    // early dispatch is refused (session not ready), never silently headless.
    const router = selectRunnerSink(assemblyConfig(), sink(), assembly.sinks);
    const result = router.dispatch({
      terminal: 'explorer',
      messageId: 'MSG-1',
      model: 'gpt-5.6-terra',
    });
    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/not ready/);
  });

  it('fails closed for a provider without an interactive contract', () => {
    const cfg = assemblyConfig();
    cfg.terminals.explorer.provider = 'claude';
    cfg.providers.claude = {
      binary: 'claude',
      sandbox: 'workspace-write',
      ephemeral: true,
      skip_git_repo_check: false,
      extra_args: [],
    };

    expect(() => buildAttachedAssembly(cfg, deps())).toThrow(
      /attached mode is not supported for provider 'claude'/,
    );
  });

  it('fails closed without a declared island scope', () => {
    expect(() =>
      buildAttachedAssembly(assemblyConfig({ expected_island_id: undefined }), deps()),
    ).toThrow(/expected_island_id is required/);
  });

  it('fails closed when a terminal credential source is missing', () => {
    const seams = deps();
    seams.env = { NEXUS_AGENT_TOKEN_EXPLORER: 'secret-e' } as typeof seams.env;

    expect(() => buildAttachedAssembly(assemblyConfig(), seams)).toThrow(
      /credential source unavailable for attached terminal reviewer/,
    );
  });
});
