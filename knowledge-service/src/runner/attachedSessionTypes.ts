import type { AttachedRestartPolicy } from './attachedRestartPolicy';
import type { AttachedTaskMarker } from './attachedTaskMarkerStore';
import type { PtyDisposable, PtySession, PtySpawnSpec } from './ptyHost';
import type { LaunchRequest } from './sessionLauncher';

export type AttachedSessionState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'draining'
  | 'attention_required'
  | 'failed'
  | 'stopping';

export interface AttachedTerminalPolicy {
  expectedIslandId: string;
  spawn: PtySpawnSpec;
  startupTimeoutMs: number;
  readyConfirmSamples?: number;
  idleSettleMs: number;
  idleConfirmSamples: number;
  /** Provider-specific screen policy lands in D; C only consumes its verdict. */
  isReadySample(data: string): boolean;
  /** Provider-specific idle/prompt classifier; only draining samples count. */
  isIdleSample(data: string): boolean;
  /** Provider-specific safe input encoding lands in D. */
  encodeDispatch(request: LaunchRequest): string;
}

export interface AttachedSessionManagerOptions {
  restart?: Partial<AttachedRestartPolicy>;
  cleanupMarginMs?: number;
  /** Injectable entropy makes jitter deterministic under test. */
  random?: () => number;
  now?: () => number;
  createGateToken?: () => string;
}

export interface AttachedSessionSnapshot {
  terminal: string;
  state: AttachedSessionState;
  pid?: number;
  messageId?: string;
  lastError?: string;
  restartAttempt?: number;
  sessionGeneration?: number;
  outputEpoch: number;
  receiptSequence?: number;
  completionGate?: string;
  lastOutputAt: number;
  idleConfirmationCount: number;
}

export function createAttachedSessionSnapshot(
  terminal: string,
  current: RuntimeSession,
): AttachedSessionSnapshot {
  return {
    terminal,
    state: current.state,
    pid: current.session?.pid,
    messageId: current.messageId,
    lastError: current.lastError,
    restartAttempt: current.restartAttempts || undefined,
    sessionGeneration: current.session ? current.generation : undefined,
    outputEpoch: current.outputEpoch,
    receiptSequence: current.receiptSequence,
    completionGate: current.completionIdleGate?.id,
    lastOutputAt: current.lastOutputAt,
    idleConfirmationCount: current.idleConfirmationCount,
  };
}

export interface AttachedStableIdleProof {
  terminal: string;
  messageId: string;
  sessionGeneration: number;
  receiptSequence: number;
  outputEpoch: number;
  completionGate: string;
  settledAt: string;
}

export interface CompletionIdleGate {
  id: string;
  sessionGeneration: number;
  receiptSequence: number;
  outputEpoch: number;
  receiptCompletedAtMs: number;
  armedAtMs: number;
}

export interface RuntimeSession {
  state: AttachedSessionState;
  session?: PtySession;
  dataSubscription?: PtyDisposable;
  exitSubscription?: PtyDisposable;
  messageId?: string;
  markerGeneration?: number;
  receiptSequence?: number;
  completedBeforeExit: boolean;
  lastError?: string;
  readySamples: number;
  readyPending: boolean;
  replayingBufferedEvents: boolean;
  automaticAttempt: boolean;
  outputEpoch: number;
  completionGateCounter: number;
  completionIdleGate?: CompletionIdleGate;
  controllerInputPending: boolean;
  sessionUsable: boolean;
  cleanupIndeterminate: boolean;
  attentionReason?: AttachedAttentionReason;
  lastOutputAt: number;
  idleConfirmationCount: number;
  lastIdleSampleAt?: number;
  generation: number;
  readiness?: Promise<void>;
  spawnPromise?: Promise<void>;
  resolveReadiness?: () => void;
  rejectReadiness?: (error: Error) => void;
  startupTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  stabilityTimer?: NodeJS.Timeout;
  restartAttempts: number;
  restartBudgetExhausted: boolean;
}

export type AttachedAttentionReason =
  | 'input_outcome_unknown'
  | 'marker_persist_failed'
  | 'completion_persist_failed'
  | 'marker_cleanup_failed'
  | 'cleanup_indeterminate'
  | 'idle_classifier_failed'
  | 'task_crash'
  | 'stale_marker';

export type BufferedPtyEvent =
  | { kind: 'data'; data: string }
  | { kind: 'exit'; exitCode: number };

export function createRuntimeSession(marker: AttachedTaskMarker | undefined): RuntimeSession {
  return {
    state: marker ? 'attention_required' : 'stopped',
    messageId: marker?.messageId,
    markerGeneration: marker?.generation,
    receiptSequence: marker?.receiptSequence,
    completedBeforeExit: marker?.phase === 'completed',
    lastError: marker ? 'stale attached task marker requires reconciliation' : undefined,
    readySamples: 0,
    readyPending: false,
    replayingBufferedEvents: false,
    automaticAttempt: false,
    outputEpoch: 0,
    completionGateCounter: 0,
    controllerInputPending: false,
    sessionUsable: false,
    cleanupIndeterminate: false,
    attentionReason: marker ? 'stale_marker' : undefined,
    lastOutputAt: 0,
    idleConfirmationCount: 0,
    generation: 0,
    restartAttempts: 0,
    restartBudgetExhausted: false,
  };
}

export class AttachedLifecycleError extends Error {
  readonly errors: readonly Error[];

  constructor(message: string, errors: readonly Error[]) {
    super(message);
    this.name = 'AttachedLifecycleError';
    this.errors = errors;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
