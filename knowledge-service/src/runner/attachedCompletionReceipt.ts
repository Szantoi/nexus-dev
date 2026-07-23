import type {
  AttachedTaskMarker,
  AttachedTaskMarkerStore,
} from './attachedTaskMarkerStore';
import type { RunnerCompletionReceipt } from './serverClient';
import { armCompletionGate } from './attachedStableIdle';
import type { AttachedTerminalPolicy, RuntimeSession } from './attachedSessionTypes';

export interface CompletionReceiptContext {
  terminal: string;
  messageId: string;
  expectedIslandId: string;
  markerGeneration: number;
}

export type CompletionMarkerResult =
  | { ok: true; marker: AttachedTaskMarker }
  | { ok: false; error: string };

export function acknowledgeLiveCompletion(
  store: AttachedTaskMarkerStore,
  current: RuntimeSession | undefined,
  policy: AttachedTerminalPolicy | undefined,
  receipt: RunnerCompletionReceipt,
  createGateToken: () => string,
  now: number,
): boolean {
  if (
    !current?.messageId ||
    !policy ||
    current.markerGeneration === undefined ||
    !['busy', 'draining'].includes(current.state)
  ) return false;
  const context = {
    terminal: receipt.terminalId,
    messageId: current.messageId,
    expectedIslandId: policy.expectedIslandId,
    markerGeneration: current.markerGeneration,
  };
  if (validateCompletionReceipt(receipt, context)) return false;
  const result = persistCompletionReceipt(store, receipt, context);
  if (!result.ok) {
    current.state = 'attention_required';
    current.attentionReason = 'completion_persist_failed';
    current.lastError = result.error;
    return false;
  }
  current.completedBeforeExit = true;
  current.receiptSequence = receipt.sequence;
  current.controllerInputPending = false;
  armCompletionGate(current, receipt, createGateToken(), now);
  current.state = 'draining';
  return true;
}

export function reconcileCompletionReceipt(
  store: AttachedTaskMarkerStore,
  current: RuntimeSession | undefined,
  policy: AttachedTerminalPolicy | undefined,
  receipt: RunnerCompletionReceipt,
  createGateToken: () => string,
  now: number,
): 'rejected' | 'live' | 'restart' {
  if (
    current?.state !== 'attention_required' ||
    !current.messageId ||
    !policy ||
    current.markerGeneration === undefined
  ) return 'rejected';
  const reconcilableAttention = [
    'input_outcome_unknown',
    'marker_persist_failed',
    'completion_persist_failed',
    'marker_cleanup_failed',
  ].includes(current.attentionReason ?? '');
  if (
    current.session &&
    (!current.sessionUsable || current.cleanupIndeterminate || !reconcilableAttention)
  ) return 'rejected';
  const context = {
    terminal: receipt.terminalId,
    messageId: current.messageId,
    expectedIslandId: policy.expectedIslandId,
    markerGeneration: current.markerGeneration,
  };
  if (validateCompletionReceipt(receipt, context)) return 'rejected';
  const result = persistCompletionReceipt(store, receipt, context);
  if (!result.ok) {
    current.attentionReason = 'completion_persist_failed';
    current.lastError = result.error;
    return 'rejected';
  }
  current.completedBeforeExit = true;
  current.receiptSequence = receipt.sequence;
  current.controllerInputPending = false;
  if (!current.session) return 'restart';
  if (current.generation !== result.marker.generation) {
    current.lastError = 'completion receipt matches marker but not the live PTY generation';
    return 'rejected';
  }
  armCompletionGate(current, receipt, createGateToken(), now);
  current.state = 'draining';
  current.lastError = undefined;
  current.attentionReason = undefined;
  return 'live';
}

/**
 * Clear a completed task's durable marker once the replacement terminal has
 * proved ready. Returns the failure text when the exact marker cannot be
 * verified and cleared; the caller parks the terminal in attention_required.
 */
export function clearCompletedMarkerForRestart(
  store: AttachedTaskMarkerStore,
  terminal: string,
  current: RuntimeSession,
): string | undefined {
  if (!current.messageId || current.markerGeneration === undefined) {
    return `completed marker missing after PTY restart: ${terminal}`;
  }
  let cleared = false;
  let failure: string | undefined;
  try {
    const marker = store.load(terminal);
    if (
      marker?.phase === 'completed' &&
      marker.messageId === current.messageId &&
      marker.generation === current.markerGeneration &&
      marker.receiptSequence === current.receiptSequence
    ) {
      cleared = store.clear(terminal, current.messageId, current.markerGeneration);
    }
  } catch (error) {
    failure = `completed marker cleanup failed: ${errorText(error)}`;
  }
  if (cleared) return undefined;
  return failure ?? `completed marker missing after PTY restart: ${terminal}`;
}

export function validateCompletionReceipt(
  receipt: RunnerCompletionReceipt,
  context: Omit<CompletionReceiptContext, 'markerGeneration'>,
): string | undefined {
  if (receipt.source !== 'mcp_complete_task') return 'invalid completion receipt source';
  if (receipt.islandId !== context.expectedIslandId) return 'completion receipt island mismatch';
  if (receipt.terminalId !== context.terminal) return 'completion receipt terminal mismatch';
  if (receipt.messageId !== context.messageId) return 'completion receipt message mismatch';
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
    return 'invalid completion receipt sequence';
  }
  if (!Number.isFinite(Date.parse(receipt.completedAt))) {
    return 'invalid completion receipt timestamp';
  }
  return undefined;
}

export function persistCompletionReceipt(
  store: AttachedTaskMarkerStore,
  receipt: RunnerCompletionReceipt,
  context: CompletionReceiptContext,
): CompletionMarkerResult {
  const validationError = validateCompletionReceipt(receipt, context);
  if (validationError) return { ok: false, error: validationError };
  let marker: AttachedTaskMarker | undefined;
  try {
    marker = store.load(context.terminal);
  } catch (error) {
    return { ok: false, error: `completion marker load failed: ${errorText(error)}` };
  }
  if (
    !marker ||
    marker.terminal !== context.terminal ||
    marker.messageId !== context.messageId ||
    marker.generation !== context.markerGeneration
  ) {
    return { ok: false, error: 'attached task marker missing during completion transition' };
  }
  if (marker.phase === 'completed') {
    return marker.receiptSequence === receipt.sequence
      ? { ok: true, marker }
      : { ok: false, error: 'conflicting completion receipt sequence' };
  }
  const completed: AttachedTaskMarker = {
    ...marker,
    phase: 'completed',
    receiptSequence: receipt.sequence,
    updatedAt: new Date().toISOString(),
  };
  try {
    store.save(completed);
  } catch (error) {
    return { ok: false, error: `completion marker persist failed: ${errorText(error)}` };
  }
  return { ok: true, marker: completed };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
