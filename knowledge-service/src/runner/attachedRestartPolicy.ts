import type { AttachedSessionState, RuntimeSession } from './attachedSessionTypes';
import { rejectAttachedReadiness } from './attachedSessionRuntime';
import { ValidationError, RuntimeStateError } from '../core/errors';

const MAX_RESTART_ATTEMPTS = 100;
const MAX_RESTART_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface AttachedRestartPolicy {
  /** Number of automatic attempts after the original PTY exits. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Continuous READY uptime required before the attempt budget resets. */
  stabilityResetMs: number;
  /** Symmetric jitter around the exponential delay, from 0 to 1. */
  jitterRatio: number;
}

const DEFAULT_RESTART_POLICY: AttachedRestartPolicy = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 5_000,
  stabilityResetMs: 30_000,
  jitterRatio: 0.2,
};

export function normalizeRestartPolicy(
  value: Partial<AttachedRestartPolicy> | undefined,
): AttachedRestartPolicy {
  const policy = { ...DEFAULT_RESTART_POLICY, ...value };
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 0 ||
    policy.maxAttempts > MAX_RESTART_ATTEMPTS
  ) {
    throw new ValidationError(`attached restart maxAttempts must be between 0 and ${MAX_RESTART_ATTEMPTS}`, { maxAttempts: 'out of range' });
  }
  if (
    !Number.isInteger(policy.initialDelayMs) ||
    policy.initialDelayMs < 0 ||
    policy.initialDelayMs > MAX_RESTART_INTERVAL_MS
  ) {
    throw new ValidationError('attached restart initialDelayMs is out of range', { initialDelayMs: 'out of range' });
  }
  if (
    !Number.isInteger(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.initialDelayMs ||
    policy.maxDelayMs > MAX_RESTART_INTERVAL_MS
  ) {
    throw new ValidationError('attached restart maxDelayMs must be at least initialDelayMs', { maxDelayMs: 'must be >= initialDelayMs' });
  }
  if (
    !Number.isInteger(policy.stabilityResetMs) ||
    policy.stabilityResetMs < 1 ||
    policy.stabilityResetMs > MAX_RESTART_INTERVAL_MS
  ) {
    throw new ValidationError('attached restart stabilityResetMs is out of range', { stabilityResetMs: 'out of range' });
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new ValidationError('attached restart jitterRatio must be between 0 and 1', { jitterRatio: 'must be in [0, 1]' });
  }
  return policy;
}

export function calculateRestartDelay(
  policy: AttachedRestartPolicy,
  attempt: number,
  entropy: number,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > policy.maxAttempts) {
    throw new ValidationError('attached restart attempt is out of range', { attempt: 'must be in [1, maxAttempts]' });
  }
  if (!Number.isFinite(entropy) || entropy < 0 || entropy > 1) {
    throw new ValidationError('attached restart entropy must be finite and between 0 and 1', { entropy: 'must be in [0, 1]' });
  }
  const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1));
  const jitter = (entropy * 2 - 1) * policy.jitterRatio;
  return Math.max(0, Math.round(exponential * (1 + jitter)));
}

/**
 * Decide what happens to a terminal whose PTY root exited and whose cleanup
 * completed without errors. Only taskless or already-completed exits may
 * restart; a task that died before its completion receipt always parks.
 */
export function transitionAfterAttachedExit(
  terminal: string,
  current: RuntimeSession,
  previous: AttachedSessionState,
  exitCode: number,
  scheduleRestart: (reason: string) => void,
): void {
  if (previous === 'starting') {
    scheduleRestart(`attached terminal exited during startup (code=${exitCode}): ${terminal}`);
  } else if (previous === 'busy') {
    current.state = 'attention_required';
    current.attentionReason = 'task_crash';
    current.lastError = `PTY exited before completion (code=${exitCode})`;
  } else if (previous === 'draining') {
    current.completedBeforeExit = true;
    scheduleRestart(`PTY exited after completion (code=${exitCode})`);
  } else if (previous === 'stopping') {
    rejectAttachedReadiness(
      current,
      new RuntimeStateError(`attached terminal stopped during startup: ${terminal}`, terminal),
    );
    current.state = current.messageId ? 'attention_required' : 'stopped';
  } else if (previous === 'ready' && !current.messageId) {
    scheduleRestart(`PTY exited unexpectedly (code=${exitCode})`);
  } else {
    current.state = current.messageId ? 'attention_required' : 'failed';
    current.lastError = `PTY exited unexpectedly (code=${exitCode})`;
  }
}

export function scheduleStabilityReset(
  current: RuntimeSession,
  policy: AttachedRestartPolicy,
): void {
  clearStabilityTimer(current);
  if (!current.session || current.state !== 'ready' || current.restartAttempts === 0) return;
  const session = current.session;
  const generation = current.generation;
  current.stabilityTimer = setTimeout(() => {
    current.stabilityTimer = undefined;
    if (current.session !== session || current.generation !== generation || current.state !== 'ready') {
      return;
    }
    current.restartAttempts = 0;
    current.restartBudgetExhausted = false;
  }, policy.stabilityResetMs);
  current.stabilityTimer.unref();
}

export function clearStabilityTimer(current: RuntimeSession): void {
  if (current.stabilityTimer) clearTimeout(current.stabilityTimer);
  current.stabilityTimer = undefined;
}
