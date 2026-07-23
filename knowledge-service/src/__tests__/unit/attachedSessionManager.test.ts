import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttachedLifecycleError,
  AttachedSessionManager,
  type AttachedSessionManagerOptions,
  type AttachedStableIdleProof,
  type AttachedTerminalPolicy,
} from '../../runner/attachedSessionManager';
import type {
  AttachedTaskMarker,
  AttachedTaskMarkerStore,
} from '../../runner/attachedTaskMarkerStore';
import type {
  PtyDisposable,
  PtyExitEvent,
  PtyHost,
  PtySession,
  PtySpawnSpec,
} from '../../runner/ptyHost';
import type { RunnerCompletionReceipt } from '../../runner/serverClient';

type Operation =
  | { kind: 'save'; marker: AttachedTaskMarker }
  | { kind: 'clear'; terminal: string; messageId: string; generation: number }
  | { kind: 'write'; pid: number; data: string };

class MemoryMarkerStore implements AttachedTaskMarkerStore {
  readonly values = new Map<string, AttachedTaskMarker>();
  readonly operations: Operation[];
  saveCalls = 0;
  failSaveCall?: number;
  failClear = false;
  loadError?: Error;
  clearError?: Error;

  constructor(initial: readonly AttachedTaskMarker[] = [], operations: Operation[] = []) {
    this.operations = operations;
    for (const value of initial) this.values.set(value.terminal, structuredClone(value));
  }

  load(terminal: string): AttachedTaskMarker | undefined {
    if (this.loadError) throw this.loadError;
    const value = this.values.get(terminal);
    return value ? structuredClone(value) : undefined;
  }

  save(marker: AttachedTaskMarker): void {
    this.saveCalls++;
    if (this.saveCalls === this.failSaveCall) throw new Error('injected marker write failure');
    this.operations.push({ kind: 'save', marker: structuredClone(marker) });
    this.values.set(marker.terminal, structuredClone(marker));
  }

  clear(terminal: string, messageId: string, generation: number): boolean {
    if (this.clearError) throw this.clearError;
    this.operations.push({ kind: 'clear', terminal, messageId, generation });
    const value = this.values.get(terminal);
    if (
      this.failClear ||
      !value ||
      value.messageId !== messageId ||
      value.generation !== generation
    ) {
      return false;
    }
    this.values.delete(terminal);
    return true;
  }
}

class FakePtySession implements PtySession {
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: PtyExitEvent) => void> = [];
  readonly writes: string[] = [];
  killCalls = 0;
  dataDisposeCalls = 0;
  exitDisposeCalls = 0;
  writeError?: Error;
  killError?: Error;
  dataDisposeError?: Error;
  exitDisposeError?: Error;
  syncDataOnSubscribe?: string;
  syncExitOnSubscribe?: number;

  constructor(
    readonly pid: number,
    private readonly operations: Operation[],
  ) {}

  onData(listener: (data: string) => void): PtyDisposable {
    this.dataListeners.push(listener);
    if (this.syncDataOnSubscribe !== undefined) listener(this.syncDataOnSubscribe);
    return {
      dispose: () => {
        this.dataDisposeCalls++;
        if (this.dataDisposeError) throw this.dataDisposeError;
      },
    };
  }

  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable {
    this.exitListeners.push(listener);
    if (this.syncExitOnSubscribe !== undefined) listener({ exitCode: this.syncExitOnSubscribe });
    return {
      dispose: () => {
        this.exitDisposeCalls++;
        if (this.exitDisposeError) throw this.exitDisposeError;
      },
    };
  }

  write(data: string): void {
    this.operations.push({ kind: 'write', pid: this.pid, data });
    this.writes.push(data);
    if (this.writeError) throw this.writeError;
  }

  resize(): void {}

  async kill(): Promise<void> {
    this.killCalls++;
    if (this.killError) throw this.killError;
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }
}

class FakePtyHost implements PtyHost {
  readonly cleanupDeadlineMs = 5_000;
  readonly spawnDeadlineMs = 10_000;
  readonly sessions: FakePtySession[] = [];
  nextPid = 100;
  spawnError?: Error;
  failSpawnCall?: number;
  spawnCalls = 0;
  nextSyncData?: string;
  nextSyncExit?: number;
  nextKillError?: Error;
  spawnBarrier?: Promise<void>;

  constructor(private readonly operations: Operation[]) {}

  async spawn(_spec: PtySpawnSpec): Promise<PtySession> {
    if (this.spawnBarrier) await this.spawnBarrier;
    this.spawnCalls++;
    if (this.spawnError && (!this.failSpawnCall || this.spawnCalls === this.failSpawnCall)) {
      throw this.spawnError;
    }
    const session = new FakePtySession(this.nextPid++, this.operations);
    session.syncDataOnSubscribe = this.nextSyncData;
    session.syncExitOnSubscribe = this.nextSyncExit;
    session.killError = this.nextKillError;
    this.nextSyncData = undefined;
    this.nextSyncExit = undefined;
    this.nextKillError = undefined;
    this.sessions.push(session);
    return session;
  }
}

function policy(overrides: Partial<AttachedTerminalPolicy> = {}): AttachedTerminalPolicy {
  return {
    expectedIslandId: 'island-a',
    spawn: {
      executable: 'codex',
      args: ['--no-alt-screen'],
      cwd: 'C:/workspace',
      env: {},
      cols: 120,
      rows: 40,
    },
    startupTimeoutMs: 5_000,
    readyConfirmSamples: 1,
    idleSettleMs: 1_500,
    idleConfirmSamples: 2,
    isReadySample: (data) => data === 'READY',
    isIdleSample: (data) => data === 'IDLE',
    encodeDispatch: (request) => `TASK:${request.messageId}\r`,
    ...overrides,
  };
}

function durableMarker(overrides: Partial<AttachedTaskMarker> = {}): AttachedTaskMarker {
  return {
    version: 1,
    terminal: 'backend',
    messageId: 'MSG-1',
    generation: 1,
    pid: 100,
    phase: 'written',
    startedAt: '2026-07-22T20:00:00.000Z',
    updatedAt: '2026-07-22T20:00:01.000Z',
    ...overrides,
  };
}

function serverReceipt(
  overrides: Partial<RunnerCompletionReceipt> = {},
): RunnerCompletionReceipt {
  return {
    sequence: 44,
    islandId: 'island-a',
    terminalId: 'backend',
    messageId: 'MSG-1',
    completedAt: '2026-07-22T20:00:02.000Z',
    source: 'mcp_complete_task',
    ...overrides,
  };
}

function idleProof(
  receiptSequence: number,
  overrides: Partial<AttachedStableIdleProof> = {},
): AttachedStableIdleProof {
  return {
    terminal: 'backend',
    messageId: 'MSG-1',
    sessionGeneration: 1,
    receiptSequence,
    outputEpoch: 1,
    completionGate: 'gate-1',
    settledAt: '2026-07-23T00:00:02.000Z',
    ...overrides,
  };
}

function fixture(
  policies: ReadonlyMap<string, AttachedTerminalPolicy> = new Map([['backend', policy()]]),
  initialMarkers: readonly AttachedTaskMarker[] = [],
  options: AttachedSessionManagerOptions = {},
) {
  let now = Date.parse('2026-07-23T00:00:00.000Z');
  let gateSequence = 0;
  const operations: Operation[] = [];
  const markers = new MemoryMarkerStore(initialMarkers, operations);
  const host = new FakePtyHost(operations);
  const manager = new AttachedSessionManager(policies, host, markers, {
    now: () => now,
    createGateToken: () => `gate-${++gateSequence}`,
    ...options,
  });
  return {
    manager,
    host,
    markers,
    operations,
    advanceClock: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function makeReady(
  manager: AttachedSessionManager,
  host: FakePtyHost,
  sessionIndex = 0,
): Promise<FakePtySession> {
  const startup = manager.ensureReady();
  await Promise.resolve();
  const session = host.sessions[sessionIndex];
  if (!session) throw new Error(`missing fake PTY session ${sessionIndex}`);
  session.emitData('READY');
  await startup;
  return session;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AttachedSessionManager', () => {
  it('exposes spawn settlement plus native cleanup deadline plus a runner shutdown margin', () => {
    const { manager } = fixture();

    // spawnDeadline (10 000) + cleanupDeadline (5 000) + margin
    expect(manager.minimumShutdownGraceMs()).toBe(17_000);
    expect(fixture(undefined, [], { cleanupMarginMs: 1 }).manager.minimumShutdownGraceMs()).toBe(
      15_001,
    );
    expect(
      fixture(undefined, [], { cleanupMarginMs: 60_000 }).manager.minimumShutdownGraceMs(),
    ).toBe(75_000);
  });

  it.each([0, 60_001, 1.5, Number.NaN])(
    'rejects an unsafe cleanup margin: %s',
    (cleanupMarginMs) => {
      expect(() => fixture(undefined, [], { cleanupMarginMs })).toThrow(/cleanupMarginMs/);
    },
  );

  it('kills and rejects a PTY that does not become ready before startup timeout', async () => {
    vi.useFakeTimers();
    const policies = new Map([['backend', policy({ startupTimeoutMs: 50 })]]);
    const { manager, host } = fixture(policies);

    const startup = manager.ensureReady();
    await Promise.resolve();
    const rejection = expect(startup).rejects.toThrow(/startup timeout/);
    const session = host.sessions[0];
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(session.killCalls).toBeGreaterThanOrEqual(1);
    expect(manager.activeCount()).toBe(0);
  });

  it('times out a pending native spawn and unwinds its late session', async () => {
    vi.useFakeTimers();
    let releaseSpawn!: () => void;
    const policies = new Map([['backend', policy({ startupTimeoutMs: 50 })]]);
    const { manager, host } = fixture(policies);
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const startup = manager.ensureReady();
    const rejection = expect(startup).rejects.toThrow(/startup timeout/);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(manager.activeCount()).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopping' });

    releaseSpawn();
    await vi.waitFor(() => expect(manager.activeCount()).toBe(0));
    expect(host.sessions[0].killCalls).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
  });

  it('retains a late timed-out spawn when its cleanup fails', async () => {
    vi.useFakeTimers();
    let releaseSpawn!: () => void;
    const policies = new Map([['backend', policy({ startupTimeoutMs: 50 })]]);
    const { manager, host } = fixture(policies);
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    host.nextKillError = new Error('timed-out process tree survived');
    const startup = manager.ensureReady();
    const rejection = expect(startup).rejects.toThrow(/startup timeout/);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    releaseSpawn();
    await vi.waitFor(() =>
      expect(manager.snapshot('backend')).toMatchObject({ state: 'attention_required' }),
    );

    expect(host.sessions[0].killCalls).toBe(1);
    expect(manager.activeCount()).toBe(1);
    expect(manager.snapshot('backend')?.lastError).toMatch(/late PTY spawn cleanup failed/);
  });

  it('continues the bounded restart chain after an automatic pending-spawn timeout cleans up late', async () => {
    vi.useFakeTimers();
    let releaseSpawn!: () => void;
    const policies = new Map([['backend', policy({ startupTimeoutMs: 50 })]]);
    const { manager, host } = fixture(policies, [], {
      restart: {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 40,
        stabilityResetMs: 10_000,
        jitterRatio: 0,
      },
    });
    const first = await makeReady(manager, host);
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    first.emitExit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'failed', restartAttempt: 1 });

    await vi.advanceTimersByTimeAsync(10); // automatic attempt starts; native spawn hangs
    expect(manager.snapshot('backend')).toMatchObject({ state: 'starting' });
    await vi.advanceTimersByTimeAsync(50); // pending-spawn startup timeout fires
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopping' });

    host.spawnBarrier = undefined;
    releaseSpawn();
    await vi.advanceTimersByTimeAsync(0); // flush the late-arrival cleanup chain only
    expect(host.sessions).toHaveLength(2);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'failed', restartAttempt: 2 });
    expect(host.sessions[1].killCalls).toBe(1);
    expect(manager.snapshot('backend')?.lastError).toMatch(/settled after startup timeout/);
    expect(manager.snapshot('backend')?.lastError).toMatch(/restart 2\/3/);

    await vi.advanceTimersByTimeAsync(20); // exponential backoff: 10 * 2^(2-1)
    expect(host.sessions).toHaveLength(3);
    host.sessions[2].emitData('READY');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', pid: 102 });
    expect(manager.activeCount()).toBe(1);
  });

  it('honours an explicit cancel inside the post-timeout stopping window', async () => {
    vi.useFakeTimers();
    let releaseSpawn!: () => void;
    const policies = new Map([['backend', policy({ startupTimeoutMs: 50 })]]);
    const { manager, host } = fixture(policies, [], {
      restart: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 40, jitterRatio: 0 },
    });
    const first = await makeReady(manager, host);
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    first.emitExit(1);
    await vi.advanceTimersByTimeAsync(10); // automatic attempt starts; native spawn hangs
    await vi.advanceTimersByTimeAsync(50); // pending-spawn startup timeout fires
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopping' });

    // The cancel arrives AFTER the timeout, while the native spawn is still
    // settling. It must pre-empt the automatic restart continuation.
    expect(manager.cancel('backend', 'operator cancel after timeout')).toBe(true);
    host.spawnBarrier = undefined;
    releaseSpawn();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.activeCount()).toBe(0);
    expect(host.sessions).toHaveLength(2);
    expect(host.sessions[1].killCalls).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.sessions).toHaveLength(2);
  });

  it('does not fail a later clean shutdown with cleanup errors from a recovered generation', async () => {
    vi.useFakeTimers();
    const policies = new Map([
      [
        'backend',
        policy({
          startupTimeoutMs: 50,
          isReadySample: (data) => {
            if (data === 'BROKEN') throw new Error('classifier crashed');
            return data === 'READY';
          },
        }),
      ],
    ]);
    const { manager, host } = fixture(policies, [], {
      restart: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 40, jitterRatio: 0 },
    });
    const first = await makeReady(manager, host);
    first.emitExit(1);
    await vi.advanceTimersByTimeAsync(10); // automatic replacement spawns
    const second = host.sessions[1];
    second.dataDisposeError = new Error('old-generation dispose leak');
    second.emitData('BROKEN'); // classifier fails; dispose error recorded, kill succeeds
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.snapshot('backend')?.lastError).toMatch(/old-generation dispose leak/);

    await vi.advanceTimersByTimeAsync(20); // bounded restart continues
    host.sessions[2].emitData('READY');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', pid: 102 });

    // The recovered terminal's clean shutdown must not resurrect the already
    // delivered old-generation cleanup error.
    await manager.shutdown('clean shutdown after recovery');
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
  });

  it('never restarts after an explicit cancel of an automatic pending spawn', async () => {
    vi.useFakeTimers();
    let releaseSpawn!: () => void;
    const policies = new Map([['backend', policy({ startupTimeoutMs: 50 })]]);
    const { manager, host } = fixture(policies, [], {
      restart: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 40, jitterRatio: 0 },
    });
    const first = await makeReady(manager, host);
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    first.emitExit(1);
    await vi.advanceTimersByTimeAsync(10); // automatic attempt starts; native spawn hangs
    expect(manager.snapshot('backend')).toMatchObject({ state: 'starting' });

    expect(manager.cancel('backend', 'operator cancelled automatic attempt')).toBe(true);
    host.spawnBarrier = undefined;
    releaseSpawn();
    await vi.advanceTimersByTimeAsync(0); // flush the late-arrival cleanup chain only
    expect(manager.activeCount()).toBe(0);

    expect(host.sessions).toHaveLength(2);
    expect(host.sessions[1].killCalls).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.sessions).toHaveLength(2);
  });

  it('never restarts when shutdown interrupts an automatic pending spawn', async () => {
    vi.useFakeTimers();
    let releaseSpawn!: () => void;
    const policies = new Map([['backend', policy({ startupTimeoutMs: 50 })]]);
    const { manager, host } = fixture(policies, [], {
      restart: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 40, jitterRatio: 0 },
    });
    const first = await makeReady(manager, host);
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    first.emitExit(1);
    await vi.advanceTimersByTimeAsync(10); // automatic attempt starts; native spawn hangs
    expect(manager.snapshot('backend')).toMatchObject({ state: 'starting' });

    const shutdown = manager.shutdown('test shutdown during automatic spawn');
    host.spawnBarrier = undefined;
    releaseSpawn();
    await shutdown;

    expect(host.sessions).toHaveLength(2);
    expect(host.sessions[1].killCalls).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
    expect(manager.activeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.sessions).toHaveLength(2);
  });

  it('keeps a timed-out PTY tracked and blocks restart when cleanup fails', async () => {
    vi.useFakeTimers();
    const policies = new Map([['backend', policy({ startupTimeoutMs: 50 })]]);
    const { manager, host } = fixture(policies, [], {
      restart: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 40, jitterRatio: 0 },
    });
    const startup = manager.ensureReady();
    await Promise.resolve();
    const failure = startup.catch((error: unknown) => error);
    host.sessions[0].killError = new Error('cannot kill timed-out process tree');

    await vi.advanceTimersByTimeAsync(50);
    const error = await failure;

    expect(error).toBeInstanceOf(AttachedLifecycleError);
    expect((error as Error).message).toMatch(/cleanup failed|rollback failed/);
    expect(manager.activeCount()).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      lastError: expect.stringMatching(/cannot kill timed-out process tree/),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.sessions).toHaveLength(1);
  });

  it('fails preflight closed when the PTY host cannot spawn', async () => {
    const { manager, host } = fixture();
    host.spawnError = new Error('native PTY unavailable');

    await expect(manager.ensureReady()).rejects.toThrow(/PTY spawn failed/);

    expect(host.sessions).toEqual([]);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'failed',
      lastError: expect.stringMatching(/native PTY unavailable/),
    });
  });

  it('requires consecutive readiness samples and resets the count on a miss', async () => {
    const policies = new Map([['backend', policy({ readyConfirmSamples: 2 })]]);
    const { manager, host } = fixture(policies);
    const startup = manager.ensureReady();
    await Promise.resolve();
    const session = host.sessions[0];

    session.emitData('READY');
    expect(manager.snapshot('backend')).toMatchObject({ state: 'starting' });
    session.emitData('noise');
    session.emitData('READY');
    expect(manager.snapshot('backend')).toMatchObject({ state: 'starting' });
    session.emitData('READY');
    await startup;

    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', pid: 100 });
  });

  it('blocks a replacement when its readiness classifier and cleanup both fail', async () => {
    vi.useFakeTimers();
    const policies = new Map([
      [
        'backend',
        policy({
          startupTimeoutMs: 50,
          isReadySample: (data) => {
            if (data === 'BROKEN') throw new Error('classifier crashed');
            return data === 'READY';
          },
        }),
      ],
    ]);
    const { manager, host } = fixture(policies, [], {
      restart: {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 40,
        stabilityResetMs: 100,
        jitterRatio: 0,
      },
    });
    const first = await makeReady(manager, host);
    first.emitExit(1);
    host.nextKillError = new Error('classifier PTY cleanup failed');
    await vi.advanceTimersByTimeAsync(10);
    host.sessions[1].emitData('BROKEN');
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.activeCount()).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      pid: 101,
      lastError: expect.stringMatching(/classifier PTY cleanup failed/),
    });
    await expect(manager.ensureReady()).rejects.toThrow(/tracked PTY pending cleanup/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.sessions).toHaveLength(2);
  });

  it('automatically restarts taskless STARTING and READY exits with deterministic jitter', async () => {
    vi.useFakeTimers();
    const options: AttachedSessionManagerOptions = {
      restart: {
        maxAttempts: 2,
        initialDelayMs: 100,
        maxDelayMs: 400,
        stabilityResetMs: 100,
        jitterRatio: 0.25,
      },
      random: () => 0,
    };
    const first = fixture(undefined, [], options);
    const startup = first.manager.ensureReady();
    await Promise.resolve();
    first.host.sessions[0].emitExit(7);
    await vi.advanceTimersByTimeAsync(0);

    expect(first.manager.snapshot('backend')).toMatchObject({
      state: 'failed',
      restartAttempt: 1,
      lastError: expect.stringMatching(/restart 1\/2 in 75ms/),
    });
    await vi.advanceTimersByTimeAsync(74);
    expect(first.host.sessions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.host.sessions).toHaveLength(2);
    first.host.sessions[1].emitData('READY');
    await startup;
    await vi.advanceTimersByTimeAsync(100);
    expect(first.manager.snapshot('backend')?.restartAttempt).toBeUndefined();

    first.host.sessions[1].emitExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.manager.snapshot('backend')).toMatchObject({
      state: 'failed',
      restartAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(75);
    expect(first.host.sessions).toHaveLength(3);
    first.host.sessions[2].emitData('READY');
    await Promise.resolve();
    expect(first.manager.snapshot('backend')).toMatchObject({ state: 'ready', pid: 102 });
  });

  it('exhausts the budget when READY sessions exit before the stability window', async () => {
    vi.useFakeTimers();
    const { manager, host } = fixture(undefined, [], {
      restart: {
        maxAttempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 20,
        stabilityResetMs: 100,
        jitterRatio: 0,
      },
    });
    const first = await makeReady(manager, host);
    first.emitExit(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    host.sessions[1].emitData('READY');
    await vi.advanceTimersByTimeAsync(99);
    host.sessions[1].emitExit(2);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    host.sessions[2].emitData('READY');
    host.sessions[2].emitExit(3);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.sessions).toHaveLength(3);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'failed',
      restartAttempt: 2,
      lastError: expect.stringMatching(/budget exhausted/),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.sessions).toHaveLength(3);
  });

  it('stops automatic recovery after the bounded restart budget is exhausted', async () => {
    vi.useFakeTimers();
    const { manager, host } = fixture(undefined, [], {
      restart: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
    });
    const startup = manager.ensureReady();
    const startupRejection = expect(startup).rejects.toThrow(
      /restart budget exhausted after 2 attempt/,
    );
    await Promise.resolve();
    host.sessions[0].emitExit(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    host.sessions[1].emitExit(2);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    host.sessions[2].emitExit(3);
    await vi.advanceTimersByTimeAsync(0);

    await startupRejection;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.sessions).toHaveLength(3);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'failed',
      restartAttempt: 2,
      lastError: expect.stringMatching(/budget exhausted/),
    });
  });

  it('fails closed when restart jitter entropy is not finite', async () => {
    vi.useFakeTimers();
    const { manager, host } = fixture(undefined, [], { random: () => Number.NaN });
    const first = await makeReady(manager, host);
    first.emitExit(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.snapshot('backend')).toMatchObject({
      state: 'failed',
      lastError: expect.stringMatching(/restart entropy/),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.sessions).toHaveLength(1);
  });

  it('rejects provider encoding errors without persisting a marker or writing input', async () => {
    const policies = new Map([
      [
        'backend',
        policy({
          encodeDispatch: () => {
            throw new Error('unsafe provider input');
          },
        }),
      ],
    ]);
    const { manager, host, markers, operations } = fixture(policies);
    const session = await makeReady(manager, host);

    expect(manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' })).toMatchObject({
      started: false,
      reason: expect.stringMatching(/encoding failed/),
    });
    expect(session.writes).toEqual([]);
    expect(markers.load('backend')).toBeUndefined();
    expect(operations).toEqual([]);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready' });
  });

  it('persists an accepted marker before writing PTY input, then records written', async () => {
    const { manager, host, markers, operations } = fixture();
    await makeReady(manager, host);

    expect(manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' })).toEqual({
      started: true,
    });
    expect(operations.map((operation) => operation.kind)).toEqual(['save', 'write', 'save']);
    expect(operations[0]).toMatchObject({
      kind: 'save',
      marker: { messageId: 'MSG-1', generation: 1, pid: 100, phase: 'accepted' },
    });
    expect(operations[1]).toEqual({ kind: 'write', pid: 100, data: 'TASK:MSG-1\r' });
    expect(markers.load('backend')).toMatchObject({ phase: 'written', generation: 1 });
    expect(manager.snapshot('backend')).toMatchObject({ state: 'busy', messageId: 'MSG-1' });
  });

  it('does not write or claim a task when the pre-write marker cannot persist', async () => {
    const { manager, host, markers } = fixture();
    const session = await makeReady(manager, host);
    markers.failSaveCall = 1;

    const result = manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });

    expect(result).toMatchObject({ started: false, reason: expect.stringMatching(/persist failed/) });
    expect(session.writes).toEqual([]);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      lastError: expect.stringMatching(/persist failed/),
    });
    expect(manager.isBusy('backend')).toBe(true);
    expect(manager.dispatch({ terminal: 'backend', messageId: 'MSG-2' })).toMatchObject({
      started: false,
      reason: expect.stringMatching(/not ready/),
    });
    expect(session.writes).toEqual([]);
  });

  it('retains ownership and requires attention when a PTY write outcome is uncertain', async () => {
    const { manager, host, markers } = fixture();
    const session = await makeReady(manager, host);
    session.writeError = new Error('write failed after partial native handoff');

    const result = manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });

    expect(result).toMatchObject({ started: true, reason: expect.stringMatching(/outcome unknown/) });
    expect(markers.load('backend')).toMatchObject({ phase: 'accepted', messageId: 'MSG-1' });
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      messageId: 'MSG-1',
    });
    expect(manager.isBusy('backend')).toBe(true);
  });

  it('retains ownership when the post-write marker transition cannot persist', async () => {
    const { manager, host, markers } = fixture();
    const session = await makeReady(manager, host);
    markers.failSaveCall = 2;

    const result = manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });

    expect(result).toMatchObject({ started: true, reason: expect.stringMatching(/persist failed/) });
    expect(session.writes).toEqual(['TASK:MSG-1\r']);
    expect(markers.load('backend')).toMatchObject({ phase: 'accepted' });
    expect(manager.snapshot('backend')).toMatchObject({ state: 'attention_required' });
  });

  it('requires an exact completion receipt and stable idle before releasing ownership', async () => {
    const { manager, host, markers, operations, advanceClock } = fixture();
    const session = await makeReady(manager, host);
    manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    const proofStartedWhileBusy = idleProof(8, { completionGate: 'gate-before-receipt' });

    expect(manager.acknowledgeCompletion(serverReceipt({ terminalId: 'frontend', sequence: 8 }))).toBe(false);
    expect(manager.acknowledgeCompletion(serverReceipt({ messageId: 'MSG-OTHER', sequence: 8 }))).toBe(false);
    expect(manager.acknowledgeCompletion(serverReceipt({ sequence: 0 }))).toBe(false);
    expect(manager.acknowledgeCompletion(serverReceipt({ islandId: 'island-b', sequence: 8 }))).toBe(false);
    expect(manager.acknowledgeCompletion(serverReceipt({ completedAt: 'not-a-date', sequence: 8 }))).toBe(false);
    expect(
      manager.acknowledgeCompletion({
        ...serverReceipt({ sequence: 8 }),
        source: 'operator_override',
      } as unknown as RunnerCompletionReceipt),
    ).toBe(false);
    expect(markers.load('backend')).toMatchObject({ phase: 'written' });
    expect(manager.acknowledgeCompletion(serverReceipt({ sequence: 8 }))).toBe(true);
    expect(manager.acknowledgeCompletion(serverReceipt({ sequence: 8 }))).toBe(true);
    expect(markers.load('backend')).toMatchObject({ phase: 'completed', receiptSequence: 8 });
    expect(manager.snapshot('backend')).toMatchObject({ state: 'draining', messageId: 'MSG-1' });
    expect(manager.acknowledgeStableIdle(idleProof(8))).toBe(false);
    expect(manager.acknowledgeStableIdle(idleProof(8, { messageId: 'MSG-OTHER' }))).toBe(false);
    expect(manager.acknowledgeStableIdle(idleProof(8, { sessionGeneration: 99 }))).toBe(false);
    expect(manager.acknowledgeStableIdle(idleProof(9))).toBe(false);
    expect(manager.acknowledgeStableIdle(proofStartedWhileBusy)).toBe(false);
    expect(
      manager.acknowledgeStableIdle(idleProof(8, { settledAt: '2020-01-01T00:00:00.000Z' })),
    ).toBe(false);
    expect(
      manager.acknowledgeStableIdle(
        idleProof(8, { settledAt: '2026-07-23T00:10:00.000Z' }),
      ),
    ).toBe(false);
    expect(markers.load('backend')).toBeDefined();

    session.emitData('IDLE');
    advanceClock(1_500);
    expect(manager.acknowledgeStableIdle(idleProof(8, { outputEpoch: 2 }))).toBe(false);
    session.emitData('completion tail output');
    session.emitData('IDLE');
    session.emitData('IDLE');
    advanceClock(1_500);
    expect(manager.snapshot('backend')).toMatchObject({
      outputEpoch: 5,
      idleConfirmationCount: 2,
      completionGate: 'gate-1',
    });
    expect(
      manager.acknowledgeStableIdle(
        idleProof(8, {
          outputEpoch: 5,
          settledAt: '2026-07-23T00:00:03.000Z',
        }),
      ),
    ).toBe(true);
    expect(markers.load('backend')).toBeUndefined();
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', messageId: undefined });
    expect(operations.at(-1)).toEqual({
      kind: 'clear',
      terminal: 'backend',
      messageId: 'MSG-1',
      generation: 1,
    });
  });

  it('fails closed if the exact generation marker disappears before completion or idle', async () => {
    const { manager, host, markers } = fixture();
    await makeReady(manager, host);
    manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    markers.values.set('backend', durableMarker({ generation: 99 }));

    expect(manager.acknowledgeCompletion(serverReceipt({ sequence: 1 }))).toBe(false);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'attention_required' });

    const second = fixture();
    const secondSession = await makeReady(second.manager, second.host);
    second.manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    expect(second.manager.acknowledgeCompletion(serverReceipt({ sequence: 1 }))).toBe(true);
    second.markers.failClear = true;
    secondSession.emitData('IDLE');
    secondSession.emitData('IDLE');
    second.advanceClock(1_500);
    expect(second.manager.acknowledgeStableIdle(idleProof(1, { outputEpoch: 3 }))).toBe(false);
    expect(second.manager.snapshot('backend')).toMatchObject({ state: 'attention_required' });
  });

  it('keeps a busy crash blocked with its durable marker intact', async () => {
    vi.useFakeTimers();
    const { manager, host, markers } = fixture();
    const session = await makeReady(manager, host);
    manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });

    session.emitExit(17);
    await vi.advanceTimersByTimeAsync(0);

    expect(markers.load('backend')).toMatchObject({ messageId: 'MSG-1', phase: 'written' });
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      messageId: 'MSG-1',
      lastError: expect.stringMatching(/before completion/),
    });
    expect(manager.isBusy('backend')).toBe(true);
    await expect(manager.ensureReady()).rejects.toThrow(/reconciliation/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.sessions).toHaveLength(1);
  });

  it.each(['starting', 'ready', 'busy', 'draining'] as const)(
    'retains ownership when %s root-exit process-tree cleanup fails',
    async (phase) => {
      vi.useFakeTimers();
      const { manager, host } = fixture(undefined, [], {
        restart: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
      });
      let session: FakePtySession;
      let startupFailure: Promise<unknown> | undefined;
      if (phase === 'starting') {
        startupFailure = manager.ensureReady().catch((error: unknown) => error);
        await Promise.resolve();
        session = host.sessions[0];
      } else {
        session = await makeReady(manager, host);
        if (phase === 'busy' || phase === 'draining') {
          manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
        }
        if (phase === 'draining') {
          manager.acknowledgeCompletion(serverReceipt({ sequence: 71 }));
        }
      }
      session.killError = new Error(`${phase} descendant survived`);
      session.emitExit(19);
      await vi.advanceTimersByTimeAsync(0);
      await startupFailure;

      expect(manager.activeCount()).toBe(1);
      expect(manager.snapshot('backend')).toMatchObject({
        state: 'attention_required',
        lastError: expect.stringMatching(/cleanup failed/),
      });
      if (phase === 'busy' || phase === 'draining') {
        expect(manager.reconcileMarker(serverReceipt({ sequence: 71 }))).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(host.sessions).toHaveLength(1);
    },
  );

  it('attempts both subscription disposals and root cleanup when the first dispose throws', async () => {
    const { manager, host } = fixture();
    const session = await makeReady(manager, host);
    session.dataDisposeError = new Error('data subscription resisted disposal');

    expect(() => session.emitExit(0)).not.toThrow();
    await vi.waitFor(() => expect(manager.activeCount()).toBe(0));

    expect(session.dataDisposeCalls).toBe(1);
    expect(session.exitDisposeCalls).toBe(1);
    expect(session.killCalls).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      lastError: expect.stringMatching(/data subscription dispose failed/),
    });
  });

  it('preserves a busy marker and blocks redispatch when cancellation completes', async () => {
    const { manager, host, markers } = fixture();
    const session = await makeReady(manager, host);
    manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });

    expect(manager.cancel('backend', 'operator cancellation')).toBe(true);
    await Promise.resolve();

    expect(session.killCalls).toBe(1);
    expect(markers.load('backend')).toMatchObject({ messageId: 'MSG-1', phase: 'written' });
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      messageId: 'MSG-1',
    });
    expect(manager.dispatch({ terminal: 'backend', messageId: 'MSG-2' })).toMatchObject({
      started: false,
    });
  });

  it('turns marker load and clear exceptions into attention-required state', async () => {
    const completion = fixture();
    await makeReady(completion.manager, completion.host);
    completion.manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    completion.markers.loadError = new Error('disk read failed');

    expect(completion.manager.acknowledgeCompletion(serverReceipt({ sequence: 4 }))).toBe(false);
    expect(completion.manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      messageId: 'MSG-1',
      lastError: expect.stringMatching(/load failed/),
    });

    const idle = fixture();
    const idleSession = await makeReady(idle.manager, idle.host);
    idle.manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    expect(idle.manager.acknowledgeCompletion(serverReceipt({ sequence: 4 }))).toBe(true);
    idle.markers.clearError = new Error('disk unlink failed');

    idleSession.emitData('IDLE');
    idleSession.emitData('IDLE');
    idle.advanceClock(1_500);
    expect(idle.manager.acknowledgeStableIdle(idleProof(4, { outputEpoch: 3 }))).toBe(false);
    expect(idle.manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      messageId: 'MSG-1',
      lastError: expect.stringMatching(/cleanup failed/),
    });
    expect(idle.markers.values.get('backend')).toMatchObject({ phase: 'completed' });
  });

  it('fails construction closed when an existing marker cannot be loaded', () => {
    const operations: Operation[] = [];
    const markers = new MemoryMarkerStore([], operations);
    markers.loadError = new Error('corrupt durable marker');

    expect(
      () =>
        new AttachedSessionManager(
          new Map([['backend', policy()]]),
          new FakePtyHost(operations),
          markers,
        ),
    ).toThrow(/corrupt durable marker/);
  });

  it('rejects unsafe terminal lifecycle policy bounds during construction', () => {
    const invalidPolicies = [
      policy({ expectedIslandId: ' ' }),
      policy({ startupTimeoutMs: 0 }),
      policy({ startupTimeoutMs: 600_001 }),
      policy({ readyConfirmSamples: 0 }),
      policy({ readyConfirmSamples: 101 }),
      policy({ idleSettleMs: 0 }),
      policy({ idleSettleMs: 60_001 }),
      policy({ idleConfirmSamples: 1 }),
      policy({ idleConfirmSamples: 11 }),
    ];
    for (const invalid of invalidPolicies) {
      expect(() => fixture(new Map([['backend', invalid]]))).toThrow(/attached terminal/);
    }
  });

  it('does not rerun completed work after a draining crash and clears only after restart readiness', async () => {
    vi.useFakeTimers();
    const { manager, host, markers, operations } = fixture(undefined, [], {
      restart: { maxAttempts: 2, initialDelayMs: 25, maxDelayMs: 50, jitterRatio: 0 },
    });
    const first = await makeReady(manager, host);
    manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    expect(manager.acknowledgeCompletion(serverReceipt({ sequence: 12 }))).toBe(true);

    first.emitExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'failed',
      messageId: 'MSG-1',
      restartAttempt: 1,
    });
    expect(markers.load('backend')).toMatchObject({ phase: 'completed', receiptSequence: 12 });

    const restart = manager.ensureReady();
    await vi.advanceTimersByTimeAsync(25);
    const replacement = host.sessions[1];
    expect(replacement).toBeDefined();
    expect(markers.load('backend')).toBeDefined();
    expect(operations.filter((operation) => operation.kind === 'write')).toHaveLength(1);
    replacement.emitData('READY');
    await restart;

    expect(markers.load('backend')).toBeUndefined();
    expect(replacement.writes).toEqual([]);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', messageId: undefined });
  });

  it('ignores late callbacks from an older PTY generation during replacement startup', async () => {
    vi.useFakeTimers();
    const { manager, host } = fixture(undefined, [], {
      restart: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
    });
    const first = await makeReady(manager, host);
    manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    manager.acknowledgeCompletion(serverReceipt({ sequence: 2 }));
    first.emitExit(0);
    await vi.advanceTimersByTimeAsync(0);

    const restart = manager.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    const replacement = host.sessions[1];
    first.emitData('READY');
    first.emitExit(99);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'starting', pid: replacement.pid });

    replacement.emitData('READY');
    await restart;
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', pid: replacement.pid });
  });

  it('promotes an accepted or written marker only from an exact server completion receipt', async () => {
    vi.useFakeTimers();
    const pending = durableMarker();
    const pendingFixture = fixture(new Map([['backend', policy()]]), [pending], {
      restart: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
    });

    expect(pendingFixture.manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      messageId: 'MSG-1',
    });
    await expect(pendingFixture.manager.ensureReady()).rejects.toThrow(/reconciliation/);
    expect(pendingFixture.manager.reconcileMarker(serverReceipt({ terminalId: 'reviewer' }))).toBe(
      false,
    );
    expect(pendingFixture.manager.reconcileMarker(serverReceipt({ messageId: 'MSG-OTHER' }))).toBe(
      false,
    );
    expect(pendingFixture.markers.load('backend')).toEqual(pending);

    expect(pendingFixture.manager.reconcileMarker(serverReceipt({ sequence: 7 }))).toBe(true);
    expect(pendingFixture.markers.load('backend')).toMatchObject({
      phase: 'completed',
      receiptSequence: 7,
    });
    expect(pendingFixture.manager.snapshot('backend')).toMatchObject({
      state: 'failed',
      restartAttempt: 1,
    });
    const readiness = pendingFixture.manager.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    pendingFixture.host.sessions[0].emitData('READY');
    await readiness;
    expect(pendingFixture.markers.load('backend')).toBeUndefined();
    expect(pendingFixture.manager.snapshot('backend')).toMatchObject({ state: 'ready' });
  });

  it('keeps the live matching PTY and drains it when reconciliation supplies completion', async () => {
    vi.useFakeTimers();
    const { manager, host, markers, advanceClock } = fixture();
    const session = await makeReady(manager, host);
    markers.failSaveCall = 2;
    expect(manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' })).toMatchObject({
      started: true,
    });
    expect(manager.snapshot('backend')).toMatchObject({ state: 'attention_required', pid: 100 });

    expect(manager.reconcileMarker(serverReceipt({ sequence: 33 }))).toBe(true);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'draining', pid: 100 });
    expect(markers.load('backend')).toMatchObject({
      phase: 'completed',
      receiptSequence: 33,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.sessions).toHaveLength(1);

    session.emitData('IDLE');
    session.emitData('IDLE');
    advanceClock(1_500);
    expect(manager.acknowledgeStableIdle(idleProof(33, { outputEpoch: 3 }))).toBe(true);
    expect(markers.load('backend')).toBeUndefined();
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', pid: 100 });
  });

  it('requires an exact receipt to resolve an unknown controller write outcome', async () => {
    vi.useFakeTimers();
    const { manager, host, markers, advanceClock } = fixture();
    const session = await makeReady(manager, host);
    session.writeError = new Error('native write outcome unknown');
    manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    expect(manager.acknowledgeStableIdle(idleProof(34))).toBe(false);
    expect(manager.reconcileMarker(serverReceipt({ sequence: 34 }))).toBe(true);

    session.emitData('IDLE');
    session.emitData('IDLE');
    advanceClock(1_500);
    expect(manager.acknowledgeStableIdle(idleProof(34, { outputEpoch: 3 }))).toBe(true);
    expect(markers.load('backend')).toBeUndefined();
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', pid: 100 });
  });

  it('routes an already-completed marker through restart readiness before clearing it', async () => {
    vi.useFakeTimers();
    const completed = durableMarker({ phase: 'completed', receiptSequence: 44 });
    const completedFixture = fixture(new Map([['backend', policy()]]), [completed], {
      restart: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
    });
    expect(completedFixture.manager.reconcileMarker(serverReceipt({ messageId: 'MSG-OTHER' }))).toBe(
      false,
    );
    expect(completedFixture.manager.reconcileMarker(serverReceipt({ sequence: 45 }))).toBe(false);
    expect(completedFixture.markers.load('backend')).toEqual(completed);
    expect(completedFixture.manager.reconcileMarker(serverReceipt())).toBe(true);
    expect(completedFixture.markers.load('backend')).toEqual(completed);

    const readiness = completedFixture.manager.ensureReady();
    await vi.advanceTimersByTimeAsync(10);
    completedFixture.host.sessions[0].emitData('READY');
    await readiness;
    expect(completedFixture.markers.load('backend')).toBeUndefined();
    expect(completedFixture.manager.snapshot('backend')).toMatchObject({ state: 'ready' });
  });

  it('buffers synchronous subscription callbacks until both PTY listeners are registered', async () => {
    vi.useFakeTimers();
    const { manager, host } = fixture(undefined, [], {
      restart: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
    });
    host.nextSyncData = 'READY';
    host.nextSyncExit = 9;

    const startup = manager.ensureReady();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.snapshot('backend')).toMatchObject({ state: 'failed', restartAttempt: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(host.sessions).toHaveLength(2);
    host.sessions[1].emitData('READY');
    await startup;
    expect(manager.snapshot('backend')).toMatchObject({ state: 'ready', pid: 101 });
  });

  it('cancels pending restart timers during shutdown and never respawns afterwards', async () => {
    vi.useFakeTimers();
    const { manager, host } = fixture(undefined, [], {
      restart: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 400, jitterRatio: 0 },
    });
    const first = await makeReady(manager, host);
    first.emitExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'failed', restartAttempt: 1 });

    await manager.shutdown('test shutdown while backoff is pending');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(host.sessions).toHaveLength(1);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
    await expect(manager.ensureReady()).rejects.toThrow(/shutting down/);
  });

  it('awaits and unwinds a PTY spawn that resolves after shutdown starts', async () => {
    let releaseSpawn!: () => void;
    const { manager, host } = fixture();
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const startup = manager.ensureReady();
    const startupFailure = startup.catch((error: unknown) => error);
    const shutdown = manager.shutdown('shutdown during native spawn');
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(host.sessions).toHaveLength(0);
    expect(manager.activeCount()).toBe(1);
    expect(shutdownSettled).toBe(false);
    releaseSpawn();
    await shutdown;
    await startupFailure;

    expect(host.sessions).toHaveLength(1);
    expect(host.sessions[0].killCalls).toBe(1);
    expect(manager.activeCount()).toBe(0);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
  });

  it('cancels a pending native spawn and unwinds the late session', async () => {
    let releaseSpawn!: () => void;
    const { manager, host } = fixture();
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const startup = manager.ensureReady();
    const startupFailure = startup.catch((error: unknown) => error);
    await Promise.resolve();

    expect(manager.cancel('backend', 'operator cancelled pending spawn')).toBe(true);
    expect(manager.activeCount()).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopping' });

    releaseSpawn();
    expect(await startupFailure).toMatchObject({
      message: 'operator cancelled pending spawn',
    });
    await vi.waitFor(() => expect(manager.activeCount()).toBe(0));

    expect(host.sessions).toHaveLength(1);
    expect(host.sessions[0].killCalls).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
    expect(manager.snapshot('backend')?.pid).toBeUndefined();
  });

  it('retains a late session when pending-spawn cancellation cleanup fails', async () => {
    let releaseSpawn!: () => void;
    const { manager, host } = fixture();
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    host.nextKillError = new Error('cancelled process tree survived');
    const startupFailure = manager.ensureReady().catch((error: unknown) => error);
    await Promise.resolve();
    expect(manager.cancel('backend', 'operator cancelled pending spawn')).toBe(true);

    releaseSpawn();
    await startupFailure;
    await vi.waitFor(() =>
      expect(manager.snapshot('backend')).toMatchObject({ state: 'attention_required' }),
    );

    expect(host.sessions[0].killCalls).toBe(1);
    expect(manager.activeCount()).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({
      pid: 100,
      lastError: expect.stringMatching(/late PTY spawn cleanup failed/),
    });
  });

  it('rejects shutdown and retains ownership when a late-spawn unwind fails', async () => {
    let releaseSpawn!: () => void;
    const { manager, host } = fixture();
    host.spawnBarrier = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    host.nextKillError = new Error('late spawn process tree survived');
    const startupFailure = manager.ensureReady().catch((error: unknown) => error);
    const shutdown = manager.shutdown('shutdown during native spawn');

    releaseSpawn();
    await expect(shutdown).rejects.toThrow(/late spawn process tree survived/);
    await startupFailure;

    expect(manager.activeCount()).toBe(1);
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      lastError: expect.stringMatching(/late PTY spawn cleanup failed/),
    });
  });

  it('propagates a dispose failure to shutdown when it races a PTY root exit', async () => {
    const { manager, host } = fixture();
    const session = await makeReady(manager, host);
    session.dataDisposeError = new Error('data dispose leak');

    // handleExit disposes subscriptions synchronously (recording the failure),
    // then shutdown races it on the same idempotent kill promise. Whichever
    // continuation wins, the ledger sweep must still surface the error.
    session.emitExit(0);
    const failure = await manager.shutdown().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AttachedLifecycleError);
    expect((failure as Error).message).toMatch(/data subscription dispose failed/);
    expect((failure as Error).message).toMatch(/data dispose leak/);
    expect(
      (failure as AttachedLifecycleError).errors.some((error) =>
        /^backend: PTY data subscription dispose failed: data dispose leak$/.test(error.message),
      ),
    ).toBe(true);
  });

  it('propagates a dispose failure when the PTY root exits during shutdown', async () => {
    const { manager, host } = fixture();
    const session = await makeReady(manager, host);
    session.exitDisposeError = new Error('exit dispose leak');

    const shutdown = manager.shutdown().catch((error: unknown) => error);
    session.emitExit(0); // arrives while shutdown is already draining this session
    const failure = await shutdown;

    expect(failure).toBeInstanceOf(AttachedLifecycleError);
    expect((failure as Error).message).toMatch(/exit subscription dispose failed/);
    expect((failure as Error).message).toMatch(/exit dispose leak/);
  });

  it('preserves both the preflight failure and rollback cleanup failure', async () => {
    const policies = new Map([
      ['backend', policy()],
      ['reviewer', policy({ spawn: { ...policy().spawn, executable: 'claude' } })],
    ]);
    const { manager, host } = fixture(policies);
    host.nextKillError = new Error('cannot remove first process tree');
    host.spawnError = new Error('second native PTY unavailable');
    host.failSpawnCall = 2;

    const failure = await manager.ensureReady().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AttachedLifecycleError);
    expect(failure).toMatchObject({
      errors: [
        expect.objectContaining({ message: expect.stringMatching(/second native PTY unavailable/) }),
        expect.objectContaining({ message: expect.stringMatching(/cannot remove first process tree/) }),
      ],
    });
    expect((failure as Error).message).toMatch(/preflight failed.*rollback failed/);
  });

  it('awaits shutdown for every terminal and leaves no active PTY session', async () => {
    const policies = new Map([
      ['backend', policy()],
      ['reviewer', policy({ spawn: { ...policy().spawn, executable: 'claude' } })],
    ]);
    const { manager, host } = fixture(policies);
    const startup = manager.ensureReady();
    await Promise.resolve();
    expect(host.sessions).toHaveLength(2);
    host.sessions[0].emitData('READY');
    host.sessions[1].emitData('READY');
    await startup;

    await manager.shutdown('test shutdown');

    expect(host.sessions.map((session) => session.killCalls)).toEqual([1, 1]);
    expect(manager.activeCount()).toBe(0);
    expect(manager.snapshot('backend')).toMatchObject({ state: 'stopped' });
    expect(manager.snapshot('reviewer')).toMatchObject({ state: 'stopped' });
  });

  it('bounds shutdown summaries while preserving every full cleanup error', async () => {
    const policies = new Map(
      Array.from({ length: 6 }, (_, index) => [
        `terminal-${index}`,
        policy({ spawn: { ...policy().spawn, executable: `agent-${index}` } }),
      ]),
    );
    const { manager, host } = fixture(policies);
    const startup = manager.ensureReady();
    await Promise.resolve();
    for (const session of host.sessions) session.emitData('READY');
    await startup;
    host.sessions.forEach((session, index) => {
      session.killError = new Error(
        index === 0 ? `first line\nsecond line ${'x'.repeat(8_000)}` : `cleanup failure ${index}`,
      );
    });

    const failure = await manager.shutdown().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AttachedLifecycleError);
    expect((failure as AttachedLifecycleError).errors).toHaveLength(6);
    expect((failure as Error).message).not.toMatch(/[\r\n]/);
    expect((failure as Error).message).toContain('first line second line');
    expect((failure as Error).message).toContain('+3 more omitted');
    expect((failure as Error).message.length).toBeLessThanOrEqual(700);
    // Full text preserved through the cleanup ledger: 'terminal-0: ' (12) +
    // 'PTY cleanup failed: ' (20) + the 8 023-char original kill error.
    expect((failure as AttachedLifecycleError).errors[0].message).toHaveLength(8_055);
    expect((failure as AttachedLifecycleError).errors[0].message).toContain(
      'terminal-0: PTY cleanup failed: first line',
    );
  });

  it('keeps durable work blocked when shutdown cleanup fails', async () => {
    const { manager, host, markers } = fixture();
    const session = await makeReady(manager, host);
    manager.dispatch({ terminal: 'backend', messageId: 'MSG-1' });
    session.killError = new Error('cannot remove process tree');

    await expect(manager.shutdown()).rejects.toThrow(/shutdown failed/);

    expect(markers.load('backend')).toMatchObject({ messageId: 'MSG-1' });
    expect(manager.snapshot('backend')).toMatchObject({
      state: 'attention_required',
      messageId: 'MSG-1',
    });
    expect(manager.reconcileMarker(serverReceipt({ sequence: 90 }))).toBe(false);
  });
});
