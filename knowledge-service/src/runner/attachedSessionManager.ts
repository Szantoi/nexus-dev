import { randomUUID } from 'node:crypto';
import type {
  AttachedTaskMarker,
  AttachedTaskMarkerStore,
} from './attachedTaskMarkerStore';
import {
  acknowledgeLiveCompletion,
  reconcileCompletionReceipt,
} from './attachedCompletionReceipt';
import {
  appendLifecycleErrors,
  clearAttachedTask,
  disposeAttachedSession,
  disposeAttachedSubscriptions,
  normalizeCleanupMarginMs,
  summarizeLifecycleErrors,
} from './attachedSessionCleanup';
import { dispatchAttachedTask } from './attachedDispatch';
import {
  calculateRestartDelay,
  clearStabilityTimer,
  normalizeRestartPolicy,
  scheduleStabilityReset,
  type AttachedRestartPolicy,
} from './attachedRestartPolicy';
import {
  clearAttachedRestartTimer,
  clearAttachedStartupTimer,
  countActiveAttachedSessions,
  createAttachedSessionMatcher,
  ensureAttachedReadiness,
  rejectAttachedReadiness,
  requireAttachedRuntime,
  resolveAttachedReadiness,
} from './attachedSessionRuntime';
import {
  asError,
  AttachedLifecycleError,
  type BufferedPtyEvent,
  createAttachedSessionSnapshot,
  createRuntimeSession,
  type RuntimeSession,
  type AttachedSessionManagerOptions,
  type AttachedSessionSnapshot,
  type AttachedStableIdleProof,
  type AttachedTerminalPolicy,
  errorText,
} from './attachedSessionTypes';
import type { PtyHost, PtySession } from './ptyHost';
import type { RunnerCompletionReceipt } from './serverClient';
import type { LaunchRequest, LaunchResult } from './sessionLauncher';
import type { TerminalSink } from './terminalSink';
import { evaluateStableIdleProof } from './attachedStableIdle';
import { armAttachedStartupTimeout } from './attachedStartupTimeout';
import { validateAttachedTerminalPolicy } from './attachedTerminalPolicy';
export {
  AttachedLifecycleError,
  type AttachedSessionManagerOptions,
  type AttachedSessionSnapshot,
  type AttachedSessionState,
  type AttachedStableIdleProof,
  type AttachedTerminalPolicy,
} from './attachedSessionTypes';
/**
 * Provider-neutral lifecycle owner for persistent attached terminals.
 * Completion and idle facts are supplied explicitly; PTY text never completes
 * a task. A durable active marker is written before any PTY task input.
 */
export class AttachedSessionManager implements TerminalSink {
  private readonly runtime = new Map<string, RuntimeSession>();
  private readonly restartPolicy: AttachedRestartPolicy;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly createGateToken: () => string;
  private readonly cleanupMarginMs: number;
  private readonly clearRestart = clearAttachedRestartTimer;
  private readonly clearStartupTimer = clearAttachedStartupTimer;
  private readonly ensureReadiness = ensureAttachedReadiness;
  private readonly isCurrentSession = createAttachedSessionMatcher(this.runtime);
  private readonly rejectReadiness = rejectAttachedReadiness;
  private readonly requireRuntime = (terminal: string) => requireAttachedRuntime(this.runtime, terminal);
  private readonly resolveReadiness = resolveAttachedReadiness;
  private shuttingDown = false;
  constructor(
    private readonly policies: ReadonlyMap<string, AttachedTerminalPolicy>,
    private readonly ptyHost: PtyHost,
    private readonly markers: AttachedTaskMarkerStore,
    options: AttachedSessionManagerOptions = {},
  ) {
    this.restartPolicy = normalizeRestartPolicy(options.restart);
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.createGateToken = options.createGateToken ?? randomUUID;
    this.cleanupMarginMs = normalizeCleanupMarginMs(options.cleanupMarginMs);
    for (const [terminal, policy] of policies) {
      validateAttachedTerminalPolicy(terminal, policy);
      const marker = markers.load(terminal);
      this.runtime.set(terminal, createRuntimeSession(marker));
    }
  }
  async ensureReady(): Promise<void> {
    if (this.shuttingDown) throw new Error('attached session manager is shutting down');
    const startups: Promise<void>[] = [];
    for (const terminal of this.policies.keys()) {
      const current = this.requireRuntime(terminal);
      if (
        current.session &&
        !['starting', 'ready', 'busy', 'draining'].includes(current.state)
      ) {
        throw new Error(`attached terminal has a tracked PTY pending cleanup: ${terminal}`);
      }
      if (current.state === 'attention_required') {
        throw new Error(`attached terminal requires reconciliation: ${terminal}`);
      }
      if (current.state === 'failed' && current.messageId && !current.completedBeforeExit) {
        throw new Error(`attached terminal has unresolved work: ${terminal}`);
      }
      if (current.restartBudgetExhausted) {
        throw new Error(`attached terminal restart budget exhausted: ${terminal}`);
      }
    }
    try {
      for (const terminal of this.policies.keys()) {
        const current = this.requireRuntime(terminal);
        if (current.state === 'ready' || current.state === 'busy' || current.state === 'draining') {
          continue;
        }
        if ((current.state === 'starting' || current.restartTimer) && current.readiness) {
          startups.push(current.readiness);
        } else {
          startups.push(this.startTerminal(terminal));
        }
      }
      await Promise.all(startups);
    } catch (error) {
      const nativeSpawnPending = [...this.runtime.values()].some(
        (current) => current.spawnPromise !== undefined && current.session === undefined,
      );
      if (nativeSpawnPending) {
        void this.shutdown('preflight-rollback').catch(() => undefined);
        throw error;
      }
      try {
        await this.shutdown('preflight-rollback');
      } catch (cleanupError) {
        const original = asError(error);
        const cleanup = asError(cleanupError);
        throw new AttachedLifecycleError(
          `attached preflight failed: ${original.message}; rollback failed: ${cleanup.message}`,
          [original, cleanup],
        );
      }
      throw error;
    }
  }

  dispatch(request: LaunchRequest): LaunchResult {
    return dispatchAttachedTask(
      this.runtime.get(request.terminal),
      this.policies.get(request.terminal),
      this.markers,
      request,
    );
  }

  isBusy(terminal: string): boolean {
    const state = this.runtime.get(terminal)?.state;
    return !state || !['stopped', 'ready'].includes(state);
  }

  cancel(terminal: string, reason = 'cancelled'): boolean {
    const current = this.runtime.get(terminal);
    if (!current || current.state === 'stopping') return false;
    clearStabilityTimer(current);
    let cancelled = this.clearRestart(current);
    if (!current.session) {
      const pendingSpawn = current.spawnPromise !== undefined || current.state === 'starting';
      cancelled ||= pendingSpawn;
      if (pendingSpawn) {
        // Invalidate the generation before the native spawn resolves. The spawn
        // continuation owns the late session and must await its process-tree kill.
        current.generation++;
        current.state = 'stopping';
        current.sessionUsable = false;
        current.lastError = reason;
        this.rejectReadiness(current, new Error(reason));
      } else if (cancelled) {
        this.rejectReadiness(current, new Error(reason));
        current.state = current.messageId ? 'attention_required' : 'stopped';
        current.lastError = reason;
      }
      return cancelled;
    }
    cancelled = true;
    const session = current.session;
    const generation = current.generation;
    current.state = 'stopping';
    current.sessionUsable = false;
    current.lastError = reason;
    void session.kill().then(
      () => this.finishStop(terminal, session, generation),
      (error) => {
        if (!this.isCurrentSession(terminal, session, generation)) return;
        current.state = 'attention_required';
        current.cleanupIndeterminate = true;
        current.attentionReason = 'cleanup_indeterminate';
        current.lastError = `PTY cleanup failed: ${errorText(error)}`;
      },
    );
    return cancelled;
  }

  cancelAll(reason = 'runner-shutdown'): number {
    let count = 0;
    for (const terminal of this.runtime.keys()) {
      if (this.cancel(terminal, reason)) count++;
    }
    return count;
  }

  activeCount(): number {
    return countActiveAttachedSessions(this.runtime);
  }

  minimumShutdownGraceMs(): number {
    return this.ptyHost.cleanupDeadlineMs + this.cleanupMarginMs;
  }

  async shutdown(reason = 'runner-shutdown'): Promise<void> {
    this.shuttingDown = true;
    const stops: Promise<void>[] = [];
    const shutdownError = new Error(`attached session manager stopped: ${reason}`);
    for (const [terminal, current] of this.runtime) {
      this.clearRestart(current);
      this.clearStartupTimer(current);
      clearStabilityTimer(current);
      this.rejectReadiness(current, shutdownError);
      current.readyPending = false;
      if (current.spawnPromise) stops.push(current.spawnPromise);
      if (!current.session) {
        if (current.messageId) {
          current.state = 'attention_required';
          current.lastError = reason;
        } else if (reason !== 'preflight-rollback') {
          current.state = 'stopped';
          current.lastError = undefined;
        }
        continue;
      }
      const session = current.session;
      const generation = current.generation;
      current.state = 'stopping';
      current.sessionUsable = false;
      current.lastError = reason;
      stops.push(
        session.kill().then(
          () => {
            const errors = this.finishStop(terminal, session, generation);
            if (errors.length > 0) {
              throw new AttachedLifecycleError('PTY subscription cleanup failed', errors);
            }
          },
          (error) => {
            if (this.isCurrentSession(terminal, session, generation)) {
              current.state = 'attention_required';
              current.cleanupIndeterminate = true;
              current.attentionReason = 'cleanup_indeterminate';
              current.lastError = `PTY cleanup failed: ${errorText(error)}`;
            }
            throw error;
          },
        ),
      );
    }
    const results = await Promise.allSettled(stops);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => asError(result.reason));
    if (failures.length > 0) {
      throw new AttachedLifecycleError(
        `attached PTY shutdown failed for ${failures.length} session(s): ${summarizeLifecycleErrors(failures)}`,
        failures,
      );
    }
  }

  /** Record a server-authoritative, monotonically sequenced completion receipt. */
  acknowledgeCompletion(receipt: RunnerCompletionReceipt): boolean {
    return acknowledgeLiveCompletion(
      this.markers,
      this.runtime.get(receipt.terminalId),
      this.policies.get(receipt.terminalId),
      receipt,
      this.createGateToken,
      this.now(),
    );
  }

  acknowledgeStableIdle(proof: AttachedStableIdleProof): boolean {
    const current = this.runtime.get(proof.terminal);
    const policy = this.policies.get(proof.terminal);
    const result = evaluateStableIdleProof(this.markers, current, policy, proof, this.now());
    if (result.status === 'error' && current) {
      current.state = 'attention_required';
      current.attentionReason = 'marker_cleanup_failed';
      current.lastError = result.error;
      return false;
    }
    if (result.status !== 'released' || !current) return false;
    clearAttachedTask(current);
    current.state = 'ready';
    scheduleStabilityReset(current, this.restartPolicy);
    return true;
  }

  /** Promote an exact server receipt durably; readiness performs the later CAS-clear. */
  reconcileMarker(receipt: RunnerCompletionReceipt): boolean {
    const terminal = receipt.terminalId;
    const current = this.runtime.get(terminal);
    const policy = this.policies.get(terminal);
    const result = reconcileCompletionReceipt(
      this.markers,
      current,
      policy,
      receipt,
      this.createGateToken,
      this.now(),
    );
    if (result === 'restart') {
      this.scheduleRestart(terminal, 'durable completion receipt reconciled');
    }
    return result !== 'rejected';
  }

  snapshot(terminal: string): AttachedSessionSnapshot | undefined {
    const current = this.runtime.get(terminal);
    return current ? createAttachedSessionSnapshot(terminal, current) : undefined;
  }

  private startTerminal(terminal: string): Promise<void> {
    const current = this.requireRuntime(terminal);
    if (this.shuttingDown) {
      return Promise.reject(new Error('attached session manager is shutting down'));
    }
    if (current.session) {
      if (current.state === 'starting' && current.readiness) return current.readiness;
      return Promise.reject(
        new Error(`cannot start attached terminal while a PTY is still tracked: ${terminal}`),
      );
    }
    if ((current.state === 'starting' || current.restartTimer) && current.readiness) {
      return current.readiness;
    }
    if (!['stopped', 'failed'].includes(current.state)) {
      return Promise.reject(new Error(`cannot start attached terminal ${terminal}: ${current.state}`));
    }
    if (current.messageId && !current.completedBeforeExit) {
      return Promise.reject(
        new Error(`cannot restart attached terminal with unresolved work: ${terminal}`),
      );
    }
    if (current.restartBudgetExhausted) {
      return Promise.reject(new Error(`attached terminal restart budget exhausted: ${terminal}`));
    }
    const readiness = this.ensureReadiness(current);
    this.spawnAttempt(terminal, false);
    return readiness;
  }

  private spawnAttempt(terminal: string, automatic: boolean): void {
    const current = this.requireRuntime(terminal);
    const operation = this.runSpawnAttempt(terminal, automatic);
    current.spawnPromise = operation;
    void operation.finally(() => {
      if (current.spawnPromise === operation) current.spawnPromise = undefined;
    }).catch(() => undefined);
  }

  private async runSpawnAttempt(terminal: string, automatic: boolean): Promise<void> {
    const current = this.requireRuntime(terminal);
    if (this.shuttingDown) {
      this.rejectReadiness(current, new Error('attached session manager is shutting down'));
      return;
    }
    if (current.session) {
      current.state = 'attention_required';
      const failure = `refusing to spawn while a PTY is still tracked: ${terminal}`;
      current.lastError = failure;
      current.sessionUsable = false;
      current.cleanupIndeterminate = true;
      current.attentionReason = 'cleanup_indeterminate';
      this.rejectReadiness(current, new Error(failure));
      return;
    }
    clearStabilityTimer(current);
    const policy = this.policies.get(terminal)!;
    current.state = 'starting';
    current.lastError = undefined;
    current.readySamples = 0;
    current.readyPending = false;
    current.automaticAttempt = automatic;
    current.generation++;
    const generation = current.generation;
    armAttachedStartupTimeout(
      terminal,
      current,
      generation,
      policy.startupTimeoutMs,
      (session, failure) => {
        if (!session) return this.rejectReadiness(current, new Error(failure));
        this.cleanupFailedStart(
          terminal,
          session,
          generation,
          appendLifecycleErrors(failure, disposeAttachedSubscriptions(current)),
          automatic,
        );
      },
    );

    let session: PtySession;
    try {
      session = await this.ptyHost.spawn(policy.spawn);
    } catch (error) {
      this.clearStartupTimer(current);
      if (current.generation !== generation || current.state !== 'starting') {
        current.state = current.messageId ? 'attention_required' : 'stopped';
        return;
      }
      const failure = `PTY spawn failed: ${errorText(error)}`;
      current.state = 'failed';
      current.lastError = failure;
      if (automatic) this.scheduleRestart(terminal, failure);
      else this.rejectReadiness(current, new Error(failure));
      return;
    }
    if (this.shuttingDown || current.generation !== generation || current.state !== 'starting') {
      current.session = session;
      current.sessionUsable = false;
      current.state = 'stopping';
      try {
        await session.kill();
      } catch (error) {
        const failure = `late PTY spawn cleanup failed: ${errorText(error)}`;
        current.state = 'attention_required';
        current.cleanupIndeterminate = true;
        current.attentionReason = 'cleanup_indeterminate';
        current.lastError = failure;
        this.rejectReadiness(current, new Error(failure));
        throw new Error(failure);
      }
      // Generation mismatch is the intentional cancellation signal here. Only
      // identity is needed to ensure we do not dispose a newer owned session.
      if (current.session === session) disposeAttachedSession(current);
      current.state = current.messageId ? 'attention_required' : 'stopped';
      this.rejectReadiness(current, new Error('PTY spawn completed after shutdown or invalidation'));
      return;
    }
    current.session = session;
    current.sessionUsable = true;
    current.cleanupIndeterminate = false;
    current.attentionReason = undefined;

    const buffered: BufferedPtyEvent[] = [];
    let registering = true;
    try {
      current.dataSubscription = session.onData((data) => {
        if (registering) buffered.push({ kind: 'data', data });
        else this.handleData(terminal, session, generation, data);
      });
      current.exitSubscription = session.onExit((event) => {
        if (registering) buffered.push({ kind: 'exit', exitCode: event.exitCode });
        else this.handleExit(terminal, session, generation, event.exitCode);
      });
    } catch (error) {
      registering = false;
      const failure = appendLifecycleErrors(
        `PTY callback registration failed: ${errorText(error)}`,
        disposeAttachedSubscriptions(current),
      );
      this.cleanupFailedStart(terminal, session, generation, failure, automatic);
      return;
    }
    registering = false;

    current.replayingBufferedEvents = true;
    try {
      for (const event of buffered) {
        if (!this.isCurrentSession(terminal, session, generation)) break;
        if (event.kind === 'data') this.handleData(terminal, session, generation, event.data);
        else this.handleExit(terminal, session, generation, event.exitCode);
      }
    } finally {
      current.replayingBufferedEvents = false;
    }
    if (
      current.readyPending &&
      current.state === 'starting' &&
      this.isCurrentSession(terminal, session, generation)
    ) {
      this.promoteReady(terminal, current);
    }
    if (!this.isCurrentSession(terminal, session, generation) || current.state !== 'starting') {
      return;
    }

  }

  private handleData(
    terminal: string,
    session: PtySession,
    generation: number,
    data: string,
  ): void {
    if (!this.isCurrentSession(terminal, session, generation)) return;
    const current = this.requireRuntime(terminal);
    current.outputEpoch++;
    current.lastOutputAt = Math.max(current.lastOutputAt, this.now());
    const policy = this.policies.get(terminal)!;
    if (current.state === 'draining') {
      try {
        if (policy.isIdleSample(data)) {
          current.idleConfirmationCount++;
          current.lastIdleSampleAt = current.lastOutputAt;
        } else {
          current.idleConfirmationCount = 0;
          current.lastIdleSampleAt = undefined;
        }
      } catch (error) {
        current.state = 'attention_required';
        current.attentionReason = 'idle_classifier_failed';
        current.lastError = `idle classifier failed: ${errorText(error)}`;
      }
      return;
    }
    current.idleConfirmationCount = 0;
    current.lastIdleSampleAt = undefined;
    if (current.state !== 'starting') return;
    let readySample: boolean;
    try {
      readySample = policy.isReadySample(data);
    } catch (error) {
      this.clearStartupTimer(current);
      const failure = appendLifecycleErrors(
        `readiness classifier failed: ${errorText(error)}`,
        disposeAttachedSubscriptions(current),
      );
      this.cleanupFailedStart(terminal, session, generation, failure, current.automaticAttempt);
      return;
    }
    current.readySamples = readySample ? current.readySamples + 1 : 0;
    if (current.readySamples < (policy.readyConfirmSamples ?? 2)) return;
    if (current.replayingBufferedEvents) {
      current.readyPending = true;
      return;
    }
    this.promoteReady(terminal, current);
  }

  private promoteReady(terminal: string, current: RuntimeSession): void {
    // A completed task whose PTY exited is not rerun. Its marker is cleared
    // only after the replacement terminal has proved ready.
    if (current.completedBeforeExit && current.messageId && current.markerGeneration !== undefined) {
      let marker: AttachedTaskMarker | undefined;
      let cleared = false;
      try {
        marker = this.markers.load(terminal);
        if (
          marker?.phase === 'completed' &&
          marker.messageId === current.messageId &&
          marker.generation === current.markerGeneration &&
          marker.receiptSequence === current.receiptSequence
        ) {
          cleared = this.markers.clear(terminal, current.messageId, current.markerGeneration);
        }
      } catch (error) {
        current.lastError = `completed marker cleanup failed: ${errorText(error)}`;
      }
      if (!cleared) {
        const error = new Error(
          current.lastError ?? `completed marker missing after PTY restart: ${terminal}`,
        );
        current.state = 'attention_required';
        current.attentionReason = 'marker_cleanup_failed';
        current.lastError = error.message;
        current.readyPending = false;
        this.clearStartupTimer(current);
        this.rejectReadiness(current, error);
        return;
      }
    }
    if (current.completedBeforeExit) clearAttachedTask(current);
    current.state = 'ready';
    current.lastError = undefined;
    current.readyPending = false;
    this.clearStartupTimer(current);
    scheduleStabilityReset(current, this.restartPolicy);
    this.resolveReadiness(current);
  }

  private handleExit(
    terminal: string,
    session: PtySession,
    generation: number,
    exitCode: number,
  ): void {
    if (!this.isCurrentSession(terminal, session, generation)) return;
    const current = this.requireRuntime(terminal);
    const previous = current.state;
    this.clearStartupTimer(current);
    clearStabilityTimer(current);
    const subscriptionErrors = disposeAttachedSubscriptions(current);
    current.readyPending = false;
    current.sessionUsable = false;
    current.state = 'stopping';
    current.lastError = `PTY root exited (code=${exitCode}); cleaning process tree`;
    void Promise.resolve()
      .then(() => session.kill())
      .then(
        () => {
          if (!this.isCurrentSession(terminal, session, generation)) return;
          const cleanupErrors = [...subscriptionErrors, ...disposeAttachedSession(current)];
          if (cleanupErrors.length > 0) {
            current.state = 'attention_required';
            current.cleanupIndeterminate = true;
            current.attentionReason = 'cleanup_indeterminate';
            current.lastError = appendLifecycleErrors('PTY subscription cleanup failed', cleanupErrors);
            return;
          }
          this.transitionAfterExitedCleanup(terminal, current, previous, exitCode);
        },
        (error) => {
          if (!this.isCurrentSession(terminal, session, generation)) return;
          const failure = appendLifecycleErrors(
            `PTY root exited (code=${exitCode}); cleanup failed: ${errorText(error)}`,
            subscriptionErrors,
          );
          current.state = 'attention_required';
          current.cleanupIndeterminate = true;
          current.attentionReason = 'cleanup_indeterminate';
          current.lastError = failure;
          this.rejectReadiness(current, new Error(failure));
        },
      );
  }

  private transitionAfterExitedCleanup(
    terminal: string,
    current: RuntimeSession,
    previous: RuntimeSession['state'],
    exitCode: number,
  ): void {
    if (previous === 'starting') {
      this.scheduleRestart(
        terminal,
        `attached terminal exited during startup (code=${exitCode}): ${terminal}`,
      );
    } else if (previous === 'busy') {
      current.state = 'attention_required';
      current.attentionReason = 'task_crash';
      current.lastError = `PTY exited before completion (code=${exitCode})`;
    } else if (previous === 'draining') {
      current.completedBeforeExit = true;
      this.scheduleRestart(terminal, `PTY exited after completion (code=${exitCode})`);
    } else if (previous === 'stopping') {
      this.rejectReadiness(
        current,
        new Error(`attached terminal stopped during startup: ${terminal}`),
      );
      current.state = current.messageId ? 'attention_required' : 'stopped';
    } else if (previous === 'ready' && !current.messageId) {
      this.scheduleRestart(terminal, `PTY exited unexpectedly (code=${exitCode})`);
    } else {
      current.state = current.messageId ? 'attention_required' : 'failed';
      current.lastError = `PTY exited unexpectedly (code=${exitCode})`;
    }
  }

  private scheduleRestart(terminal: string, reason: string): void {
    const current = this.requireRuntime(terminal);
    this.clearStartupTimer(current);
    clearStabilityTimer(current);
    if (this.shuttingDown) {
      current.state = current.messageId ? 'attention_required' : 'stopped';
      this.rejectReadiness(current, new Error(`restart cancelled during shutdown: ${reason}`));
      return;
    }
    if (current.messageId && !current.completedBeforeExit) {
      current.state = 'attention_required';
      current.lastError = reason;
      this.rejectReadiness(current, new Error(reason));
      return;
    }
    if (current.restartAttempts >= this.restartPolicy.maxAttempts) {
      const failure = `attached restart budget exhausted after ${current.restartAttempts} attempt(s): ${reason}`;
      current.state = 'failed';
      current.lastError = failure;
      current.restartBudgetExhausted = true;
      this.rejectReadiness(current, new Error(failure));
      return;
    }

    this.ensureReadiness(current);
    const attempt = current.restartAttempts + 1;
    current.restartAttempts = attempt;
    let delay: number;
    try {
      delay = this.restartDelay(attempt);
    } catch (error) {
      const failure = `attached restart policy failed: ${errorText(error)}`;
      current.state = 'failed';
      current.lastError = failure;
      current.restartBudgetExhausted = true;
      this.rejectReadiness(current, new Error(failure));
      return;
    }
    current.state = 'failed';
    current.lastError = `${reason}; restart ${attempt}/${this.restartPolicy.maxAttempts} in ${delay}ms`;
    current.restartTimer = setTimeout(() => {
      current.restartTimer = undefined;
      if (this.shuttingDown) {
        this.rejectReadiness(current, new Error('attached restart cancelled during shutdown'));
        return;
      }
      this.spawnAttempt(terminal, true);
    }, delay);
    current.restartTimer.unref();
  }

  private restartDelay(attempt: number): number {
    return calculateRestartDelay(this.restartPolicy, attempt, this.random());
  }

  private finishStop(terminal: string, session: PtySession, generation: number): Error[] {
    if (!this.isCurrentSession(terminal, session, generation)) return [];
    const current = this.requireRuntime(terminal);
    this.clearStartupTimer(current);
    clearStabilityTimer(current);
    this.rejectReadiness(
      current,
      new Error(`attached terminal stopped during startup: ${terminal}`),
    );
    const errors = disposeAttachedSession(current);
    if (errors.length > 0) {
      current.state = 'attention_required';
      current.cleanupIndeterminate = true;
      current.attentionReason = 'cleanup_indeterminate';
      current.lastError = appendLifecycleErrors('PTY subscription cleanup failed', errors);
      return errors;
    }
    current.state = current.messageId ? 'attention_required' : 'stopped';
    return errors;
  }

  private cleanupFailedStart(
    terminal: string,
    session: PtySession,
    generation: number,
    failure: string,
    automatic: boolean,
  ): void {
    const current = this.requireRuntime(terminal);
    current.state = 'stopping';
    current.sessionUsable = false;
    current.lastError = failure;
    void Promise.resolve()
      .then(() => session.kill())
      .then(
        () => {
          if (!this.isCurrentSession(terminal, session, generation)) return;
          const cleanupErrors = disposeAttachedSession(current);
          if (cleanupErrors.length > 0) {
            const cleanupFailure = appendLifecycleErrors(failure, cleanupErrors);
            current.state = 'attention_required';
            current.cleanupIndeterminate = true;
            current.attentionReason = 'cleanup_indeterminate';
            current.lastError = cleanupFailure;
            this.rejectReadiness(current, new Error(cleanupFailure));
            return;
          }
          current.state = 'failed';
          current.lastError = failure;
          if (automatic) this.scheduleRestart(terminal, failure);
          else this.rejectReadiness(current, new Error(failure));
        },
        (error) => {
          if (!this.isCurrentSession(terminal, session, generation)) return;
          const cleanupFailure = `${failure}; PTY cleanup failed: ${errorText(error)}`;
          current.state = 'attention_required';
          current.cleanupIndeterminate = true;
          current.attentionReason = 'cleanup_indeterminate';
          current.lastError = cleanupFailure;
          this.rejectReadiness(current, new Error(cleanupFailure));
        },
      );
  }

}
