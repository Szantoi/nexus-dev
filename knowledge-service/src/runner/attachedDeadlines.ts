/**
 * attachedDeadlines.ts — heartbeat/stall enforcement for attached terminals.
 *
 * Two audited deadlines (plan §5 "Heartbeat és stall"):
 * - task_stall_timeout_ms: a busy task with no PTY output for this long emits
 *   ONE audited warning per task. No automatic Enter, kill or re-nudge.
 * - completion_idle_timeout_ms: a draining terminal that cannot prove stable
 *   idle within this window after its completion receipt parks in
 *   attention_required while keeping the task's durable state intact.
 */

import type { RuntimeSession } from './attachedSessionTypes';

export interface AttachedDeadlineLimits {
  completionIdleTimeoutMs: number;
  taskStallTimeoutMs: number;
}

export type AttachedDeadlineEvent =
  | { kind: 'task_stall_warning'; terminal: string; messageId: string; stalledForMs: number }
  | { kind: 'completion_idle_timeout'; terminal: string; messageId: string; drainingForMs: number };

export function auditAttachedDeadlines(
  runtime: ReadonlyMap<string, RuntimeSession>,
  limits: AttachedDeadlineLimits,
  now: number,
): AttachedDeadlineEvent[] {
  const events: AttachedDeadlineEvent[] = [];
  for (const [terminal, current] of runtime) {
    if (current.state === 'busy' && current.messageId) {
      // Stall reference: the later of last PTY output and the dispatch write,
      // so a task that never produced output still stalls from its start.
      const reference = Math.max(current.lastOutputAt, current.dispatchedAtMs ?? 0);
      const stalledForMs = now - reference;
      if (
        reference > 0 &&
        stalledForMs >= limits.taskStallTimeoutMs &&
        current.stallWarnedMessageId !== current.messageId
      ) {
        current.stallWarnedMessageId = current.messageId;
        events.push({
          kind: 'task_stall_warning',
          terminal,
          messageId: current.messageId,
          stalledForMs,
        });
      }
    }
    if (current.state === 'draining' && current.completionIdleGate && current.messageId) {
      const drainingForMs = now - current.completionIdleGate.armedAtMs;
      if (drainingForMs >= limits.completionIdleTimeoutMs) {
        current.state = 'attention_required';
        current.attentionReason = 'completion_idle_timeout';
        current.lastError =
          `stable idle not proven within ${limits.completionIdleTimeoutMs}ms of the completion receipt`;
        events.push({
          kind: 'completion_idle_timeout',
          terminal,
          messageId: current.messageId,
          drainingForMs,
        });
      }
    }
  }
  return events;
}
