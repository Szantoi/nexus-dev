import { randomUUID } from 'node:crypto';
import type { AttachedTaskMarkerStore } from './attachedTaskMarkerStore';
import {
  acknowledgeLiveCompletion,
  clearCompletedMarkerForRestart,
  reconcileCompletionReceipt,
} from './attachedCompletionReceipt';
import {
  appendLifecycleErrors,
  clearAttachedTask,
  disposeAttachedSession,
  disposeAttachedSubscriptions,
  drainCleanupErrors,
  markCleanupIndeterminate,
  normalizeCleanupMarginMs,
  recordCleanupError,
  summarizeLifecycleErrors,
  sweepCleanupLedgers,
} from './attachedSessionCleanup';
import { dispatchAttachedTask } from './attachedDispatch';
import {
  auditAttachedDeadlines,
  type AttachedDeadlineEvent,
  type AttachedDeadlineLimits,
} from './attachedDeadlines';
import {
  calculateRestartDelay,
  clearStabilityTimer,
  normalizeRestartPolicy,
  scheduleStabilityReset,
  transitionAfterAttachedExit,
  type AttachedRestartPolicy,
} from './attachedRestartPolicy';
import {
  assertAttachedPreflightState,
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
import { acknowledgeAttachedStableIdle } from './attachedStableIdle';
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

const TERMINAL_COLOR_QUERIES = [
  { query: '\u001b]10;?', response: '\u001b]10;rgb:ffff/ffff/ffff\u001b\\' },
  { query: '\u001b]11;?', response: '\u001b]11;rgb:0000/0000/0000\u001b\\' },
] as const;
const TERMINAL_QUERY_TAIL_LENGTH = 4_096;
const CODEX_UPDATE_PROMPT = 'Update available!';
const CODEX_UPDATE_CONTINUE_PROMPT = 'Press enter to continue';
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
  private readonly isCurrentSession = createAttachedSessionMatcher(this.runtime);
  private readonly requireRuntime = (terminal: string) => requireAttachedRuntime(this.runtime, terminal);
  /** Per-PTY tail for split terminal control queries. */
  private readonly terminalQueryTails = new WeakMap<PtySession, string>();
  /** The update notice is dismissed at most once for each PTY generation. */
  private readonly dismissedUpdatePrompts = new WeakSet<PtySession>();
  /** Kill failures already pushed to a cleanup ledger; prevents double-report. */
  private readonly killFailureRecorded = new WeakSet<PtySession>();
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
    assertAttachedPreflightState(this.runtime, this.policies.keys());
    try {
      for (const terminal of this.policies.keys()) {
        const current = this.requireRuntime(terminal);
        // attention_required here is the reconcilable stale-marker park the
        // preflight admitted: no session is started for it — reconciliation
        // via a durable receipt schedules its restart later.
        if (
          current.state === 'ready' ||
          current.state === 'busy' ||
          current.state === 'draining' ||
          current.state === 'attention_required'
        ) {
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
        // Fire-and-forget: startup already fails with the original error, and
        // a failed kill keeps its session tracked (activeCount > 0), so only
        // rollback log detail can be lost here — never a silent exit 0.
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
      this.now(),
    );
  }

  auditDeadlines(limits: AttachedDeadlineLimits): AttachedDeadlineEvent[] {
    return auditAttachedDeadlines(this.runtime, limits, this.now());
  }

  isBusy(terminal: string): boolean {
    return !['stopped', 'ready'].includes(this.runtime.get(terminal)?.state ?? '');
  }

  cancel(terminal: string, reason = 'cancelled'): boolean {
    const current = this.runtime.get(terminal);
    if (!current) return false;
    if (current.state === 'stopping') {
      // A session-less stopping terminal with a pending native spawn is the
      // post-startup-timeout window: without a generation bump the late spawn
      // would continue its bounded restart against this explicit cancel.
      if (current.session || current.spawnPromise === undefined) return false;
      current.generation++;
      current.lastError = reason;
      return true;
    }
    clearStabilityTimer(current);
    let cancelled = clearAttachedRestartTimer(current);
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
        rejectAttachedReadiness(current, new Error(reason));
      } else if (cancelled) {
        rejectAttachedReadiness(current, new Error(reason));
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
        // Recorded before the currency guard: shutdown must still see it.
        this.recordKillFailure(current, session, `PTY cleanup failed: ${errorText(error)}`);
        if (!this.isCurrentSession(terminal, session, generation)) return;
        markCleanupIndeterminate(current, `PTY cleanup failed: ${errorText(error)}`);
      },
    );
    return cancelled;
  }

  cancelAll(reason = 'runner-shutdown'): number {
    return [...this.runtime.keys()].filter((terminal) => this.cancel(terminal, reason)).length;
  }

  activeCount(): number {
    return countActiveAttachedSessions(this.runtime);
  }

  minimumShutdownGraceMs(): number {
    return this.ptyHost.spawnDeadlineMs + this.ptyHost.cleanupDeadlineMs + this.cleanupMarginMs;
  }

  async shutdown(reason = 'runner-shutdown'): Promise<void> {
    this.shuttingDown = true;
    const stops: Promise<void>[] = [];
    const shutdownError = new Error(`attached session manager stopped: ${reason}`);
    for (const [terminal, current] of this.runtime) {
      clearAttachedRestartTimer(current);
      clearAttachedStartupTimer(current);
      clearStabilityTimer(current);
      rejectAttachedReadiness(current, shutdownError);
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
            // finishStop's dispose failures land in the shared cleanup ledger;
            // the sweep below propagates them exactly once.
            this.finishStop(terminal, session, generation);
          },
          (error) => {
            this.recordKillFailure(current, session, `PTY cleanup failed: ${errorText(error)}`);
            if (this.isCurrentSession(terminal, session, generation)) {
              markCleanupIndeterminate(current, `PTY cleanup failed: ${errorText(error)}`);
            }
          },
        ),
      );
    }
    const results = await Promise.allSettled(stops);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => asError(result.reason));
    try {
      // Deadline-orphaned spawns may still be unwinding live process trees.
      await this.ptyHost.drainPendingSpawnUnwinds?.();
    } catch (error) {
      failures.push(asError(error));
    }
    // Ledger sweep: every cleanup error recorded by any racing continuation
    // (root exit, cancel, late spawn) is propagated here exactly once.
    failures.push(...sweepCleanupLedgers(this.runtime));
    if (failures.length > 0) {
      throw new AttachedLifecycleError(
        `attached PTY shutdown failed for ${failures.length} session(s): ${summarizeLifecycleErrors(failures)}`,
        failures,
      );
    }
  }

  /** Record a kill failure exactly once per PTY session, whichever racing continuation sees it first. */
  private recordKillFailure(current: RuntimeSession, session: PtySession, message: string): void {
    if (this.killFailureRecorded.has(session)) return;
    this.killFailureRecorded.add(session);
    recordCleanupError(current, new Error(message));
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
    return acknowledgeAttachedStableIdle(
      this.markers,
      this.runtime.get(proof.terminal),
      this.policies.get(proof.terminal),
      proof,
      this.now(),
      (current) => {
        clearAttachedTask(current);
        current.state = 'ready';
        scheduleStabilityReset(current, this.restartPolicy);
      },
    );
  }

  /** Promote an exact server receipt durably; readiness performs the later CAS-clear. */
  reconcileMarker(receipt: RunnerCompletionReceipt): boolean {
    const terminal = receipt.terminalId;
    const result = reconcileCompletionReceipt(
      this.markers,
      this.runtime.get(terminal),
      this.policies.get(terminal),
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
    return current && createAttachedSessionSnapshot(terminal, current);
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
    const readiness = ensureAttachedReadiness(current);
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
      rejectAttachedReadiness(current, new Error('attached session manager is shutting down'));
      return;
    }
    if (current.session) {
      const failure = `refusing to spawn while a PTY is still tracked: ${terminal}`;
      current.sessionUsable = false;
      markCleanupIndeterminate(current, failure);
      rejectAttachedReadiness(current, new Error(failure));
      return;
    }
    clearStabilityTimer(current);
    const policy = this.policies.get(terminal)!;
    // A new generation opens a fresh cleanup transaction. Prior-generation
    // errors were already delivered (restart reason / readiness rejection /
    // reconciliation), so a recovered terminal must not fail a later clean
    // shutdown with stale entries.
    drainCleanupErrors(current);
    // Reset provider screen state: a dead session's alternate-screen flag
    // must never poison the replacement session's readiness classification.
    policy.onSessionStart?.();
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
        if (!session) return rejectAttachedReadiness(current, new Error(failure));
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
      clearAttachedStartupTimer(current);
      if (current.generation !== generation || current.state !== 'starting') {
        current.state = current.messageId ? 'attention_required' : 'stopped';
        return;
      }
      const failure = `PTY spawn failed: ${errorText(error)}`;
      current.state = 'failed';
      current.lastError = failure;
      if (automatic) this.scheduleRestart(terminal, failure);
      else rejectAttachedReadiness(current, new Error(failure));
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
        // Recorded (not thrown): the shutdown sweep drains the ledger, so the
        // spawn promise can settle cleanly for Promise.allSettled callers.
        this.recordKillFailure(current, session, failure);
        markCleanupIndeterminate(current, failure);
        rejectAttachedReadiness(current, new Error(failure));
        return;
      }
      // Generation mismatch is the intentional cancellation signal here. Only
      // identity is needed to ensure we do not dispose a newer owned session.
      if (current.session === session) disposeAttachedSession(current);
      // Startup timeout is the only invalidation that keeps the generation and
      // is not a shutdown: cancel bumps the generation, shutdown sets the flag.
      // A successful late cleanup of an automatic attempt continues the
      // bounded restart chain; explicit cancel/shutdown never does.
      if (!this.shuttingDown && current.generation === generation && automatic) {
        this.scheduleRestart(terminal, `PTY spawn settled after startup timeout: ${terminal}`);
        return;
      }
      current.state = current.messageId ? 'attention_required' : 'stopped';
      rejectAttachedReadiness(current, new Error('PTY spawn completed after shutdown or invalidation'));
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

  /**
   * node-pty owns the process side of a terminal but does not emulate terminal
   * replies. Codex asks for OSC 10/11 colors before rendering its first prompt;
   * provide fixed high-contrast values so an unattended, read-only session can
   * progress exactly as it does in an interactive terminal.
   */
  private answerTerminalColorQueries(session: PtySession, data: string): void {
    let pending = `${this.terminalQueryTails.get(session) ?? ''}${data}`;
    for (const { query, response } of TERMINAL_COLOR_QUERIES) {
      while (pending.includes(query)) {
        session.write(response);
        pending = pending.replace(query, '');
      }
    }
    if (
      !this.dismissedUpdatePrompts.has(session)
      && pending.includes(CODEX_UPDATE_PROMPT)
      && pending.includes(CODEX_UPDATE_CONTINUE_PROMPT)
    ) {
      // Select Codex's documented "Skip until next version" option. A runner
      // never upgrades a CLI on its own; this merely clears the interactive
      // startup modal so the existing, pinned binary can reach its prompt.
      session.write('3\r');
      this.dismissedUpdatePrompts.add(session);
    }
    this.terminalQueryTails.set(session, pending.slice(-TERMINAL_QUERY_TAIL_LENGTH));
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
    try {
      this.answerTerminalColorQueries(session, data);
    } catch (error) {
      if (current.state === 'starting') {
        clearAttachedStartupTimer(current);
        const failure = appendLifecycleErrors(
          `terminal query responder failed: ${errorText(error)}`,
          disposeAttachedSubscriptions(current),
        );
        this.cleanupFailedStart(terminal, session, generation, failure, current.automaticAttempt);
      } else {
        current.state = 'attention_required';
        current.attentionReason = 'terminal_query_responder_failed';
        current.lastError = `terminal query responder failed: ${errorText(error)}`;
      }
      return;
    }
    // Every chunk reaches the provider's screen tracker in EVERY state, so a
    // TUI entered while busy can never poison a later idle classification.
    try {
      policy.observeSample?.(data);
    } catch (error) {
      if (current.state === 'starting') {
        clearAttachedStartupTimer(current);
        const failure = appendLifecycleErrors(
          `screen observer failed: ${errorText(error)}`,
          disposeAttachedSubscriptions(current),
        );
        this.cleanupFailedStart(terminal, session, generation, failure, current.automaticAttempt);
      } else {
        current.state = 'attention_required';
        current.attentionReason = 'idle_classifier_failed';
        current.lastError = `screen observer failed: ${errorText(error)}`;
      }
      return;
    }
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
      clearAttachedStartupTimer(current);
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
      const failure = clearCompletedMarkerForRestart(this.markers, terminal, current);
      if (failure) {
        current.state = 'attention_required';
        current.attentionReason = 'marker_cleanup_failed';
        current.lastError = failure;
        current.readyPending = false;
        clearAttachedStartupTimer(current);
        rejectAttachedReadiness(current, new Error(failure));
        return;
      }
    }
    if (current.completedBeforeExit) clearAttachedTask(current);
    current.state = 'ready';
    current.lastError = undefined;
    current.readyPending = false;
    clearAttachedStartupTimer(current);
    scheduleStabilityReset(current, this.restartPolicy);
    resolveAttachedReadiness(current);
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
    clearAttachedStartupTimer(current);
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
            markCleanupIndeterminate(
              current,
              appendLifecycleErrors('PTY subscription cleanup failed', cleanupErrors),
            );
            return;
          }
          transitionAfterAttachedExit(terminal, current, previous, exitCode, (reason) =>
            this.scheduleRestart(terminal, reason),
          );
        },
        (error) => {
          // Recorded before the currency guard: shutdown must still see it.
          this.recordKillFailure(
            current,
            session,
            `PTY root exited (code=${exitCode}); cleanup failed: ${errorText(error)}`,
          );
          if (!this.isCurrentSession(terminal, session, generation)) return;
          const failure = appendLifecycleErrors(
            `PTY root exited (code=${exitCode}); cleanup failed: ${errorText(error)}`,
            subscriptionErrors,
          );
          markCleanupIndeterminate(current, failure);
          rejectAttachedReadiness(current, new Error(failure));
        },
      );
  }


  private scheduleRestart(terminal: string, reason: string): void {
    const current = this.requireRuntime(terminal);
    clearAttachedStartupTimer(current);
    clearStabilityTimer(current);
    if (this.shuttingDown) {
      current.state = current.messageId ? 'attention_required' : 'stopped';
      rejectAttachedReadiness(current, new Error(`restart cancelled during shutdown: ${reason}`));
      return;
    }
    if (current.messageId && !current.completedBeforeExit) {
      current.state = 'attention_required';
      current.lastError = reason;
      rejectAttachedReadiness(current, new Error(reason));
      return;
    }
    if (current.restartAttempts >= this.restartPolicy.maxAttempts) {
      const failure = `attached restart budget exhausted after ${current.restartAttempts} attempt(s): ${reason}`;
      current.state = 'failed';
      current.lastError = failure;
      current.restartBudgetExhausted = true;
      rejectAttachedReadiness(current, new Error(failure));
      return;
    }

    ensureAttachedReadiness(current);
    const attempt = current.restartAttempts + 1;
    current.restartAttempts = attempt;
    let delay: number;
    try {
      delay = calculateRestartDelay(this.restartPolicy, attempt, this.random());
    } catch (error) {
      const failure = `attached restart policy failed: ${errorText(error)}`;
      current.state = 'failed';
      current.lastError = failure;
      current.restartBudgetExhausted = true;
      rejectAttachedReadiness(current, new Error(failure));
      return;
    }
    current.state = 'failed';
    current.lastError = `${reason}; restart ${attempt}/${this.restartPolicy.maxAttempts} in ${delay}ms`;
    current.restartTimer = setTimeout(() => {
      current.restartTimer = undefined;
      if (this.shuttingDown) {
        rejectAttachedReadiness(current, new Error('attached restart cancelled during shutdown'));
        return;
      }
      this.spawnAttempt(terminal, true);
    }, delay);
    current.restartTimer.unref();
  }

  private finishStop(terminal: string, session: PtySession, generation: number): Error[] {
    if (!this.isCurrentSession(terminal, session, generation)) return [];
    const current = this.requireRuntime(terminal);
    clearAttachedStartupTimer(current);
    clearStabilityTimer(current);
    rejectAttachedReadiness(
      current,
      new Error(`attached terminal stopped during startup: ${terminal}`),
    );
    const errors = disposeAttachedSession(current);
    if (errors.length > 0) {
      markCleanupIndeterminate(
        current,
        appendLifecycleErrors('PTY subscription cleanup failed', errors),
      );
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
            markCleanupIndeterminate(current, cleanupFailure);
            rejectAttachedReadiness(current, new Error(cleanupFailure));
            return;
          }
          current.state = 'failed';
          current.lastError = failure;
          if (automatic) this.scheduleRestart(terminal, failure);
          else rejectAttachedReadiness(current, new Error(failure));
        },
        (error) => {
          this.recordKillFailure(
            current,
            session,
            `${failure}; PTY cleanup failed: ${errorText(error)}`,
          );
          if (!this.isCurrentSession(terminal, session, generation)) return;
          const cleanupFailure = `${failure}; PTY cleanup failed: ${errorText(error)}`;
          markCleanupIndeterminate(current, cleanupFailure);
          rejectAttachedReadiness(current, new Error(cleanupFailure));
        },
      );
  }

}
