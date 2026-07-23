import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  NodePtyHost,
  parseLinuxProcessStat,
  type PtyDisposable,
  type PtyExitEvent,
  type PtyProcessIdentity,
  type PtyProcessTreeAdapter,
  type PtyTerminationSignal,
} from '../../runner/ptyHost';
import {
  readLinuxIdentitiesBounded,
  selectSafeLinuxSurvivorsAfterReuse,
} from '../../runner/ptyLinuxProcess';
import {
  selectWindowsDescendants,
  WINDOWS_IDENTITY_SAFE_TERMINATION_COMMAND,
} from '../../runner/ptyWindowsProcess';

interface FakeNativePty {
  pid: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  _close: ReturnType<typeof vi.fn>;
  _agent: {
    _useConpty: true;
    _useConptyDll: false;
    _pty: number;
    _inSocket: { destroy: ReturnType<typeof vi.fn> };
    _outSocket: { destroy: ReturnType<typeof vi.fn> };
    _ptyNative: { kill: ReturnType<typeof vi.fn> };
    _conoutSocketWorker: {
      _isDisposed: boolean;
      _worker: { terminate: ReturnType<typeof vi.fn> };
    };
  };
  emitData(data: string): void;
  emitExit(event: PtyExitEvent): void;
}

function makeNative(pid = 700): FakeNativePty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  return {
    pid,
    onData: vi.fn((listener) => {
      dataListeners.add(listener);
      return { dispose: vi.fn(() => dataListeners.delete(listener)) };
    }),
    onExit: vi.fn((listener) => {
      exitListeners.add(listener);
      return { dispose: vi.fn(() => exitListeners.delete(listener)) };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _close: vi.fn(),
    _agent: {
      _useConpty: true,
      _useConptyDll: false,
      _pty: 41,
      _inSocket: { destroy: vi.fn() },
      _outSocket: { destroy: vi.fn() },
      _ptyNative: { kill: vi.fn() },
      _conoutSocketWorker: {
        _isDisposed: false,
        _worker: { terminate: vi.fn(async () => 0) },
      },
    },
    emitData: (data) => {
      for (const listener of [...dataListeners]) listener(data);
    },
    emitExit: (event) => {
      for (const listener of [...exitListeners]) listener(event);
    },
  };
}

function makeProcessTree(
  platform: 'linux' | 'win32',
  events: string[],
  snapshots: readonly (readonly number[])[],
  liveTokens = new Map<number, string>(),
): PtyProcessTreeAdapter {
  let snapshotIndex = 0;
  let captureIndex = 0;
  const identity = (pid: number): PtyProcessIdentity => ({
    pid,
    parentPid: pid === 700 ? 1 : 700,
    creationToken: liveTokens.get(pid) ?? `created:${pid}`,
    sessionId: platform === 'linux' ? 700 : undefined,
  });
  liveTokens.set(700, liveTokens.get(700) ?? 'created:700');
  return {
    platform,
    captureRootIdentity: vi.fn(async (pid: number) => {
      if (captureIndex++ === 0) events.push(`capture:${pid}`);
      return identity(pid);
    }),
    snapshotDescendants: vi.fn(async (root: PtyProcessIdentity) => {
      events.push(`snapshot:${root.pid}:${root.sessionId ?? 'none'}`);
      return (snapshots[snapshotIndex++] ?? []).map((pid) => {
        liveTokens.set(pid, liveTokens.get(pid) ?? `created:${pid}`);
        return identity(pid);
      });
    }),
    signal: vi.fn(async (processIdentity: PtyProcessIdentity, signal: PtyTerminationSignal) => {
      if (liveTokens.get(processIdentity.pid) !== processIdentity.creationToken) {
        events.push(`reuse-skip:${processIdentity.pid}`);
        return;
      }
      events.push(`${signal}:${processIdentity.pid}`);
    }),
    wait: vi.fn(async (milliseconds: number) => {
      events.push(`wait:${milliseconds}`);
    }),
  };
}

const SPEC = {
  executable: 'codex',
  args: ['--model', 'gpt-5.6-terra'],
  cwd: 'C:\\work dir\\árvíz',
  env: { TERM: 'xterm-256color', TOKEN: undefined },
  cols: 100,
  rows: 32,
} as const;

describe('NodePtyHost', () => {
  it('parses Linux procfs identity from ppid, SID, and starttime fields', () => {
    const fields = ['S', '17', '700', '700', ...Array(15).fill('0'), '987654'];
    const identity = parseLinuxProcessStat(
      700,
      `700 (provider ) with parens) ${fields.join(' ')}`,
    );

    expect(identity).toEqual({
      pid: 700,
      parentPid: 17,
      sessionId: 700,
      creationToken: 'linux:987654',
    });
    expect(parseLinuxProcessStat(700, 'malformed')).toBeUndefined();
  });

  it('bounds Linux procfs reads and fails closed on reader failure', async () => {
    const pids = Array.from({ length: 2_000 }, (_, index) => index + 1);
    let active = 0;
    let maxActive = 0;
    const identities = await readLinuxIdentitiesBounded(
      pids,
      async (pid) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        active--;
        return {
          pid,
          parentPid: 1,
          sessionId: 1,
          creationToken: `linux:${pid}`,
        };
      },
      64,
    );

    expect(identities).toHaveLength(2_000);
    expect(maxActive).toBe(64);
    await expect(
      readLinuxIdentitiesBounded(
        pids,
        async (pid) => {
          await Promise.resolve();
          if (pid === 17) throw Object.assign(new Error('too many files'), { code: 'EMFILE' });
          return {
            pid,
            parentPid: 1,
            sessionId: 1,
            creationToken: `linux:${pid}`,
          };
        },
        32,
      ),
    ).rejects.toMatchObject({ code: 'EMFILE' });
  });

  it('only selects old-SID survivors created before a recycled Linux root', () => {
    const oldRoot: PtyProcessIdentity = {
      pid: 700,
      parentPid: 1,
      sessionId: 700,
      creationToken: 'linux:100',
    };
    const replacement: PtyProcessIdentity = {
      ...oldRoot,
      creationToken: 'linux:200',
    };
    const records: PtyProcessIdentity[] = [
      replacement,
      { pid: 701, parentPid: 700, sessionId: 700, creationToken: 'linux:150' },
      { pid: 702, parentPid: 700, sessionId: 700, creationToken: 'linux:250' },
    ];

    expect(
      selectSafeLinuxSurvivorsAfterReuse(records, oldRoot, replacement).map(
        ({ pid }) => pid,
      ),
    ).toEqual([701]);
  });

  it('keeps absent-root Windows survivors and rejects a recycled root identity', () => {
    const root: PtyProcessIdentity = {
      pid: 700,
      parentPid: 1,
      creationToken: 'windows:old-root',
    };
    const survivors: PtyProcessIdentity[] = [
      { pid: 703, parentPid: 700, creationToken: 'windows:child' },
      { pid: 704, parentPid: 703, creationToken: 'windows:grandchild' },
      { pid: 900, parentPid: 1, creationToken: 'windows:unrelated' },
    ];

    expect(selectWindowsDescendants(survivors, root).map(({ pid }) => pid)).toEqual([
      704, 703,
    ]);
    expect(() =>
      selectWindowsDescendants(
        [
          ...survivors,
          { pid: 700, parentPid: 1, creationToken: 'windows:reused-root' },
        ],
        root,
      ),
    ).toThrow(/ownership indeterminate/);
  });

  it.skipIf(process.platform !== 'win32')(
    'revalidates CreationDate on the same CIM object immediately before terminate',
    () => {
      const run = (preKillDate: string): number => {
        const initialDate = '2026-01-01T00:00:00.0000000Z';
        const prelude = [
          '$global:NexusTerminateCount=0',
          `function Get-CimInstance { param([string]$ClassName,[string]$Filter); $date=if ([string]::IsNullOrEmpty($Filter)) { '${initialDate}' } else { '${preKillDate}' }; [pscustomobject]@{ ProcessId=700; CreationDate=[datetime]::Parse($date) } }`,
          'function Invoke-CimMethod { param($InputObject,[string]$MethodName); $global:NexusTerminateCount++; [pscustomobject]@{ ReturnValue=0 } }',
        ].join('; ');
        const command = `${prelude}; ${WINDOWS_IDENTITY_SAFE_TERMINATION_COMMAND}; [Console]::Out.Write($global:NexusTerminateCount)`;
        const result = spawnSync(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          {
            encoding: 'utf8',
            input: JSON.stringify([
              {
                pid: 700,
                parentPid: 1,
                creationToken: `windows:${initialDate}`,
              },
            ]),
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          },
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        return Number(result.stdout);
      };

      expect(run('2026-01-01T00:00:01.0000000Z')).toBe(0);
      expect(run('2026-01-01T00:00:00.0000000Z')).toBe(1);
      expect(WINDOWS_IDENTITY_SAFE_TERMINATION_COMMAND).not.toContain('Stop-Process');
    },
  );

  it('keeps executable and argv separate and exposes provider-neutral session IO', async () => {
    const native = makeNative();
    const spawn = vi.fn(() => native);
    const processTree = makeProcessTree('win32', [], []);
    const host = new NodePtyHost({ nativePty: { spawn }, processTree });

    const session = await host.spawn(SPEC);
    const dataListener = vi.fn();
    const exitListener = vi.fn();
    session.onData(dataListener);
    session.onExit(exitListener);
    native.emitData('live-data');
    native.emitExit({ exitCode: 0 });
    session.write('prompt\r');
    session.resize(120, 40);

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['--model', 'gpt-5.6-terra'],
      expect.objectContaining({
        cwd: SPEC.cwd,
        env: SPEC.env,
        cols: 100,
        rows: 32,
        name: 'xterm-256color',
        useConpty: true,
        useConptyDll: false,
      }),
    );
    expect(Array.isArray(spawn.mock.calls[0][1])).toBe(true);
    expect(dataListener).toHaveBeenCalledWith('live-data');
    expect(exitListener).toHaveBeenCalledWith({ exitCode: 0 });
    expect(native.write).toHaveBeenCalledWith('prompt\r');
    expect(native.resize).toHaveBeenCalledWith(120, 40);
  });

  it('replays capture-time data exactly once across synchronous listener registration', async () => {
    const native = makeNative();
    const originalOnData = native.onData;
    let dataRegistration = 0;
    native.onData = vi.fn((listener) => {
      const disposable = originalOnData(listener);
      dataRegistration++;
      if (dataRegistration === 2) native.emitData('sync-registration');
      return disposable;
    });
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const processTree = makeProcessTree('win32', [], []);
    const originalCapture = processTree.captureRootIdentity;
    let captureCount = 0;
    processTree.captureRootIdentity = vi.fn(async (pid) => {
      captureCount++;
      if (captureCount === 1) await captureGate;
      return originalCapture(pid);
    });
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
    });

    const spawning = host.spawn(SPEC);
    await Promise.resolve();
    native.emitData('capture-prompt');
    releaseCapture();
    const session = await spawning;
    const received: string[] = [];
    session.onData((data) => received.push(data));
    session.onExit(() => undefined);

    expect(received).toEqual(['capture-prompt', 'sync-registration']);
  });

  it('buffers an exit between host return and manager listener registration', async () => {
    const native = makeNative();
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree: makeProcessTree('win32', [], []),
    }).spawn(SPEC);
    native.emitExit({ exitCode: 7 });
    const exits: number[] = [];

    session.onData(() => undefined);
    session.onExit((event) => exits.push(event.exitCode));

    expect(exits).toEqual([7]);
  });

  it('fails startup and awaits full cleanup on early-event buffer overflow', async () => {
    const native = makeNative();
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const processTree = makeProcessTree('win32', [], []);
    const originalCapture = processTree.captureRootIdentity;
    let captureCount = 0;
    processTree.captureRootIdentity = vi.fn(async (pid) => {
      captureCount++;
      if (captureCount === 1) await captureGate;
      return originalCapture(pid);
    });
    const spawning = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
    }).spawn(SPEC);
    await Promise.resolve();
    native.emitData('x'.repeat(64 * 1024 + 1));
    releaseCapture();

    await expect(spawning).rejects.toThrow(/early-event buffer exceeded 65536 bytes/);

    expect(native._agent._ptyNative.kill).toHaveBeenCalledWith(41, false);
    expect(native._agent._conoutSocketWorker._worker.terminate).toHaveBeenCalledOnce();
    expect(processTree.signal).toHaveBeenCalledWith(
      expect.objectContaining({ pid: native.pid }),
      'SIGKILL',
    );
  });

  it('terminates a Linux forkpty session descendant-first with TERM, grace, then KILL', async () => {
    const events: string[] = [];
    const native = makeNative();
    const processTree = makeProcessTree('linux', events, [[703, 702], [703]]);
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 125,
    });

    const session = await host.spawn(SPEC);
    await session.kill();

    expect(events).toEqual([
      'capture:700',
      'snapshot:700:700',
      'SIGTERM:703',
      'SIGTERM:702',
      'SIGTERM:700',
      'wait:125',
      'snapshot:700:700',
      'SIGKILL:703',
      'SIGKILL:702',
      'SIGKILL:700',
    ]);
    expect(native.kill).not.toHaveBeenCalled();
  });

  it('kills a same-session survivor discovered only after the Linux root exits', async () => {
    const events: string[] = [];
    const native = makeNative();
    const processTree = makeProcessTree('linux', events, [[703], [704]]);
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 25,
    }).spawn(SPEC);

    await session.kill();

    expect(events).toEqual([
      'capture:700',
      'snapshot:700:700',
      'SIGTERM:703',
      'SIGTERM:700',
      'wait:25',
      'snapshot:700:700',
      'SIGKILL:704',
      'SIGKILL:703',
      'SIGKILL:700',
    ]);
  });

  it('skips a Linux root PID reused with a different creation identity', async () => {
    const events: string[] = [];
    const liveTokens = new Map<number, string>();
    const native = makeNative();
    const processTree = makeProcessTree('linux', events, [[703]], liveTokens);
    const originalSnapshot = processTree.snapshotDescendants;
    let snapshotCount = 0;
    processTree.snapshotDescendants = vi.fn(async (root) => {
      snapshotCount++;
      if (snapshotCount === 2 && liveTokens.get(root.pid) !== root.creationToken) {
        events.push(`root-reuse-skip:${root.pid}`);
        throw new Error('Linux PTY root ownership indeterminate after identity reuse');
      }
      return await originalSnapshot(root);
    });
    processTree.wait = vi.fn(async (milliseconds: number) => {
      events.push(`wait:${milliseconds}`);
      liveTokens.set(700, 'unrelated-new-root');
    });
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
    }).spawn(SPEC);

    await expect(session.kill()).rejects.toThrow(/ownership indeterminate/);

    expect(events).toEqual([
      'capture:700',
      'snapshot:700:700',
      'SIGTERM:703',
      'SIGTERM:700',
      'wait:0',
      'root-reuse-skip:700',
      'SIGKILL:703',
      'reuse-skip:700',
    ]);
    expect(events).not.toContain('SIGKILL:704');
  });

  it('snapshots Windows descendants before closing ConPTY, then cleans the saved tree', async () => {
    const events: string[] = [];
    const native = makeNative();
    native._agent._inSocket.destroy.mockImplementation(() => events.push('conin-close'));
    native._agent._ptyNative.kill.mockImplementation(() => events.push('conpty-close'));
    native._agent._outSocket.destroy.mockImplementation(() => events.push('conout-close'));
    native._agent._conoutSocketWorker._worker.terminate.mockImplementation(async () => {
      events.push('worker-terminate');
      return 0;
    });
    native._close.mockImplementation(() => events.push('terminal-close'));
    const processTree = makeProcessTree('win32', events, [[703, 702]]);
    processTree.signalMany = vi.fn(async (identities, signal) => {
      events.push(`bulk:${signal}:${identities.map(({ pid }) => pid).join(',')}`);
    });
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 75,
    });

    await (await host.spawn(SPEC)).kill();

    expect(events).toEqual([
      'capture:700',
      'snapshot:700:none',
      'conin-close',
      'conpty-close',
      'conout-close',
      'worker-terminate',
      'terminal-close',
      'wait:75',
      'bulk:SIGKILL:703,702,700',
    ]);
    expect(processTree.signal).not.toHaveBeenCalled();
    expect(processTree.signalMany).toHaveBeenCalledOnce();
    expect(native.kill).not.toHaveBeenCalled();
    expect(native._agent._conoutSocketWorker._worker.terminate).toHaveBeenCalledOnce();
  });

  it('continues handle and worker cleanup when socket error-listener binding throws', async () => {
    const native = makeNative();
    Reflect.set(
      native._agent._inSocket,
      'once',
      vi.fn(() => {
        throw new Error('listener bind failed');
      }),
    );
    const processTree = makeProcessTree('win32', [], [[]]);
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
    }).spawn(SPEC);

    await expect(session.kill()).rejects.toThrow(/listener bind failed/);

    expect(native._agent._ptyNative.kill).toHaveBeenCalledWith(41, false);
    expect(native._agent._conoutSocketWorker._worker.terminate).toHaveBeenCalledOnce();
    expect(native._close).toHaveBeenCalledOnce();
  });

  it('makes concurrent kill calls idempotent', async () => {
    const events: string[] = [];
    const native = makeNative();
    native._agent._ptyNative.kill.mockImplementation(() => events.push('conpty-close'));
    const processTree = makeProcessTree('win32', events, [[]]);
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
    }).spawn(SPEC);

    await Promise.all([session.kill(), session.kill()]);

    expect(events).toEqual([
      'capture:700',
      'snapshot:700:none',
      'conpty-close',
      'wait:0',
      'SIGKILL:700',
    ]);
  });

  it('enforces an overall hard deadline for asynchronous Windows cleanup', async () => {
    const native = makeNative();
    const processTree = makeProcessTree('win32', [], []);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    processTree.snapshotDescendants = vi.fn(
      () => new Promise<readonly PtyProcessIdentity[]>(() => undefined),
    );
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
      cleanupDeadlineMs: 20,
    }).spawn(SPEC);
    const startedAt = performance.now();
    const result = session.kill();
    const deadlineCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 20);
    const deadlineTimer = setTimeoutSpy.mock.results[
      setTimeoutSpy.mock.calls.indexOf(deadlineCall!)
    ]?.value as NodeJS.Timeout;

    expect(deadlineTimer.hasRef()).toBe(true);
    await expect(result).rejects.toThrow(/hard deadline \(20ms\)/);

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(native.kill).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('rejects cleanup deadlines that could overflow or mask stuck cleanup', () => {
    expect(
      new NodePtyHost({ processTree: makeProcessTree('win32', [], []) })
        .cleanupDeadlineMs,
    ).toBe(15_000);
    expect(
      new NodePtyHost({
        processTree: makeProcessTree('win32', [], []),
        cleanupDeadlineMs: 60_000,
      }).cleanupDeadlineMs,
    ).toBe(60_000);
    expect(
      () =>
        new NodePtyHost({
          processTree: makeProcessTree('win32', [], []),
          cleanupDeadlineMs: 2_147_483_648,
        }),
    ).toThrow(/between 1 and 60000/);
    expect(
      () =>
        new NodePtyHost({
          processTree: makeProcessTree('win32', [], []),
          cleanupDeadlineMs: 60_001,
        }),
    ).toThrow(/between 1 and 60000/);
  });

  it('starts multiple async captures and cleanups concurrently without starving timers', async () => {
    let nextPid = 700;
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let captureStarts = 0;
    const processTree = makeProcessTree('linux', [], []);
    processTree.captureRootIdentity = vi.fn(async (pid) => {
      captureStarts++;
      await captureGate;
      return {
        pid,
        parentPid: 1,
        creationToken: `linux:${pid}`,
        sessionId: pid,
      };
    });
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => makeNative(nextPid++)) },
      processTree,
      terminationGraceMs: 0,
      cleanupDeadlineMs: 1_000,
    });

    const spawnPromises = Array.from({ length: 3 }, () => host.spawn(SPEC));
    let spawnTimerFired = false;
    const spawnTimerBarrier = new Promise<void>((resolve) => {
      setTimeout(() => {
        spawnTimerFired = true;
        resolve();
      }, 0);
    });
    await spawnTimerBarrier;

    expect(captureStarts).toBe(3);
    expect(spawnTimerFired).toBe(true);
    releaseCapture();
    const sessions = await Promise.all(spawnPromises);

    let snapshotStarts = 0;
    let releaseSnapshots!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshots = resolve;
    });
    processTree.snapshotDescendants = vi.fn(async () => {
      snapshotStarts++;
      if (snapshotStarts <= 3) await snapshotGate;
      return [];
    });
    const kills = sessions.map((session) => session.kill());
    let cleanupTimerFired = false;
    const cleanupTimerBarrier = new Promise<void>((resolve) => {
      setTimeout(() => {
        cleanupTimerFired = true;
        resolve();
      }, 0);
    });
    await cleanupTimerBarrier;

    expect(snapshotStarts).toBe(3);
    expect(cleanupTimerFired).toBe(true);
    releaseSnapshots();
    await Promise.all(kills);
    expect(processTree.signal).toHaveBeenCalledTimes(6);
  });

  it('awaits ownership-safe Windows unwind when identity capture fails', async () => {
    const native = makeNative();
    const alive = new Set([native.pid]);
    native._agent._ptyNative.kill.mockImplementation(() => alive.delete(native.pid));
    const processTree = makeProcessTree('win32', [], []);
    processTree.captureRootIdentity = vi.fn(async () => undefined);
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
    });

    await expect(host.spawn(SPEC)).rejects.toThrow(/ownership-safe ConPTY unwind completed/);

    expect([...alive]).toEqual([]);
    expect(native.kill).not.toHaveBeenCalled();
    expect(native._agent._ptyNative.kill).toHaveBeenCalledWith(41, false);
    expect(native._agent._conoutSocketWorker._worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['synchronous', 'queued'] as const)(
    'rejects a %s provider exit during capture with identity-safe full cleanup',
    async (delivery) => {
      const native = makeNative();
      const dispose = vi.fn();
      native.onExit = vi.fn((listener) => {
        if (delivery === 'synchronous') listener({ exitCode: 1 });
        else queueMicrotask(() => listener({ exitCode: 1 }));
        return { dispose };
      });
      const processTree = makeProcessTree('win32', [], [[703]]);
      const host = new NodePtyHost({
        nativePty: { spawn: vi.fn(() => native) },
        processTree,
      });

      await expect(host.spawn(SPEC)).rejects.toThrow(/provider exited during identity capture/);

      expect(dispose).toHaveBeenCalledOnce();
      expect(processTree.signal).toHaveBeenCalledWith(
        expect.objectContaining({ pid: native.pid }),
        'SIGKILL',
      );
      expect(processTree.signal).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 703 }),
        'SIGKILL',
      );
      expect(native.kill).not.toHaveBeenCalled();
      expect(native._agent._ptyNative.kill).toHaveBeenCalledWith(41, false);
      expect(native._agent._conoutSocketWorker._worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it('rejects a recycled root identity during capture confirmation', async () => {
    const native = makeNative();
    const original: PtyProcessIdentity = {
      pid: native.pid,
      parentPid: 1,
      creationToken: 'windows:original',
    };
    const recycled: PtyProcessIdentity = {
      ...original,
      creationToken: 'windows:unrelated-recycled',
    };
    const processTree = makeProcessTree('win32', [], []);
    processTree.captureRootIdentity = vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(recycled);
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
    });

    await expect(host.spawn(SPEC)).rejects.toThrow(/identity changed during capture/);

    expect(processTree.signal).not.toHaveBeenCalled();
    expect(native.kill).not.toHaveBeenCalled();
    expect(native._agent._ptyNative.kill).toHaveBeenCalledWith(41, false);
  });

  it('validates pinned Windows ownership shape before capture and unwinds on drift', async () => {
    const events: string[] = [];
    const native = makeNative();
    (native._agent as { _useConptyDll: boolean })._useConptyDll = true;
    native._agent._ptyNative.kill.mockImplementation(() => events.push('handle-close'));
    native._agent._conoutSocketWorker._worker.terminate.mockImplementation(async () => {
      events.push('worker-terminate');
      return 0;
    });
    const processTree = makeProcessTree('win32', events, []);
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
    });

    await expect(host.spawn(SPEC)).rejects.toThrow(/Unsupported node-pty Windows ownership shape/);

    expect(processTree.captureRootIdentity).not.toHaveBeenCalled();
    expect(events).toEqual(['handle-close', 'worker-terminate']);
    expect(native._agent._ptyNative.kill).toHaveBeenCalledWith(41, true);
    expect(native.kill).not.toHaveBeenCalled();
  });

  const callableShapeDrifts: Array<[string, (native: FakeNativePty) => void]> = [
    ['non-positive PTY id', (native) => Reflect.set(native._agent, '_pty', 0)],
    [
      'unsafe PTY id',
      (native) => Reflect.set(native._agent, '_pty', Number.MAX_SAFE_INTEGER + 1),
    ],
    [
      'non-callable native kill',
      (native) => Reflect.set(native._agent._ptyNative, 'kill', undefined),
    ],
    [
      'non-callable conin destroy',
      (native) => Reflect.set(native._agent._inSocket, 'destroy', undefined),
    ],
    [
      'non-callable conout destroy',
      (native) => Reflect.set(native._agent._outSocket, 'destroy', undefined),
    ],
    [
      'non-callable conin once',
      (native) => Reflect.set(native._agent._inSocket, 'once', true),
    ],
    [
      'non-callable conout once',
      (native) => Reflect.set(native._agent._outSocket, 'once', true),
    ],
    [
      'non-callable worker terminate',
      (native) =>
        Reflect.set(native._agent._conoutSocketWorker._worker, 'terminate', undefined),
    ],
  ];

  it.each(callableShapeDrifts)(
    'fails preflight before identity capture for %s drift',
    async (_label, applyDrift) => {
      const native = makeNative();
      applyDrift(native);
      const processTree = makeProcessTree('win32', [], []);
      const host = new NodePtyHost({
        nativePty: { spawn: vi.fn(() => native) },
        processTree,
      });

      await expect(host.spawn(SPEC)).rejects.toThrow(
        /Unsupported node-pty Windows ownership shape/,
      );

      expect(processTree.captureRootIdentity).not.toHaveBeenCalled();
      expect(native.kill).not.toHaveBeenCalled();
    },
  );

  it('never signals a descendant PID whose creation identity was recycled', async () => {
    const events: string[] = [];
    const liveTokens = new Map<number, string>([[703, 'original-child']]);
    const native = makeNative();
    native._agent._ptyNative.kill.mockImplementation(() => {
      events.push('conpty-close');
      liveTokens.set(703, 'unrelated-reused-process');
    });
    const processTree = makeProcessTree('win32', events, [[703]], liveTokens);
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
    }).spawn(SPEC);

    await session.kill();

    expect(events).toEqual([
      'capture:700',
      'snapshot:700:none',
      'conpty-close',
      'wait:0',
      'reuse-skip:703',
      'SIGKILL:700',
    ]);
  });

  it('rejects Windows cleanup when the root PID is recycled beside an old child', async () => {
    const events: string[] = [];
    const liveTokens = new Map<number, string>();
    const native = makeNative();
    native._agent._ptyNative.kill.mockImplementation(() => {
      liveTokens.set(700, 'windows:reused-root');
    });
    const processTree = makeProcessTree('win32', events, [], liveTokens);
    processTree.snapshotDescendants = vi.fn(async (root) =>
      selectWindowsDescendants(
        [
          {
            pid: 700,
            parentPid: 1,
            creationToken: 'windows:reused-root',
          },
          { pid: 703, parentPid: 700, creationToken: 'windows:old-child' },
        ],
        root,
      ),
    );
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
    }).spawn(SPEC);

    await expect(session.kill()).rejects.toThrow(/ownership indeterminate/);

    expect(events).toContain('reuse-skip:700');
    expect(events).not.toContain('SIGKILL:703');
  });

  it('attempts native and root cleanup and reports an enumeration failure', async () => {
    const events: string[] = [];
    const native = makeNative();
    native._agent._ptyNative.kill.mockImplementation(() => events.push('conpty-close'));
    const processTree = makeProcessTree('win32', events, []);
    processTree.snapshotDescendants = vi.fn(async () => {
      events.push('snapshot-failed');
      throw new Error('process enumeration unavailable');
    });
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
    }).spawn(SPEC);

    await expect(session.kill()).rejects.toThrow(/process enumeration unavailable/);
    expect(events).toEqual([
      'capture:700',
      'snapshot-failed',
      'conpty-close',
      'wait:0',
      'SIGKILL:700',
    ]);
    expect(native.kill).not.toHaveBeenCalled();
    expect(native._agent._ptyNative.kill).toHaveBeenCalledOnce();
  });

  it('attempts identity-safe root signals without native fallback after enumeration failure', async () => {
    const events: string[] = [];
    const native = makeNative();
    const processTree = makeProcessTree('linux', events, []);
    processTree.snapshotDescendants = vi.fn(async () => {
      events.push('snapshot-failed');
      throw new Error('process enumeration unavailable');
    });
    processTree.signal = vi.fn(async (identity: PtyProcessIdentity, signal) => {
      events.push(`${signal}-attempt:${identity.pid}`);
      throw new Error('identity revalidation unavailable');
    });
    const session = await new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
      terminationGraceMs: 0,
    }).spawn(SPEC);

    const result = session.kill();
    await expect(result).rejects.toThrow(/process enumeration unavailable/);
    await expect(result).rejects.toThrow(/identity revalidation unavailable/);
    expect(events).toEqual([
      'capture:700',
      'snapshot-failed',
      'SIGTERM-attempt:700',
      'wait:0',
      'snapshot-failed',
      'SIGKILL-attempt:700',
    ]);
    expect(native.kill).not.toHaveBeenCalled();
  });

  it('fails indeterminate without raw PID kill when Linux identity capture throws', async () => {
    const native = makeNative();
    const processTree = makeProcessTree('linux', [], []);
    processTree.captureRootIdentity = vi.fn(async () => {
      throw new Error('process table unavailable');
    });
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
    });

    await expect(host.spawn(SPEC)).rejects.toThrow(
      /process table unavailable; cleanup ownership indeterminate; runner control-group termination required/,
    );
    expect(native.kill).not.toHaveBeenCalled();
  });

  it('fails indeterminate without raw PID kill when direct Linux capture is absent', async () => {
    const native = makeNative();
    const processTree = makeProcessTree('linux', [], []);
    processTree.captureRootIdentity = vi.fn(async () => undefined);
    const host = new NodePtyHost({
      nativePty: { spawn: vi.fn(() => native) },
      processTree,
    });

    await expect(host.spawn(SPEC)).rejects.toThrow(/cleanup ownership indeterminate/);
    expect(processTree.captureRootIdentity).toHaveBeenCalledWith(native.pid);
    expect(native.kill).not.toHaveBeenCalled();
  });

  it('rejects unsafe native inputs and invalid terminal dimensions before spawn', async () => {
    const spawn = vi.fn(() => makeNative());
    const host = new NodePtyHost({
      nativePty: { spawn },
      processTree: makeProcessTree('win32', [], []),
    });

    await expect(host.spawn({ ...SPEC, executable: 'bad\0command' })).rejects.toThrow(
      /NUL-free/,
    );
    await expect(host.spawn({ ...SPEC, args: ['bad\0argument'] })).rejects.toThrow(/NUL/);
    await expect(host.spawn({ ...SPEC, cols: 0 })).rejects.toThrow(/positive integer/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
