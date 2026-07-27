import type { AttachedTerminalPolicy } from './attachedSessionTypes';
import { ValidationError } from '../core/errors';

const MAX_STARTUP_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_READY_CONFIRM_SAMPLES = 100;
const MAX_IDLE_SETTLE_MS = 60_000;
const MAX_IDLE_CONFIRM_SAMPLES = 10;

export function validateAttachedTerminalPolicy(
  terminal: string,
  policy: AttachedTerminalPolicy,
): void {
  if (!policy.expectedIslandId.trim()) {
    throw new ValidationError(`attached terminal expectedIslandId must be non-empty: ${terminal}`, { expectedIslandId: 'must be non-empty' });
  }
  if (
    !Number.isInteger(policy.startupTimeoutMs) ||
    policy.startupTimeoutMs < 1 ||
    policy.startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS
  ) {
    throw new ValidationError(`attached terminal startupTimeoutMs is out of range: ${terminal}`, { startupTimeoutMs: 'out of range' });
  }
  const samples = policy.readyConfirmSamples ?? 2;
  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > MAX_READY_CONFIRM_SAMPLES
  ) {
    throw new ValidationError(`attached terminal readyConfirmSamples is out of range: ${terminal}`, { readyConfirmSamples: 'out of range' });
  }
  if (
    !Number.isInteger(policy.idleSettleMs) ||
    policy.idleSettleMs < 1 ||
    policy.idleSettleMs > MAX_IDLE_SETTLE_MS
  ) {
    throw new ValidationError(`attached terminal idleSettleMs is out of range: ${terminal}`, { idleSettleMs: 'out of range' });
  }
  if (
    !Number.isInteger(policy.idleConfirmSamples) ||
    policy.idleConfirmSamples < 2 ||
    policy.idleConfirmSamples > MAX_IDLE_CONFIRM_SAMPLES
  ) {
    throw new ValidationError(`attached terminal idleConfirmSamples is out of range: ${terminal}`, { idleConfirmSamples: 'out of range' });
  }
}
