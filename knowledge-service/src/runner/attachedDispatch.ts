import type { AttachedTaskMarkerStore } from './attachedTaskMarkerStore';
import { clearStabilityTimer } from './attachedRestartPolicy';
import type { AttachedTerminalPolicy, RuntimeSession } from './attachedSessionTypes';
import type { LaunchRequest, LaunchResult } from './sessionLauncher';

export function dispatchAttachedTask(
  current: RuntimeSession | undefined,
  policy: AttachedTerminalPolicy | undefined,
  markers: AttachedTaskMarkerStore,
  request: LaunchRequest,
): LaunchResult {
  if (!current || !policy) {
    return { started: false, reason: `attached terminal not configured: ${request.terminal}` };
  }
  if (current.state !== 'ready' || !current.session) {
    return { started: false, reason: `attached terminal not ready: ${request.terminal}` };
  }
  let input: string;
  try {
    input = policy.encodeDispatch(request);
  } catch (error) {
    return { started: false, reason: `attached input encoding failed: ${errorText(error)}` };
  }
  const now = new Date().toISOString();
  const marker = {
    version: 1 as const,
    terminal: request.terminal,
    messageId: request.messageId,
    generation: current.generation,
    pid: current.session.pid,
    phase: 'accepted' as const,
    startedAt: now,
    updatedAt: now,
  };
  try {
    markers.save(marker);
  } catch (error) {
    current.state = 'attention_required';
    current.attentionReason = 'marker_persist_failed';
    current.lastError = `attached marker persist failed: ${errorText(error)}`;
    return { started: false, reason: current.lastError };
  }
  clearStabilityTimer(current);
  current.messageId = request.messageId;
  current.markerGeneration = current.generation;
  current.receiptSequence = undefined;
  current.completedBeforeExit = false;
  current.controllerInputPending = true;
  current.state = 'busy';
  current.lastError = undefined;
  current.attentionReason = undefined;
  try {
    current.session.write(input);
  } catch (error) {
    current.state = 'attention_required';
    current.attentionReason = 'input_outcome_unknown';
    current.lastError = `PTY write outcome unknown: ${errorText(error)}`;
    return { started: true, reason: current.lastError };
  }
  current.controllerInputPending = false;
  try {
    markers.save({ ...marker, phase: 'written', updatedAt: new Date().toISOString() });
  } catch (error) {
    current.state = 'attention_required';
    current.attentionReason = 'marker_persist_failed';
    current.lastError = `attached written marker persist failed: ${errorText(error)}`;
    return { started: true, reason: current.lastError };
  }
  return { started: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
