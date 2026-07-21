/**
 * Runner unit tests — hermetic (temp-file config/state, mocked spawn/fetch).
 * PINS the security contract: closed command set (argv from config/enum
 * only, prompt via stdin), terminal/model whitelist, fail-closed token
 * requirement, bounded retries.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { loadRunnerConfig, RunnerConfigSchema, type RunnerConfig } from '../../runner/runnerConfig';
import { ProcessedStore } from '../../runner/processedStore';
import { ServerClient, ServerApiError } from '../../runner/serverClient';
import { isSuccessfulTaskCompletion, SessionLauncher } from '../../runner/sessionLauncher';
import { buildTaskAssignmentPrompt } from '../../runner/taskPrompt';
import { pollOnce } from '../../runner/pollLoop';
import { quarantineExistingBacklog } from '../../runner/backlogQuarantine';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
const fakeChildren: FakeChild[] = [];

afterEach(async () => {
  for (const child of fakeChildren.splice(0)) child.emit('exit', 0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function writeConfig(yamlContent: string): string {
  const p = path.join(TMP_DIR, `runner-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, yamlContent, 'utf-8');
  return p;
}

const WORKDIR = path.join(TMP_DIR, 'workdir');
fs.mkdirSync(WORKDIR, { recursive: true });

const VALID_YAML = `
server_url: http://localhost:3466
token: "test-token"
poll_interval_ms: 1000
log_dir: ${JSON.stringify(path.join(TMP_DIR, 'logs'))}
terminals:
  backend:
    workdir: ${JSON.stringify(WORKDIR)}
    models: [haiku, sonnet]
    default_model: sonnet
`;

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const base = RunnerConfigSchema.parse({
    server_url: 'http://localhost:3466',
    token: 'test-token',
    log_dir: path.join(TMP_DIR, 'logs'),
    terminals: {
      backend: { workdir: WORKDIR, models: ['haiku', 'sonnet'], default_model: 'sonnet' },
    },
  });
  return { ...base, token: 'test-token', ...overrides };
}

// ─── Config ──────────────────────────────────────────────────────────────────

describe('loadRunnerConfig', () => {
  beforeEach(() => {
    delete process.env.RUNNER_TOKEN;
  });

  it('loads a valid config and resolves the token from YAML', () => {
    const cfg = loadRunnerConfig(writeConfig(VALID_YAML));
    expect(cfg.token).toBe('test-token');
    expect(cfg.terminals.backend.default_model).toBe('sonnet');
    expect(cfg.poll_interval_ms).toBe(1000);
  });

  it('RUNNER_TOKEN env wins over the YAML token', () => {
    process.env.RUNNER_TOKEN = 'env-token';
    try {
      const cfg = loadRunnerConfig(writeConfig(VALID_YAML));
      expect(cfg.token).toBe('env-token');
    } finally {
      delete process.env.RUNNER_TOKEN;
    }
  });

  it('fails closed without a token', () => {
    const yaml = VALID_YAML.replace('token: "test-token"\n', '');
    expect(() => loadRunnerConfig(writeConfig(yaml))).toThrow(/token missing/i);
  });

  it('rejects a missing config file with a helpful message', () => {
    expect(() => loadRunnerConfig(path.join(TMP_DIR, 'nope.yaml'))).toThrow(/runner.yaml.example/);
  });

  it('rejects dangerous bypass flags and newline-bearing local args', () => {
    expect(() =>
      loadRunnerConfig(writeConfig(`${VALID_YAML}
providers:
  claude:
    binary: claude
    extra_args: ["--dangerously-skip-permissions"]
`)),
    ).toThrow(/Invalid runner config/);
    expect(() =>
      loadRunnerConfig(writeConfig(`${VALID_YAML}
providers:
  claude:
    binary: claude
    extra_args: ["line\\nbreak"]
`)),
    ).toThrow(/Invalid runner config/);
  });

  it('rejects an empty terminals map', () => {
    const yaml = `
server_url: http://localhost:3466
token: "t"
terminals: {}
`;
    expect(() => loadRunnerConfig(writeConfig(yaml))).toThrow(/no terminals/i);
  });
});

// ─── ProcessedStore ──────────────────────────────────────────────────────────

describe('ProcessedStore', () => {
  const OPTS = { maxAttempts: 3, retryCooldownMs: 60_000 };

  it('allows a never-seen message and blocks an immediate relaunch', () => {
    const store = new ProcessedStore(path.join(TMP_DIR, 'state1.json'));
    const now = new Date('2026-07-16T10:00:00Z');
    expect(store.shouldLaunch('MSG-1', { ...OPTS, now })).toBe(true);
    store.recordLaunch('MSG-1', 'backend', now);
    expect(store.shouldLaunch('MSG-1', { ...OPTS, now })).toBe(false);
  });

  it('allows retry after cooldown, up to maxAttempts', () => {
    const store = new ProcessedStore(path.join(TMP_DIR, 'state2.json'));
    let now = new Date('2026-07-16T10:00:00Z');
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(store.shouldLaunch('MSG-1', { ...OPTS, now })).toBe(true);
      store.recordLaunch('MSG-1', 'backend', now);
      now = new Date(now.getTime() + 61_000);
    }
    // 3 attempts exhausted — never again, even after cooldown
    expect(store.shouldLaunch('MSG-1', { ...OPTS, now })).toBe(false);
    expect(store.get('MSG-1')?.attempts).toBe(3);
  });

  it('persists state across load/save', () => {
    const file = path.join(TMP_DIR, 'state3.json');
    const store = new ProcessedStore(file);
    const now = new Date('2026-07-16T10:00:00Z');
    store.recordLaunch('MSG-9', 'backend', now);
    store.save(now);

    const reloaded = new ProcessedStore(file);
    reloaded.load();
    expect(reloaded.get('MSG-9')?.terminal).toBe('backend');
    expect(reloaded.shouldLaunch('MSG-9', { ...OPTS, now })).toBe(false);
  });

  it('prunes entries older than 14 days on save', () => {
    const file = path.join(TMP_DIR, 'state4.json');
    const store = new ProcessedStore(file);
    const old = new Date('2026-06-01T10:00:00Z');
    const now = new Date('2026-07-16T10:00:00Z');
    store.recordLaunch('MSG-OLD', 'backend', old);
    store.save(now);

    const reloaded = new ProcessedStore(file);
    reloaded.load();
    expect(reloaded.get('MSG-OLD')).toBeUndefined();
  });

  it('survives a corrupt state file', () => {
    const file = path.join(TMP_DIR, 'state5.json');
    fs.writeFileSync(file, '{not json', 'utf-8');
    const store = new ProcessedStore(file);
    expect(store.load()).toBe('corrupt');
    expect(store.shouldLaunch('MSG-1', OPTS)).toBe(true);
  });

  it('persists quarantined backlog entries without aging them into launchable work', () => {
    const file = path.join(TMP_DIR, 'state-quarantine.json');
    const store = new ProcessedStore(file);
    const old = new Date('2026-06-01T10:00:00Z');
    const now = new Date('2026-07-16T10:00:00Z');
    store.recordQuarantine('MSG-LEGACY', 'backend', old);
    store.save(now);

    const reloaded = new ProcessedStore(file);
    expect(reloaded.load()).toBe('loaded');
    expect(reloaded.get('MSG-LEGACY')?.disposition).toBe('quarantine');
    expect(reloaded.shouldLaunch('MSG-LEGACY', { ...OPTS, now })).toBe(false);
  });
});

describe('first-start backlog quarantine', () => {
  it('baselines existing work and leaves later task IDs launchable', async () => {
    const file = path.join(TMP_DIR, 'state-first-start.json');
    const store = new ProcessedStore(file);
    const cfg = makeConfig();
    const count = await quarantineExistingBacklog(
      cfg,
      store,
      'missing',
      async (terminal) => [{ id: 'MSG-OLD', terminal }],
      new Date('2026-07-21T12:00:00Z'),
    );

    expect(count).toBe(1);
    expect(store.shouldLaunch('MSG-OLD', { maxAttempts: 3, retryCooldownMs: 0 })).toBe(false);
    expect(store.shouldLaunch('MSG-NEW', { maxAttempts: 3, retryCooldownMs: 0 })).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('fails closed without persisting a partial baseline', async () => {
    const file = path.join(TMP_DIR, 'state-first-start-failure.json');
    const store = new ProcessedStore(file);
    const cfg = makeConfig({
      terminals: {
        backend: makeConfig().terminals.backend,
        frontend: { ...makeConfig().terminals.backend, workdir: WORKDIR },
      },
    });

    await expect(
      quarantineExistingBacklog(cfg, store, 'corrupt', async (terminal) => {
        if (terminal === 'frontend') throw new Error('offline');
        return [{ id: 'MSG-PARTIAL', terminal }];
      }),
    ).rejects.toThrow(/will not start/i);
    expect(store.get('MSG-PARTIAL')).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });
});

// ─── ServerClient ────────────────────────────────────────────────────────────

describe('ServerClient', () => {
  it('sends the Bearer token and maps frontmatter to tasks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          { frontmatter: { id: 'MSG-1', model: 'haiku', priority: 'high' } },
          { frontmatter: { model: 'sonnet' } }, // no id → skipped
        ],
      }),
    });
    const client = new ServerClient('http://srv:3456/', 'tok', fetchMock as unknown as typeof fetch);

    const tasks = await client.fetchUnread('backend');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://srv:3456/api/mailbox/backend/inbox?status=UNREAD&metadata=true',
      { headers: { Authorization: 'Bearer tok' } },
    );
    expect(tasks).toEqual([
      { id: 'MSG-1', terminal: 'backend', model: 'haiku', priority: 'high', type: undefined, created: undefined },
    ]);
  });

  it('throws ServerApiError with the HTTP status on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const client = new ServerClient('http://srv', 'bad', fetchMock as unknown as typeof fetch);
    await expect(client.fetchUnread('backend')).rejects.toThrowError(ServerApiError);
    await expect(client.fetchUnread('backend')).rejects.toMatchObject({ status: 401 });
  });
});

// ─── SessionLauncher (closed command set) ────────────────────────────────────

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { pipe: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { pipe: ReturnType<typeof vi.fn> };
  stdin: { written: string; write(chunk: string): void; end(): void };
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { pipe: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { pipe: vi.fn() });
  child.stdin = {
    written: '',
    write(chunk: string) {
      this.written += chunk;
    },
    end() {},
  };
  child.kill = vi.fn();
  fakeChildren.push(child);
  return child;
}

describe('SessionLauncher', () => {
  it('accepts only a server-confirmed complete_task event as durable completion', () => {
    const event = {
      type: 'tool' as const,
      provider: 'codex' as const,
      data: {
        item: {
          type: 'mcp_tool_call',
          tool: 'complete_task',
          status: 'completed',
          error: null,
          result: {
            content: [{ type: 'text', text: '{"success":true,"completed":true}' }],
          },
        },
      },
    };
    expect(isSuccessfulTaskCompletion(event)).toBe(true);
    expect(isSuccessfulTaskCompletion({
      ...event,
      data: { item: { ...event.data.item, result: { content: [{ type: 'text', text: '{"success":false}' }] } } },
    })).toBe(false);
  });

  it('POSIX: spawns Claude shell-less through its adapter, prompt via stdin', () => {
    const child = makeFakeChild();
    const spawnMock = vi.fn().mockReturnValue(child);
    const launcher = new SessionLauncher(makeConfig(), spawnMock as never, 'linux');

    const result = launcher.launch({ terminal: 'backend', messageId: 'MSG-42', model: 'haiku' });

    expect(result.started).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe('claude');
    expect(args).toEqual([
      '--print', '--output-format', 'stream-json', '--verbose',
      '--model', 'haiku', '--permission-mode', 'acceptEdits',
    ]);
    expect(opts.cwd).toBe(WORKDIR);
    expect(opts.shell).toBe(false);
    // The prompt references only terminal + message id (content fetched via MCP)
    expect(child.stdin.written).toBe(buildTaskAssignmentPrompt('backend', 'MSG-42'));
    expect(child.stdin.written).toContain('fetch_task');
  });

  it('Windows: keeps command and argv separate with shell disabled', () => {
    const child = makeFakeChild();
    const spawnMock = vi.fn().mockReturnValue(child);
    const launcher = new SessionLauncher(makeConfig(), spawnMock as never, 'win32');

    const result = launcher.launch({ terminal: 'backend', messageId: 'MSG-42', model: 'haiku' });

    expect(result.started).toBe(true);
    const [command, args, opts] = spawnMock.mock.calls[0];
    expect(command).toBe('claude');
    expect(args).toEqual([
      '--print', '--output-format', 'stream-json', '--verbose',
      '--model', 'haiku', '--permission-mode', 'acceptEdits',
    ]);
    expect(opts.shell).toBe(false);
    expect(child.stdin.written).toBe(buildTaskAssignmentPrompt('backend', 'MSG-42'));
  });

  it('falls back to default_model when the requested model is not whitelisted', () => {
    // Fresh launcher per case — one session per terminal blocks a second launch
    for (const requested of ['opus' /* not in [haiku, sonnet] */, 'gpt-99; rm -rf /']) {
      const spawnMock = vi.fn().mockReturnValue(makeFakeChild());
      const launcher = new SessionLauncher(makeConfig(), spawnMock as never, 'linux');
      launcher.launch({ terminal: 'backend', messageId: 'MSG-1', model: requested });
      expect(spawnMock.mock.calls[0][1]).toContain('sonnet');
    }
  });

  it('rejects non-whitelisted terminals and unsafe message ids', () => {
    const spawnMock = vi.fn();
    const launcher = new SessionLauncher(makeConfig(), spawnMock as never, 'linux');

    expect(launcher.launch({ terminal: 'evil', messageId: 'MSG-1' }).started).toBe(false);
    expect(launcher.launch({ terminal: 'backend', messageId: 'MSG 1; rm' }).started).toBe(false);
    expect(launcher.launch({ terminal: 'backend', messageId: '../../etc/passwd' }).started).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('runs one session per terminal; frees the slot on exit', () => {
    const child = makeFakeChild();
    const spawnMock = vi.fn().mockReturnValue(child);
    const launcher = new SessionLauncher(makeConfig(), spawnMock as never, 'linux');

    expect(launcher.launch({ terminal: 'backend', messageId: 'MSG-1' }).started).toBe(true);
    expect(launcher.isBusy('backend')).toBe(true);
    expect(fs.existsSync(path.join(makeConfig().log_dir, 'backend', 'active.json'))).toBe(true);
    expect(launcher.launch({ terminal: 'backend', messageId: 'MSG-2' }).started).toBe(false);

    child.emit('exit', 0);
    expect(launcher.isBusy('backend')).toBe(false);
    expect(fs.existsSync(path.join(makeConfig().log_dir, 'backend', 'active.json'))).toBe(false);
    expect(launcher.launch({ terminal: 'backend', messageId: 'MSG-2' }).started).toBe(true);
  });

  it('appends validated extra_args after the fixed argv', () => {
    const child = makeFakeChild();
    const spawnMock = vi.fn().mockReturnValue(child);
    const cfg = makeConfig();
    const launcher = new SessionLauncher(
      {
        ...cfg,
        providers: {
          ...cfg.providers,
          claude: { ...cfg.providers.claude!, extra_args: ['--allowedTools=Read'] },
        },
      },
      spawnMock as never,
      'linux',
    );

    launcher.launch({ terminal: 'backend', messageId: 'MSG-1' });
    expect(spawnMock.mock.calls[0][1]).toContain('--allowedTools=Read');
  });

  it('Codex: uses exec JSONL, explicit sandbox and configured MCP prompt', () => {
    const child = makeFakeChild();
    const spawnMock = vi.fn().mockReturnValue(child);
    const cfg = RunnerConfigSchema.parse({
      server_url: 'http://localhost:3466',
      token: 'test-token',
      default_provider: 'codex',
      mcp_server_name: 'joinerytech',
      providers: {
        codex: {
          binary: 'codex',
          auth_env_var: 'NEXUS_AGENT_TOKEN',
          sandbox: 'workspace-write',
          skip_git_repo_check: true,
        },
      },
      log_dir: path.join(TMP_DIR, 'logs'),
      terminals: {
        backend: {
          workdir: WORKDIR,
          models: ['gpt-5.6-terra'],
          default_model: 'gpt-5.6-terra',
          credential_env: 'NEXUS_AGENT_TOKEN_BACKEND',
        },
      },
    }) as RunnerConfig;
    process.env.NEXUS_AGENT_TOKEN_BACKEND = 'terminal-scoped-secret';
    const launcher = new SessionLauncher(cfg, spawnMock as never, 'win32');

    const result = launcher.launch({ terminal: 'backend', messageId: 'MSG-CODEX-1' });

    expect(result).toMatchObject({ started: true, provider: 'codex', model: 'gpt-5.6-terra' });
    const [command, args, opts] = spawnMock.mock.calls[0];
    expect(command).toBe('codex');
    expect(args).toEqual(expect.arrayContaining([
      'exec', '--json', '--ephemeral', '--sandbox', 'workspace-write',
      '--model', 'gpt-5.6-terra', '--skip-git-repo-check', '-',
    ]));
    expect(opts).toMatchObject({ shell: false, detached: true, windowsHide: true });
    expect(opts.env.NEXUS_AGENT_TOKEN).toBe('terminal-scoped-secret');
    expect(child.stdin.written).toContain('mcp__joinerytech__fetch_task');
    delete process.env.NEXUS_AGENT_TOKEN_BACKEND;
  });

  it('fails closed when a configured terminal credential is unavailable', () => {
    const cfg = makeConfig();
    cfg.providers.claude = {
      ...cfg.providers.claude!,
      auth_env_var: 'CLAUDE_MCP_TOKEN',
    };
    cfg.terminals.backend.credential_env = 'MISSING_BACKEND_TOKEN';
    const spawnMock = vi.fn();
    const launcher = new SessionLauncher(cfg, spawnMock as never, 'linux');

    expect(launcher.launch({ terminal: 'backend', messageId: 'MSG-AUTH-1' })).toEqual({
      started: false,
      reason: 'credential source unavailable: MISSING_BACKEND_TOKEN',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('cancels an active process tree through the supervisor hook', () => {
    const child = makeFakeChild();
    const terminateMock = vi.fn();
    const launcher = new SessionLauncher(
      makeConfig(),
      vi.fn().mockReturnValue(child) as never,
      'linux',
      terminateMock,
    );
    launcher.launch({ terminal: 'backend', messageId: 'MSG-CANCEL-1' });

    expect(launcher.cancel('backend', 'operator-cancel')).toBe(true);
    expect(terminateMock).toHaveBeenCalledWith(child, 'linux');
  });
});

// ─── pollOnce decision logic ─────────────────────────────────────────────────

describe('pollOnce', () => {
  function makeDeps(tasksByTerminal: Record<string, { id: string; model?: string }[]>) {
    const store = new ProcessedStore(path.join(TMP_DIR, `poll-${Math.random().toString(36).slice(2)}.json`));
    return {
      store,
      fetchUnread: vi.fn(async (t: string) =>
        (tasksByTerminal[t] || []).map((task) => ({ ...task, terminal: t })),
      ),
      claimTask: vi.fn(async () => undefined),
      releaseTask: vi.fn(async () => undefined),
      launch: vi.fn().mockReturnValue({ started: true }),
      isBusy: vi.fn().mockReturnValue(false),
    };
  }

  it('launches new tasks once and dedups on the next tick', async () => {
    const cfg = makeConfig();
    const deps = makeDeps({ backend: [{ id: 'MSG-1', model: 'haiku' }] });

    const first = await pollOnce(cfg, deps);
    expect(first.launched).toBe(1);
    expect(deps.launch).toHaveBeenCalledWith({ terminal: 'backend', messageId: 'MSG-1', model: 'haiku' });

    const second = await pollOnce(cfg, deps);
    expect(second.launched).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('skips tasks while the terminal is busy, without consuming attempts', async () => {
    const cfg = makeConfig();
    const deps = makeDeps({ backend: [{ id: 'MSG-1' }] });
    deps.isBusy.mockReturnValue(true);

    const res = await pollOnce(cfg, deps);
    expect(res.launched).toBe(0);
    expect(res.skipped).toBe(1);
    expect(deps.launch).not.toHaveBeenCalled();
    // Not recorded → still eligible when the terminal frees up
    expect(deps.store.shouldLaunch('MSG-1', { maxAttempts: 3, retryCooldownMs: 0 })).toBe(true);
  });

  it('reports failed terminals instead of throwing', async () => {
    const cfg = makeConfig();
    const deps = makeDeps({});
    deps.fetchUnread.mockRejectedValue(new ServerApiError(401, 'nope'));

    const res = await pollOnce(cfg, deps);
    expect(res.failedTerminals).toEqual(['backend']);
    expect(res.launched).toBe(0);
  });

  it('does not consume an attempt when the launcher refuses', async () => {
    const cfg = makeConfig();
    const deps = makeDeps({ backend: [{ id: 'MSG-1' }] });
    deps.launch.mockReturnValue({ started: false, reason: 'workdir missing' });

    const res = await pollOnce(cfg, deps);
    expect(res.launched).toBe(0);
    expect(deps.releaseTask).toHaveBeenCalledWith('backend', 'MSG-1');
    expect(deps.store.shouldLaunch('MSG-1', { maxAttempts: 3, retryCooldownMs: 0 })).toBe(true);
  });

  it('does not launch when the server refuses the task claim', async () => {
    const cfg = makeConfig();
    const deps = makeDeps({ backend: [{ id: 'MSG-1' }] });
    deps.claimTask.mockRejectedValue(new ServerApiError(409, 'already claimed'));

    const res = await pollOnce(cfg, deps);
    expect(res.launched).toBe(0);
    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.store.get('MSG-1')).toBeUndefined();
  });
});
