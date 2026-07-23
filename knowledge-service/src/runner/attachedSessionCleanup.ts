import type { RuntimeSession } from './attachedSessionTypes';

const DEFAULT_CLEANUP_MARGIN_MS = 2_000;
const MAX_CLEANUP_MARGIN_MS = 60_000;
const MAX_SUMMARY_ERRORS = 3;
const MAX_SUMMARY_CHARS_PER_ERROR = 200;
const MAX_CLEANUP_LEDGER_ENTRIES = 20;

export function normalizeCleanupMarginMs(value = DEFAULT_CLEANUP_MARGIN_MS): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CLEANUP_MARGIN_MS) {
    throw new Error(`attached cleanupMarginMs must be between 1 and ${MAX_CLEANUP_MARGIN_MS}`);
  }
  return value;
}

export function summarizeLifecycleErrors(errors: readonly Error[]): string {
  const summaries = errors.slice(0, MAX_SUMMARY_ERRORS).map((error) => {
    const singleLine = error.message.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || error.name;
    return singleLine.length <= MAX_SUMMARY_CHARS_PER_ERROR
      ? singleLine
      : `${singleLine.slice(0, MAX_SUMMARY_CHARS_PER_ERROR - 3)}...`;
  });
  const omitted = errors.length - summaries.length;
  if (omitted > 0) summaries.push(`+${omitted} more omitted`);
  return summaries.join('; ');
}

export function clearAttachedTask(current: RuntimeSession): void {
  current.messageId = undefined;
  current.markerGeneration = undefined;
  current.receiptSequence = undefined;
  current.completedBeforeExit = false;
  current.completionIdleGate = undefined;
  current.controllerInputPending = false;
  current.attentionReason = undefined;
  current.idleConfirmationCount = 0;
  current.lastIdleSampleAt = undefined;
  current.lastError = undefined;
}

/**
 * Record a cleanup failure into the terminal's shared ledger so a concurrent
 * shutdown can still propagate it regardless of continuation ordering.
 */
export function recordCleanupError(current: RuntimeSession, error: Error): void {
  if (current.cleanupLedger.length < MAX_CLEANUP_LEDGER_ENTRIES) {
    current.cleanupLedger.push(error);
  } else {
    current.cleanupLedgerDropped++;
  }
}

/** Park a terminal whose native cleanup outcome cannot be proven. */
export function markCleanupIndeterminate(current: RuntimeSession, failure: string): void {
  current.state = 'attention_required';
  current.cleanupIndeterminate = true;
  current.attentionReason = 'cleanup_indeterminate';
  current.lastError = failure;
}

/** Drain every terminal's ledger into terminal-prefixed shutdown failures. */
export function sweepCleanupLedgers(
  runtime: ReadonlyMap<string, RuntimeSession>,
): Error[] {
  const failures: Error[] = [];
  for (const [terminal, current] of runtime) {
    for (const error of drainCleanupErrors(current)) {
      failures.push(new Error(`${terminal}: ${error.message}`));
    }
  }
  return failures;
}

/** Read-and-clear the ledger; each recorded error is reported exactly once. */
export function drainCleanupErrors(current: RuntimeSession): Error[] {
  const drained = current.cleanupLedger.splice(0);
  if (current.cleanupLedgerDropped > 0) {
    drained.push(
      new Error(`+${current.cleanupLedgerDropped} additional cleanup error(s) dropped`),
    );
    current.cleanupLedgerDropped = 0;
  }
  return drained;
}

export function disposeAttachedSubscriptions(current: RuntimeSession): Error[] {
  const subscriptions = [
    ['data', current.dataSubscription],
    ['exit', current.exitSubscription],
  ] as const;
  current.dataSubscription = undefined;
  current.exitSubscription = undefined;
  const errors: Error[] = [];
  for (const [kind, subscription] of subscriptions) {
    try {
      subscription?.dispose();
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const wrapped = new Error(`PTY ${kind} subscription dispose failed: ${cause.message}`);
      Object.assign(wrapped, { cause });
      errors.push(wrapped);
    }
  }
  // Record at collection time: a later isCurrentSession guard in an async
  // continuation must never be the only holder of a dispose failure.
  for (const error of errors) recordCleanupError(current, error);
  return errors;
}

export function disposeAttachedSession(current: RuntimeSession): Error[] {
  const errors = disposeAttachedSubscriptions(current);
  current.session = undefined;
  current.sessionUsable = false;
  current.cleanupIndeterminate = false;
  return errors;
}

export function appendLifecycleErrors(message: string, errors: readonly Error[]): string {
  return errors.length > 0 ? `${message}; ${summarizeLifecycleErrors(errors)}` : message;
}
