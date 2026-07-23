import { describe, expect, it } from 'vitest';
import { auditAttachedDeadlines } from '../../runner/attachedDeadlines';
import { createRuntimeSession, type RuntimeSession } from '../../runner/attachedSessionTypes';

const LIMITS = { completionIdleTimeoutMs: 30_000, taskStallTimeoutMs: 600_000 };
const T0 = Date.parse('2026-07-23T00:00:00.000Z');

function busySession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  const current = createRuntimeSession(undefined);
  current.state = 'busy';
  current.messageId = 'MSG-1';
  current.dispatchedAtMs = T0;
  current.lastOutputAt = T0;
  return Object.assign(current, overrides);
}

describe('auditAttachedDeadlines', () => {
  it('warns exactly once per stalled busy task', () => {
    const current = busySession();
    const runtime = new Map([['backend', current]]);

    expect(
      auditAttachedDeadlines(runtime, LIMITS, T0 + LIMITS.taskStallTimeoutMs - 1),
    ).toEqual([]);
    const events = auditAttachedDeadlines(runtime, LIMITS, T0 + LIMITS.taskStallTimeoutMs);
    expect(events).toEqual([
      {
        kind: 'task_stall_warning',
        terminal: 'backend',
        messageId: 'MSG-1',
        stalledForMs: LIMITS.taskStallTimeoutMs,
      },
    ]);
    // Second audit of the same task stays silent; the state is unchanged.
    expect(auditAttachedDeadlines(runtime, LIMITS, T0 + LIMITS.taskStallTimeoutMs * 2)).toEqual([]);
    expect(current.state).toBe('busy');
  });

  it('measures the stall from the later of dispatch and last PTY output', () => {
    const current = busySession({ lastOutputAt: T0 + 500_000 });
    const runtime = new Map([['backend', current]]);

    expect(auditAttachedDeadlines(runtime, LIMITS, T0 + LIMITS.taskStallTimeoutMs)).toEqual([]);
    expect(
      auditAttachedDeadlines(runtime, LIMITS, T0 + 500_000 + LIMITS.taskStallTimeoutMs),
    ).toHaveLength(1);
  });

  it('warns again for a new task on the same terminal', () => {
    const current = busySession();
    const runtime = new Map([['backend', current]]);
    auditAttachedDeadlines(runtime, LIMITS, T0 + LIMITS.taskStallTimeoutMs);

    current.messageId = 'MSG-2';
    current.dispatchedAtMs = T0 + 700_000;
    const events = auditAttachedDeadlines(
      runtime,
      LIMITS,
      T0 + 700_000 + LIMITS.taskStallTimeoutMs,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'task_stall_warning', messageId: 'MSG-2' });
  });

  it('parks a draining terminal that cannot prove stable idle in time', () => {
    const current = createRuntimeSession(undefined);
    current.state = 'draining';
    current.messageId = 'MSG-1';
    current.completionIdleGate = {
      id: 'gate-1',
      sessionGeneration: 1,
      receiptSequence: 44,
      outputEpoch: 3,
      receiptCompletedAtMs: T0,
      armedAtMs: T0,
    };
    const runtime = new Map([['backend', current]]);

    expect(
      auditAttachedDeadlines(runtime, LIMITS, T0 + LIMITS.completionIdleTimeoutMs - 1),
    ).toEqual([]);
    expect(current.state).toBe('draining');

    const events = auditAttachedDeadlines(runtime, LIMITS, T0 + LIMITS.completionIdleTimeoutMs);

    expect(events).toEqual([
      {
        kind: 'completion_idle_timeout',
        terminal: 'backend',
        messageId: 'MSG-1',
        drainingForMs: LIMITS.completionIdleTimeoutMs,
      },
    ]);
    expect(current.state).toBe('attention_required');
    expect(current.attentionReason).toBe('completion_idle_timeout');
    expect(current.lastError).toMatch(/stable idle not proven within 30000ms/);
  });

  it('ignores terminals in other states', () => {
    const ready = createRuntimeSession(undefined);
    ready.state = 'ready';
    const runtime = new Map([['backend', ready]]);

    expect(auditAttachedDeadlines(runtime, LIMITS, T0 + 10 * LIMITS.taskStallTimeoutMs)).toEqual([]);
  });
});
