import type { RuntimeSession } from './attachedSessionTypes';

const DEFAULT_CLEANUP_MARGIN_MS = 2_000;
const MAX_CLEANUP_MARGIN_MS = 60_000;
const MAX_SUMMARY_ERRORS = 3;
const MAX_SUMMARY_CHARS_PER_ERROR = 200;

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
