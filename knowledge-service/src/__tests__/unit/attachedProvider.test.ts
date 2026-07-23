import { describe, expect, it } from 'vitest';
import {
  buildInteractiveLaunchSpec,
  createAttachedTerminalPolicy,
  encodeAttachedNudge,
  type AttachedPolicyContext,
} from '../../runner/attachedProvider';
import type { TerminalRunnerConfig } from '../../runner/runnerConfig';

const ESC = '\u001b';

const DEFAULTS = {
  startup_timeout_ms: 30_000,
  ready_confirm_samples: 2,
  idle_settle_ms: 1_500,
  idle_confirm_samples: 2,
  completion_idle_timeout_ms: 30_000,
  task_stall_timeout_ms: 600_000,
  cols: 120,
  rows: 36,
};

function entry(overrides: Partial<TerminalRunnerConfig> = {}): TerminalRunnerConfig {
  return {
    workdir: 'C:/work/explorer',
    models: ['gpt-5.6-terra'],
    default_model: 'gpt-5.6-terra',
    additional_write_dirs: [],
    credential_env: 'NEXUS_AGENT_TOKEN_EXPLORER',
    mode: 'attached',
    ...overrides,
  } as TerminalRunnerConfig;
}

function context(overrides: Partial<AttachedPolicyContext> = {}): AttachedPolicyContext {
  return {
    provider: 'codex',
    terminal: 'explorer',
    entry: entry(),
    providerConfig: {
      binary: 'codex',
      auth_env_var: 'NEXUS_AGENT_TOKEN',
      sandbox: 'read-only',
      ephemeral: true,
      skip_git_repo_check: false,
      extra_args: [],
    },
    defaults: DEFAULTS,
    expectedIslandId: 'island-a',
    mcpServerName: 'spaceos-knowledge',
    env: { NEXUS_AGENT_TOKEN_EXPLORER: 'secret-token' },
    ...overrides,
  };
}

describe('buildInteractiveLaunchSpec', () => {
  it('builds a primary-screen interactive Codex spec with mapped credentials', () => {
    const spec = buildInteractiveLaunchSpec(context());

    expect(spec.executable).toBe('codex');
    expect(spec.args).toEqual([
      '--no-alt-screen',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.6-terra',
      '--cd',
      'C:/work/explorer',
    ]);
    expect(spec.cwd).toBe('C:/work/explorer');
    expect(spec.cols).toBe(120);
    expect(spec.rows).toBe(36);
    expect(spec.env.NEXUS_AGENT_TOKEN).toBe('secret-token');
  });

  it('fails closed when the credential source is missing', () => {
    expect(() => buildInteractiveLaunchSpec(context({ env: {} }))).toThrow(
      /credential source unavailable/,
    );
    expect(() =>
      buildInteractiveLaunchSpec(context({ entry: entry({ credential_env: undefined }) })),
    ).toThrow(/credential_env missing/);
  });

  it.each(['claude', 'antigravity'] as const)(
    'fails closed for provider without a proven interactive contract: %s',
    (provider) => {
      expect(() => buildInteractiveLaunchSpec(context({ provider }))).toThrow(
        /attached mode is not supported for provider/,
      );
      expect(() => createAttachedTerminalPolicy(context({ provider }))).toThrow(
        /attached mode is not supported for provider/,
      );
    },
  );
});

describe('encodeAttachedNudge', () => {
  const nudgeContext = { sessionModel: 'gpt-5.6-terra', mcpServerName: 'spaceos-knowledge' };

  it('produces one sanitised line referencing the task id, never task content', () => {
    const nudge = encodeAttachedNudge(
      { terminal: 'explorer', messageId: 'MSG-EXPLORER-031', model: 'gpt-5.6-terra' },
      nudgeContext,
    );

    expect(nudge.endsWith('\r')).toBe(true);
    const line = nudge.slice(0, -1);
    expect(line).toContain('MSG-EXPLORER-031');
    expect(line).toContain('mcp__spaceos-knowledge__fetch_task');
    expect(line).toContain('complete_task');
    expect(/[\u0000-\u001f\u007f]/.test(line)).toBe(false);
  });

  it.each(['MSG 1', 'MSG\nX', '../etc', `${ESC}[31mID`, '', '-lead'])(
    'refuses an unsafe message id: %j',
    (messageId) => {
      expect(() =>
        encodeAttachedNudge({ terminal: 'explorer', messageId, model: 'gpt-5.6-terra' }, nudgeContext),
      ).toThrow(/unsafe mailbox message id/);
    },
  );

  it('refuses a task requesting a different model than the live session', () => {
    expect(() =>
      encodeAttachedNudge(
        { terminal: 'explorer', messageId: 'MSG-1', model: 'other-model' },
        nudgeContext,
      ),
    ).toThrow(/runs model 'gpt-5.6-terra' but task requests 'other-model'/);
  });
});

describe('createAttachedTerminalPolicy', () => {
  // The manager feeds every chunk exactly once via observeSample; the
  // classifiers evaluate the observed screen and ignore their argument.
  function feed(policy: ReturnType<typeof createAttachedTerminalPolicy>, chunk: string): void {
    policy.observeSample?.(chunk);
  }

  it('classifies readiness and idle from the observed screen state', () => {
    const policy = createAttachedTerminalPolicy(context());

    expect(policy.expectedIslandId).toBe('island-a');
    expect(policy.startupTimeoutMs).toBe(30_000);
    expect(policy.readyConfirmSamples).toBe(2);
    expect(policy.idleSettleMs).toBe(1_500);
    expect(policy.idleConfirmSamples).toBe(2);
    feed(policy, 'booting...');
    expect(policy.isReadySample('')).toBe(false);
    feed(policy, '\ncodex ready\n> ');
    expect(policy.isReadySample('')).toBe(true);
    expect(policy.isIdleSample('')).toBe(true);
  });

  it('resets stale alternate-screen state for each new PTY generation', () => {
    const policy = createAttachedTerminalPolicy(context());
    // Dead session entered a TUI and never left it.
    feed(policy, `${ESC}[?1049h`);
    feed(policy, '> ');
    expect(policy.isReadySample('')).toBe(false);

    policy.onSessionStart?.();

    feed(policy, '> ');
    expect(policy.isReadySample('')).toBe(true);
  });

  it('fails closed for idle while a TUI opened during the busy phase is still up', () => {
    const policy = createAttachedTerminalPolicy(context());
    feed(policy, '\n> ');
    expect(policy.isReadySample('')).toBe(true);

    // Busy-phase output flows through observeSample even though the manager
    // never calls the classifiers in that state.
    feed(policy, `${ESC}[?1049h`);
    feed(policy, 'TUI menu selection ❯ ');

    // The completion receipt arrives while the TUI is still open: draining
    // samples must NOT classify idle from alt-screen frames.
    expect(policy.isIdleSample('')).toBe(false);
    feed(policy, 'another frame ❯ ');
    expect(policy.isIdleSample('')).toBe(false);

    // Only after the TUI closes and a real prompt returns does idle hold.
    feed(policy, `${ESC}[?1049l`);
    feed(policy, '> ');
    expect(policy.isIdleSample('')).toBe(true);
  });

  it('honours per-terminal pattern overrides', () => {
    const policy = createAttachedTerminalPolicy(
      context({
        entry: entry({
          attached: { ready_pattern: String.raw`^READY$`, idle_pattern: String.raw`^IDLE$` },
        } as Partial<TerminalRunnerConfig>),
      }),
    );

    feed(policy, '> ');
    expect(policy.isReadySample('')).toBe(false);
    // The screen is cumulative: a real prompt arrives on its own line.
    feed(policy, '\nREADY');
    expect(policy.isReadySample('')).toBe(true);
    feed(policy, '\nIDLE');
    expect(policy.isIdleSample('')).toBe(true);
  });

  it('runs a model-less task on the session model instead of refusing it', () => {
    const policy = createAttachedTerminalPolicy(context());
    const nudge = policy.encodeDispatch({ terminal: 'explorer', messageId: 'MSG-10' });
    expect(nudge).toContain('MSG-10');
  });

  it('encodes dispatches with the session model pinned at spawn', () => {
    const policy = createAttachedTerminalPolicy(context());
    expect(
      policy.encodeDispatch({ terminal: 'explorer', messageId: 'MSG-9', model: 'gpt-5.6-terra' }),
    ).toContain('MSG-9');
    expect(() =>
      policy.encodeDispatch({ terminal: 'explorer', messageId: 'MSG-9', model: 'sonnet' }),
    ).toThrow(/task requests 'sonnet'/);
  });
});
