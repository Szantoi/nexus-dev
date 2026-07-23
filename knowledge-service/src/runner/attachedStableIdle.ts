import type { AttachedTaskMarkerStore } from './attachedTaskMarkerStore';
import type {
  AttachedStableIdleProof,
  AttachedTerminalPolicy,
  CompletionIdleGate,
  RuntimeSession,
} from './attachedSessionTypes';
import type { RunnerCompletionReceipt } from './serverClient';

export interface StableIdleRuntimeFacts {
  terminal: string;
  messageId?: string;
  sessionGeneration: number;
  receiptSequence?: number;
  outputEpoch: number;
  gate?: CompletionIdleGate;
  controllerInputPending: boolean;
  sessionUsable: boolean;
  cleanupIndeterminate: boolean;
  now: number;
  lastOutputAt: number;
  idleSettleMs: number;
}

const MAX_FUTURE_SETTLED_AT_SKEW_MS = 1_000;

export type StableIdleResult =
  | { status: 'rejected' | 'pending' | 'released' }
  | { status: 'error'; error: string };

export function evaluateStableIdleProof(
  store: AttachedTaskMarkerStore,
  current: RuntimeSession | undefined,
  policy: AttachedTerminalPolicy | undefined,
  proof: AttachedStableIdleProof,
  now: number,
): StableIdleResult {
  if (
    current?.state !== 'draining' ||
    !current.session ||
    !policy ||
    current.markerGeneration === undefined
  ) return { status: 'rejected' };
  const validationError = validateStableIdleProof(proof, {
    terminal: proof.terminal,
    messageId: current.messageId,
    sessionGeneration: current.generation,
    receiptSequence: current.receiptSequence,
    outputEpoch: current.outputEpoch,
    gate: current.completionIdleGate,
    controllerInputPending: current.controllerInputPending,
    sessionUsable: current.sessionUsable,
    cleanupIndeterminate: current.cleanupIndeterminate,
    now,
    lastOutputAt: current.lastOutputAt,
    idleSettleMs: policy.idleSettleMs,
  });
  if (validationError) return { status: 'rejected' };
  if (current.idleConfirmationCount < policy.idleConfirmSamples) return { status: 'pending' };
  const result = clearDurableCompletedMarker(store, proof, current.markerGeneration);
  return result.ok ? { status: 'released' } : { status: 'error', error: result.error };
}

/**
 * Full stable-idle acknowledgement: evaluate the proof, then either release
 * the terminal back to ready (with a fresh stability window) or park it when
 * the durable marker cleanup failed.
 */
export function acknowledgeAttachedStableIdle(
  store: AttachedTaskMarkerStore,
  current: RuntimeSession | undefined,
  policy: AttachedTerminalPolicy | undefined,
  proof: AttachedStableIdleProof,
  now: number,
  releaseToReady: (current: RuntimeSession) => void,
): boolean {
  const result = evaluateStableIdleProof(store, current, policy, proof, now);
  if (result.status === 'error' && current) {
    current.state = 'attention_required';
    current.attentionReason = 'marker_cleanup_failed';
    current.lastError = result.error;
    return false;
  }
  if (result.status !== 'released' || !current) return false;
  releaseToReady(current);
  return true;
}

export function armCompletionGate(
  current: RuntimeSession,
  receipt: RunnerCompletionReceipt,
  token: string,
  now: number,
): void {
  if (
    current.completionIdleGate?.receiptSequence === receipt.sequence &&
    current.completionIdleGate.sessionGeneration === current.generation
  ) return;
  current.completionIdleGate = {
    id: token,
    sessionGeneration: current.generation,
    receiptSequence: receipt.sequence,
    outputEpoch: current.outputEpoch,
    receiptCompletedAtMs: Date.parse(receipt.completedAt),
    armedAtMs: now,
  };
  current.idleConfirmationCount = 0;
  current.lastIdleSampleAt = undefined;
}

export function validateStableIdleProof(
  proof: AttachedStableIdleProof,
  facts: StableIdleRuntimeFacts,
): string | undefined {
  const settledAt = Date.parse(proof.settledAt);
  if (proof.terminal !== facts.terminal) return 'stable-idle terminal mismatch';
  if (proof.messageId !== facts.messageId) return 'stable-idle message mismatch';
  if (proof.sessionGeneration !== facts.sessionGeneration) {
    return 'stable-idle session generation mismatch';
  }
  if (proof.receiptSequence !== facts.receiptSequence) {
    return 'stable-idle receipt sequence mismatch';
  }
  if (!facts.gate || proof.completionGate !== facts.gate.id) {
    return 'stable-idle completion gate mismatch';
  }
  if (
    facts.gate.sessionGeneration !== facts.sessionGeneration ||
    facts.gate.receiptSequence !== facts.receiptSequence
  ) {
    return 'stable-idle gate is stale';
  }
  if (proof.outputEpoch !== facts.outputEpoch || proof.outputEpoch < facts.gate.outputEpoch) {
    return 'PTY output changed after completion receipt';
  }
  if (
    !Number.isFinite(settledAt) ||
    settledAt < facts.gate.receiptCompletedAtMs ||
    settledAt < facts.gate.armedAtMs ||
    settledAt < facts.lastOutputAt + facts.idleSettleMs ||
    facts.now < facts.lastOutputAt + facts.idleSettleMs ||
    settledAt > facts.now + MAX_FUTURE_SETTLED_AT_SKEW_MS
  ) {
    return 'stable-idle settledAt predates the completion gate';
  }
  if (facts.controllerInputPending) return 'controller input outcome is still pending';
  if (!facts.sessionUsable || facts.cleanupIndeterminate) {
    return 'PTY session cleanup or usability is indeterminate';
  }
  return undefined;
}

export function clearDurableCompletedMarker(
  store: AttachedTaskMarkerStore,
  proof: AttachedStableIdleProof,
  markerGeneration: number,
): { ok: true } | { ok: false; error: string } {
  try {
    const marker = store.load(proof.terminal);
    if (
      marker?.phase !== 'completed' ||
      marker.messageId !== proof.messageId ||
      marker.generation !== markerGeneration ||
      marker.receiptSequence !== proof.receiptSequence
    ) {
      return { ok: false, error: 'durable completed marker does not match idle proof' };
    }
    return store.clear(proof.terminal, proof.messageId, markerGeneration)
      ? { ok: true }
      : { ok: false, error: 'attached task marker missing during idle transition' };
  } catch (error) {
    return {
      ok: false,
      error: `attached task marker cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
