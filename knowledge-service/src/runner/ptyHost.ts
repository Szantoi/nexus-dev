/**
 * Provider-neutral PTY boundary for persistent attached CLI sessions.
 *
 * node-pty is deliberately imported only here. Providers supply an executable
 * and argv separately; this layer never builds or invokes a shell command.
 * PTYs remain on the runner's event loop because node-pty is not thread-safe.
 */
import * as nodePty from 'node-pty';
import { EarlyPtyEventHandoff } from './earlyPtyEventHandoff';
import {
  boundedError,
  execFileBounded,
  parseWindowsProcessTable,
  WINDOWS_PROCESS_TABLE_COMMAND,
} from './ptyProcessCommand';
import {
  parseLinuxProcessIds,
  readLinuxIdentitiesBounded,
  readLinuxProcessIdentity,
  selectSafeLinuxSurvivorsAfterReuse,
} from './ptyLinuxProcess';
export { parseLinuxProcessStat } from './ptyLinuxProcess';
import { ValidationError, RuntimeStateError } from '../core/errors';
import {
  closePinnedWindowsConpty,
  type WindowsNativeCloser,
  unwindDriftedWindowsConpty,
  validatePinnedWindowsConpty,
} from './ptyWindowsOwnership';
import {
  selectWindowsDescendants,
  WINDOWS_IDENTITY_SAFE_TERMINATION_COMMAND,
} from './ptyWindowsProcess';

export type PtyPlatform = 'linux' | 'win32';
export type PtyTerminationSignal = 'SIGTERM' | 'SIGKILL';

export interface PtySpawnSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  cols: number;
  rows: number;
  name?: string;
}

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtySession {
  readonly pid: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Idempotently closes the PTY and removes its complete process tree. */
  kill(): Promise<void>;
}

export interface PtyHost {
  readonly cleanupDeadlineMs: number;
  /** Hard upper bound on spawn settlement; spawn() must settle within it. */
  readonly spawnDeadlineMs: number;
  spawn(spec: PtySpawnSpec): Promise<PtySession>;
  /**
   * Await background unwinds of spawns that settled after their hard deadline.
   * Rejects if any late unwind failed, so shutdown cannot report a clean exit
   * while a deadline-orphaned process tree may still be alive.
   */
  drainPendingSpawnUnwinds?(): Promise<void>;
}

interface NativePtyHandle {
  readonly pid: number;
  readonly onData: (listener: (data: string) => void) => PtyDisposable;
  readonly onExit: (listener: (event: PtyExitEvent) => void) => PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NativePtyFactory {
  spawn(
    executable: string,
    args: readonly string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string | undefined>;
      useConpty?: boolean;
      useConptyDll?: boolean;
    },
  ): NativePtyHandle;
}

export interface PtyProcessIdentity {
  pid: number;
  /** OS process creation identity; unlike a PID this is not reusable. */
  creationToken: string;
  parentPid: number;
  sessionId?: number;
}

type ProcessRecord = PtyProcessIdentity;

/** Injectable OS boundary; tests never need to start or signal a real process. */
export interface PtyProcessTreeAdapter {
  readonly platform: PtyPlatform;
  captureRootIdentity(rootPid: number): Promise<PtyProcessIdentity | undefined>;
  snapshotDescendants(root: PtyProcessIdentity): Promise<readonly PtyProcessIdentity[]>;
  /** Implementations must revalidate creationToken immediately before signalling. */
  signal(identity: PtyProcessIdentity, signal: PtyTerminationSignal): Promise<void>;
  /** Bulk cleanup seam; Windows implementations must use one bounded OS query. */
  signalMany?(
    identities: readonly PtyProcessIdentity[],
    signal: PtyTerminationSignal,
  ): void | Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

export interface NodePtyHostOptions {
  processTree?: PtyProcessTreeAdapter;
  terminationGraceMs?: number;
  cleanupDeadlineMs?: number;
  spawnDeadlineMs?: number;
  /** Test seam for the pinned node-pty 1.1.0 ConPTY ownership wrapper. */
  windowsNativeClose?: WindowsNativeCloser;
  /** Test seam for node-pty. Application code should use the default. */
  nativePty?: NativePtyFactory;
}

const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_CLEANUP_DEADLINE_MS = 15_000;
const MAX_CLEANUP_DEADLINE_MS = 60_000;
const DEFAULT_SPAWN_DEADLINE_MS = 30_000;
const MAX_SPAWN_DEADLINE_MS = 60_000;
const DEFAULT_NATIVE_PTY: NativePtyFactory = {
  spawn: (executable, args, options) => nodePty.spawn(executable, [...args], options),
};

function validateSpawnSpec(spec: PtySpawnSpec): void {
  if (!spec.executable || spec.executable.includes('\0')) {
    throw new ValidationError('PTY executable must be a non-empty, NUL-free path or command', { executable: 'invalid' });
  }
  if (!spec.cwd || spec.cwd.includes('\0')) {
    throw new ValidationError('PTY cwd must be a non-empty, NUL-free path', { cwd: 'invalid' });
  }
  if (spec.args.some((argument) => argument.includes('\0'))) {
    throw new ValidationError('PTY argv entries must not contain NUL bytes', { args: 'contains NUL byte' });
  }
  if (!Number.isInteger(spec.cols) || spec.cols < 1) {
    throw new ValidationError('PTY cols must be a positive integer', { cols: 'must be >= 1' });
  }
  if (!Number.isInteger(spec.rows) || spec.rows < 1) {
    throw new ValidationError('PTY rows must be a positive integer', { rows: 'must be >= 1' });
  }
}

function orderDescendantsFirst(
  records: readonly ProcessRecord[],
  rootPid: number,
  allowed: ReadonlySet<number>,
): ProcessRecord[] {
  const parentByPid = new Map(records.map((record) => [record.pid, record.parentPid]));
  const depth = (pid: number): number => {
    let current = pid;
    let value = 1;
    const visited = new Set<number>([pid]);
    while (parentByPid.has(current)) {
      const parent = parentByPid.get(current)!;
      if (parent === rootPid) return value;
      if (!allowed.has(parent) || visited.has(parent)) return value;
      visited.add(parent);
      current = parent;
      value++;
    }
    return value;
  };
  const byPid = new Map(records.map((record) => [record.pid, record]));
  return [...allowed]
    .filter((pid) => pid !== rootPid)
    .sort((left, right) => depth(right) - depth(left) || right - left)
    .flatMap((pid) => (byPid.has(pid) ? [byPid.get(pid)!] : []));
}

class ProcessOwnershipIndeterminateError extends Error {
  constructor(
    message: string,
    readonly safeDescendants: readonly PtyProcessIdentity[] = [],
  ) {
    super(message);
    this.name = 'ProcessOwnershipIndeterminateError';
  }
}

class SystemPtyProcessTreeAdapter implements PtyProcessTreeAdapter {
  constructor(readonly platform: PtyPlatform) {}

  async captureRootIdentity(rootPid: number): Promise<PtyProcessIdentity | undefined> {
    if (this.platform === 'linux') {
      const root = await readLinuxProcessIdentity(rootPid);
      if (!root || root.sessionId !== rootPid) return undefined;
      return root;
    }
    const records = await this.readWindowsProcessTableAsync();
    const root = records.find((record) => record.pid === rootPid);
    if (!root) return undefined;
    return root;
  }

  async snapshotDescendants(
    root: PtyProcessIdentity,
  ): Promise<readonly PtyProcessIdentity[]> {
    const records = await this.readProcessTableAsync();
    const currentRoot = records.find((record) => record.pid === root.pid);
    // A different process reusing the root PID invalidates the saved tree. An
    // absent Linux root does not: session survivors retain the original SID.
    if (currentRoot && !sameProcess(currentRoot, root)) {
      const safeDescendants =
        this.platform === 'linux' && root.sessionId
          ? selectSafeLinuxSurvivorsAfterReuse(records, root, currentRoot)
          : [];
      throw new ProcessOwnershipIndeterminateError(
        `PTY root PID ${root.pid} was reused with a different process identity`,
        safeDescendants,
      );
    }
    if (this.platform === 'linux') {
      if (
        !root.sessionId ||
        (currentRoot !== undefined && currentRoot.sessionId !== root.sessionId)
      ) {
        throw new ProcessOwnershipIndeterminateError(
          `PTY root PID ${root.pid} no longer owns session ${root.sessionId ?? 'unknown'}`,
        );
      }
      const allowed = new Set(
        records
          .filter(
            (record) => record.sessionId === root.sessionId && record.pid !== root.pid,
          )
          .map((record) => record.pid),
      );
      return orderDescendantsFirst(records, root.pid, allowed);
    }
    return selectWindowsDescendants(records, root);
  }

  async signal(
    identity: PtyProcessIdentity,
    signal: PtyTerminationSignal,
  ): Promise<void> {
    if (this.platform === 'linux') {
      // Do not depend on full process-table enumeration here. A snapshot may
      // fail while the root's bounded procfs identity remains revalidatable.
      const current = await readLinuxProcessIdentity(identity.pid);
      if (
        !current ||
        !sameProcess(current, identity) ||
        identity.sessionId === undefined ||
        current.sessionId !== identity.sessionId
      ) {
        return;
      }
      try {
        process.kill(identity.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      return;
    }
    throw new RuntimeStateError('Individual Windows PTY signalling is forbidden; use signalMany');
  }

  async signalMany(
    identities: readonly PtyProcessIdentity[],
    signal: PtyTerminationSignal,
  ): Promise<void> {
    if (this.platform === 'linux') {
      const results = await Promise.allSettled(
        identities.map((identity) => this.signal(identity, signal)),
      );
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length > 0) throw cleanupError(errors);
      return;
    }
    if (identities.length === 0) return;
    const payload = JSON.stringify(identities);
    await execFileBounded('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_IDENTITY_SAFE_TERMINATION_COMMAND,
    ], payload);
  }

  wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async readProcessTableAsync(): Promise<ProcessRecord[]> {
    if (this.platform === 'linux') {
      const processIds = parseLinuxProcessIds(
        await execFileBounded('ps', ['-eo', 'pid=']),
      );
      return readLinuxIdentitiesBounded(processIds);
    }
    return this.readWindowsProcessTableAsync();
  }

  private async readWindowsProcessTableAsync(): Promise<ProcessRecord[]> {
    const output = await execFileBounded('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_PROCESS_TABLE_COMMAND,
    ]);
    return parseWindowsProcessTable(output);
  }
}

function sameProcess(
  current: PtyProcessIdentity,
  expected: PtyProcessIdentity,
): boolean {
  return current.pid === expected.pid && current.creationToken === expected.creationToken;
}

function defaultProcessTreeAdapter(): PtyProcessTreeAdapter {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    throw new RuntimeStateError(`Attached PTY is unsupported on platform: ${process.platform}`);
  }
  return new SystemPtyProcessTreeAdapter(process.platform);
}

async function signalAll(
  adapter: PtyProcessTreeAdapter,
  identities: readonly PtyProcessIdentity[],
  signal: PtyTerminationSignal,
  errors: unknown[],
): Promise<void> {
  if (adapter.signalMany) {
    try {
      await adapter.signalMany(identities, signal);
    } catch (error) {
      errors.push(error);
    }
    return;
  }
  for (const identity of identities) {
    try {
      await adapter.signal(identity, signal);
    } catch (error) {
      errors.push(error);
    }
  }
}

function cleanupError(errors: readonly unknown[]): Error {
  const detail = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join('; ');
  return new Error(`PTY process-tree cleanup failed: ${boundedError(detail)}`);
}

export class PtyDeadlineExceededError extends Error {
  constructor(label: string, deadlineMs: number) {
    super(`${label} exceeded hard deadline (${deadlineMs}ms)`);
    this.name = 'PtyDeadlineExceededError';
  }
}

async function withHardDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PtyDeadlineExceededError(label, deadlineMs)),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class NodePtySession implements PtySession {
  private killPromise?: Promise<void>;

  constructor(
    private readonly native: NativePtyHandle,
    private readonly processTree: PtyProcessTreeAdapter,
    private readonly terminationGraceMs: number,
    private readonly cleanupDeadlineMs: number,
    private readonly rootIdentity: PtyProcessIdentity,
    private readonly windowsNativeClose: WindowsNativeCloser,
    private readonly handoff: EarlyPtyEventHandoff,
  ) {}

  get pid(): number {
    return this.native.pid;
  }

  onData(listener: (data: string) => void): PtyDisposable {
    return this.handoff.onData(listener);
  }

  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable {
    return this.handoff.onExit(listener);
  }

  write(data: string): void {
    this.native.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
      throw new ValidationError('PTY dimensions must be positive integers', { cols: 'must be >= 1', rows: 'must be >= 1' });
    }
    this.native.resize(cols, rows);
  }

  kill(): Promise<void> {
    this.killPromise ??= withHardDeadline(
      () => this.terminateProcessTree(),
      this.cleanupDeadlineMs,
      'PTY cleanup',
    );
    return this.killPromise;
  }

  private async terminateProcessTree(): Promise<void> {
    const errors: unknown[] = [];
    const root = this.rootIdentity;
    try {
      this.handoff.dispose();
    } catch (error) {
      errors.push(error);
    }

    if (this.processTree.platform === 'win32') {
      // ConPTY close may reparent children, so preserve the PID tree first.
      let descendants: readonly PtyProcessIdentity[] = [];
      try {
        descendants = await this.processTree.snapshotDescendants(root);
      } catch (error) {
        if (error instanceof ProcessOwnershipIndeterminateError) {
          descendants = error.safeDescendants;
        }
        errors.push(error);
      }
      try {
        await this.windowsNativeClose(this.native);
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.processTree.wait(this.terminationGraceMs);
      } catch (error) {
        errors.push(error);
      }
      await signalAll(this.processTree, [...descendants, root], 'SIGKILL', errors);
    } else {
      let descendants: readonly PtyProcessIdentity[] = [];
      try {
        descendants = await this.processTree.snapshotDescendants(root);
      } catch (error) {
        if (error instanceof ProcessOwnershipIndeterminateError) {
          descendants = error.safeDescendants;
        }
        errors.push(error);
      }
      await signalAll(this.processTree, [...descendants, root], 'SIGTERM', errors);
      try {
        await this.processTree.wait(this.terminationGraceMs);
      } catch (error) {
        errors.push(error);
      }
      let survivors: readonly PtyProcessIdentity[] = [];
      try {
        survivors = await this.processTree.snapshotDescendants(root);
      } catch (error) {
        if (error instanceof ProcessOwnershipIndeterminateError) {
          survivors = error.safeDescendants;
        }
        errors.push(error);
      }
      const killIdentities = uniqueIdentities([...survivors, ...descendants, root]);
      await signalAll(this.processTree, killIdentities, 'SIGKILL', errors);
    }

    if (errors.length > 0) {
      throw cleanupError(errors);
    }
  }
}

function uniqueIdentities(
  identities: readonly PtyProcessIdentity[],
): PtyProcessIdentity[] {
  const result = new Map<string, PtyProcessIdentity>();
  for (const identity of identities) {
    result.set(`${identity.pid}:${identity.creationToken}`, identity);
  }
  return [...result.values()];
}

export class NodePtyHost implements PtyHost {
  private readonly processTree: PtyProcessTreeAdapter;
  private readonly terminationGraceMs: number;
  readonly cleanupDeadlineMs: number;
  readonly spawnDeadlineMs: number;
  private readonly nativePty: NativePtyFactory;
  private readonly windowsNativeClose: WindowsNativeCloser;
  /** In-flight unwinds of spawns that settled after their deadline. */
  private readonly pendingSpawnUnwinds = new Set<Promise<void>>();
  /** Failed late unwinds retained (bounded) until a shutdown drain reports them. */
  private readonly lateSpawnUnwindFailures: Error[] = [];

  constructor(options: NodePtyHostOptions = {}) {
    this.processTree = options.processTree ?? defaultProcessTreeAdapter();
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.cleanupDeadlineMs = options.cleanupDeadlineMs ?? DEFAULT_CLEANUP_DEADLINE_MS;
    this.spawnDeadlineMs = options.spawnDeadlineMs ?? DEFAULT_SPAWN_DEADLINE_MS;
    this.nativePty = options.nativePty ?? DEFAULT_NATIVE_PTY;
    this.windowsNativeClose = options.windowsNativeClose ?? closePinnedWindowsConpty;
    if (!Number.isInteger(this.terminationGraceMs) || this.terminationGraceMs < 0) {
      throw new ValidationError('PTY termination grace must be a non-negative integer', { terminationGraceMs: 'must be >= 0' });
    }
    if (
      !Number.isInteger(this.cleanupDeadlineMs) ||
      this.cleanupDeadlineMs < 1 ||
      this.cleanupDeadlineMs > MAX_CLEANUP_DEADLINE_MS ||
      this.cleanupDeadlineMs > 2_147_483_647
    ) {
      throw new ValidationError(
        `PTY cleanup deadline must be an integer between 1 and ${MAX_CLEANUP_DEADLINE_MS}`,
        { cleanupDeadlineMs: 'out of range' },
      );
    }
    if (
      !Number.isInteger(this.spawnDeadlineMs) ||
      this.spawnDeadlineMs < 1 ||
      this.spawnDeadlineMs > MAX_SPAWN_DEADLINE_MS
    ) {
      throw new ValidationError(
        `PTY spawn deadline must be an integer between 1 and ${MAX_SPAWN_DEADLINE_MS}`,
        { spawnDeadlineMs: 'out of range' },
      );
    }
    if (this.terminationGraceMs >= this.cleanupDeadlineMs) {
      throw new ValidationError('PTY termination grace must be shorter than cleanup deadline', { terminationGraceMs: 'must be < cleanupDeadlineMs' });
    }
  }

  /**
   * Spawn with a hard settlement deadline. If the underlying operation loses
   * the race but later yields a live session, that session's full process-tree
   * kill is tracked and surfaced through {@link drainPendingSpawnUnwinds}.
   */
  async spawn(spec: PtySpawnSpec): Promise<PtySession> {
    validateSpawnSpec(spec);
    const operation = this.spawnSession(spec);
    try {
      return await withHardDeadline(() => operation, this.spawnDeadlineMs, 'PTY spawn');
    } catch (error) {
      if (error instanceof PtyDeadlineExceededError) this.trackLateSpawnUnwind(operation);
      throw error;
    }
  }

  async drainPendingSpawnUnwinds(): Promise<void> {
    while (this.pendingSpawnUnwinds.size > 0) {
      // These promises never reject; failures land in lateSpawnUnwindFailures.
      await Promise.all([...this.pendingSpawnUnwinds]);
    }
    const failures = this.lateSpawnUnwindFailures.splice(0);
    if (failures.length > 0) throw cleanupError(failures);
  }

  private trackLateSpawnUnwind(operation: Promise<PtySession>): void {
    const unwind: Promise<void> = operation.then(
      (session) =>
        session.kill().then(
          () => undefined,
          (error) => {
            if (this.lateSpawnUnwindFailures.length < 20) {
              this.lateSpawnUnwindFailures.push(
                new Error(
                  `late PTY spawn unwind failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
            }
          },
        ),
      // A rejected spawn already unwound itself on its own failure path.
      () => undefined,
    );
    this.pendingSpawnUnwinds.add(unwind);
    // Successful unwinds must not accumulate for the runner's whole uptime.
    void unwind.finally(() => this.pendingSpawnUnwinds.delete(unwind));
  }

  private async spawnSession(spec: PtySpawnSpec): Promise<PtySession> {
    const native = this.nativePty.spawn(spec.executable, [...spec.args], {
      name: spec.name ?? 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: { ...spec.env },
      useConpty: this.processTree.platform === 'win32' ? true : undefined,
      useConptyDll: this.processTree.platform === 'win32' ? false : undefined,
    });
    let handoff: EarlyPtyEventHandoff;
    try {
      handoff = new EarlyPtyEventHandoff(native);
    } catch (handoffError) {
      let unwindError: unknown;
      if (this.processTree.platform === 'win32') {
        try {
          await unwindDriftedWindowsConpty(native);
        } catch (error) {
          unwindError = error;
        }
      }
      // Linux has no ownership-safe unwind for a handle without a captured
      // identity; delegate to the runner's control-group termination.
      const notes =
        this.processTree.platform === 'linux'
          ? [new Error('cleanup ownership indeterminate; runner control-group termination required')]
          : [];
      throw cleanupError([handoffError, ...notes, ...(unwindError ? [unwindError] : [])]);
    }
    if (this.processTree.platform === 'win32') {
      try {
        validatePinnedWindowsConpty(native);
      } catch (guardError) {
        const errors: unknown[] = [guardError];
        try {
          handoff.dispose();
        } catch (error) {
          errors.push(error);
        }
        try {
          await unwindDriftedWindowsConpty(native);
        } catch (error) {
          errors.push(error);
        }
        throw cleanupError(errors);
      }
    }
    let rootIdentity: PtyProcessIdentity | undefined;
    let confirmedIdentity: PtyProcessIdentity | undefined;
    let captureError: unknown;
    try {
      rootIdentity = await this.processTree.captureRootIdentity(native.pid);
      // Let queued exit/data delivery win before the exact second identity read.
      await new Promise<void>((resolve) => setImmediate(resolve));
      confirmedIdentity = await this.processTree.captureRootIdentity(native.pid);
    } catch (error) {
      captureError = error;
    }
    const identityStable =
      rootIdentity !== undefined &&
      confirmedIdentity !== undefined &&
      sameProcess(rootIdentity, confirmedIdentity) &&
      rootIdentity.sessionId === confirmedIdentity.sessionId;
    if (identityStable && (handoff.hasExited || handoff.failure)) {
      const startupError =
        handoff.failure ?? new Error('provider exited during identity capture');
      const rollback = new NodePtySession(
        native,
        this.processTree,
        this.terminationGraceMs,
        this.cleanupDeadlineMs,
        confirmedIdentity!,
        this.windowsNativeClose,
        handoff,
      );
      let rollbackError: unknown;
      try {
        await rollback.kill();
      } catch (error) {
        rollbackError = error;
      }
      throw cleanupError([startupError, ...(rollbackError ? [rollbackError] : [])]);
    }
    if (captureError || !identityStable) {
      let unwindError: unknown;
      if (this.processTree.platform === 'win32') {
        try {
          await this.windowsNativeClose(native);
        } catch (error) {
          unwindError = error;
        }
      }
      let handoffDisposeError: unknown;
      try {
        handoff.dispose();
      } catch (error) {
        handoffDisposeError = error;
      }
      const detail = [
        `Cannot capture stable PTY process identity for PID ${native.pid}`,
        captureError instanceof Error ? captureError.message : undefined,
        rootIdentity && confirmedIdentity && !identityStable
          ? 'process identity changed during capture confirmation'
          : undefined,
        this.processTree.platform === 'linux'
          ? 'cleanup ownership indeterminate; runner control-group termination required'
          : unwindError
            ? 'cleanup ownership indeterminate; runner control-group termination required'
            : 'ownership-safe ConPTY unwind completed',
        unwindError instanceof Error ? `ownership unwind failed: ${unwindError.message}` : undefined,
        handoffDisposeError instanceof Error
          ? `early-event handoff dispose failed: ${handoffDisposeError.message}`
          : undefined,
      ]
        .filter(Boolean)
        .join('; ');
      throw new RuntimeStateError(detail);
    }
    return new NodePtySession(
      native,
      this.processTree,
      this.terminationGraceMs,
      this.cleanupDeadlineMs,
      confirmedIdentity!,
      this.windowsNativeClose,
      handoff,
    );
  }
}
