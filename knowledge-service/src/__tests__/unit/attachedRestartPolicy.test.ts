import { describe, expect, it } from 'vitest';
import {
  calculateRestartDelay,
  normalizeRestartPolicy,
} from '../../runner/attachedRestartPolicy';

describe('attached restart policy', () => {
  it('rejects operationally unsafe interval and attempt bounds', () => {
    expect(() => normalizeRestartPolicy({ maxAttempts: 101 })).toThrow(/maxAttempts/);
    expect(() => normalizeRestartPolicy({ initialDelayMs: 86_400_001 })).toThrow(/initialDelayMs/);
    expect(() => normalizeRestartPolicy({ maxDelayMs: 86_400_001 })).toThrow(/maxDelayMs/);
    expect(() => normalizeRestartPolicy({ stabilityResetMs: 86_400_001 })).toThrow(
      /stabilityResetMs/,
    );
  });

  it('rejects oversized attempts and invalid entropy instead of producing a zero delay', () => {
    const policy = normalizeRestartPolicy({ maxAttempts: 3 });
    expect(() => calculateRestartDelay(policy, Number.MAX_SAFE_INTEGER, 0.5)).toThrow(/attempt/);
    expect(() => calculateRestartDelay(policy, 1, Number.NaN)).toThrow(/entropy/);
    expect(() => calculateRestartDelay(policy, 1, Number.POSITIVE_INFINITY)).toThrow(/entropy/);
    expect(() => calculateRestartDelay(policy, 1, -0.1)).toThrow(/entropy/);
    expect(() => calculateRestartDelay(policy, 1, 1.1)).toThrow(/entropy/);
  });
});
