import { describe, expect, it, vi } from 'vitest';
import {
  AttachedCompletionPump,
  startAttachedCompletionPump,
  type AttachedPumpManager,
  type AttachedPumpOptions,
} from '../../runner/attachedCompletionPump';
import type { AttachedSessionSnapshot } from '../../runner/attachedSessionTypes';
import type { CompletionCursorStore } from '../../runner/completionCursorStore';
import type { CompletionReceiptPage, RunnerCompletionReceipt } from '../../runner/serverClient';

const T0 = Date.parse('2026-07-23T00:00:00.000Z');

function receipt(sequence: number, messageId = `MSG-${sequence}`): RunnerCompletionReceipt {
  return {
    sequence,
    islandId: 'island-a',
    terminalId: 'backend',
    messageId,
    completedAt: '2026-07-23T00:00:01.000Z',
    source: 'mcp_complete_task',
  };
}

function page(
  receipts: RunnerCompletionReceipt[],
  hasMore = false,
): CompletionReceiptPage {
  return {
    islandId: 'island-a',
    receipts,
    nextCursor: receipts.length > 0 ? receipts[receipts.length - 1].sequence : 0,
    hasMore,
  };
}

class MemoryCursors {
  readonly values = new Map<string, number>();
  get(key: string): number {
    return this.values.get(key) ?? 0;
  }
  advance(key: string, cursor: number): void {
    const current = this.get(key);
    if (cursor < current) throw new Error(`cursor regression: ${cursor} < ${current}`);
    this.values.set(key, cursor);
  }
}

function makeManager(overrides: Partial<AttachedPumpManager> = {}): AttachedPumpManager {
  return {
    snapshot: vi.fn(() => undefined),
    acknowledgeCompletion: vi.fn(() => true),
    reconcileMarker: vi.fn(() => false),
    acknowledgeStableIdle: vi.fn(() => false),
    auditDeadlines: vi.fn(() => []),
    ...overrides,
  };
}

function fixture(overrides: Partial<AttachedPumpOptions> = {}) {
  const cursors = new MemoryCursors();
  const pages: CompletionReceiptPage[] = [];
  const fetchCompletionReceipts = vi.fn(async () => pages.shift() ?? page([]));
  const manager = makeManager();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const options: AttachedPumpOptions = {
    terminals: ['backend'],
    expectedIslandId: 'island-a',
    limits: { completionIdleTimeoutMs: 30_000, taskStallTimeoutMs: 600_000 },
    client: {
      fetchCompletionReceipts,
      completionStreamKey: (terminal, island) => `${terminal}|${island}`,
    },
    cursors: cursors as unknown as CompletionCursorStore,
    manager,
    logger,
    now: () => T0,
    ...overrides,
  };
  return { options, cursors, pages, fetchCompletionReceipts, manager: options.manager, logger };
}

describe('AttachedCompletionPump', () => {
  it('requires terminals and an island scope', () => {
    expect(() => new AttachedCompletionPump(fixture({ terminals: [] }).options)).toThrow(
      /at least one terminal/,
    );
    expect(
      () => new AttachedCompletionPump(fixture({ expectedIslandId: '' }).options),
    ).toThrow(/expectedIslandId/);
  });

  it('delivers receipts and advances the cursor only after acceptance', async () => {
    const { options, cursors, pages, manager } = fixture();
    pages.push(page([receipt(1), receipt(2)]));
    const pump = new AttachedCompletionPump(options);

    const report = await pump.pumpOnce();

    expect(report.delivered).toBe(2);
    expect(manager.acknowledgeCompletion).toHaveBeenCalledTimes(2);
    expect(cursors.get('backend|island-a')).toBe(2);
  });

  it('reconciles when live acknowledgement is refused', async () => {
    const { options, cursors, pages } = fixture();
    const manager = makeManager({
      acknowledgeCompletion: vi.fn(() => false),
      reconcileMarker: vi.fn(() => true),
    });
    options.manager = manager;
    pages.push(page([receipt(5)]));

    const report = await new AttachedCompletionPump(options).pumpOnce();

    expect(report.delivered).toBe(1);
    expect(manager.reconcileMarker).toHaveBeenCalledTimes(1);
    expect(cursors.get('backend|island-a')).toBe(5);
  });

  it('blocks the cursor when the CURRENT task receipt cannot be applied', async () => {
    const { options, cursors, pages } = fixture();
    const snapshot = { messageId: 'MSG-7' } as AttachedSessionSnapshot;
    const manager = makeManager({
      snapshot: vi.fn(() => snapshot),
      acknowledgeCompletion: vi.fn(() => false),
      reconcileMarker: vi.fn(() => false),
    });
    options.manager = manager;
    pages.push(page([receipt(7, 'MSG-7'), receipt(8, 'MSG-8')]));

    const report = await new AttachedCompletionPump(options).pumpOnce();

    expect(report.blockedTerminals).toEqual(['backend']);
    expect(report.delivered).toBe(0);
    // Neither the blocked receipt nor anything after it advanced.
    expect(cursors.get('backend|island-a')).toBe(0);
  });

  it('advances the page prefix delivered before a blocking receipt', async () => {
    const { options, cursors, pages } = fixture();
    const manager = makeManager({
      snapshot: vi.fn(() => ({ messageId: 'MSG-8' }) as AttachedSessionSnapshot),
      acknowledgeCompletion: vi.fn((receipt: RunnerCompletionReceipt) => receipt.sequence === 7),
      reconcileMarker: vi.fn(() => false),
    });
    options.manager = manager;
    pages.push(page([receipt(7, 'MSG-7'), receipt(8, 'MSG-8'), receipt(9, 'MSG-9')]));

    const report = await new AttachedCompletionPump(options).pumpOnce();

    expect(report.delivered).toBe(1);
    expect(report.blockedTerminals).toEqual(['backend']);
    // The delivered prefix advanced durably; the blocked receipt did not.
    expect(cursors.get('backend|island-a')).toBe(7);
  });

  it('advances past historical receipts nothing in this runtime owns', async () => {
    const { options, cursors, pages } = fixture();
    const manager = makeManager({
      snapshot: vi.fn(() => ({ messageId: 'MSG-CURRENT' }) as AttachedSessionSnapshot),
      acknowledgeCompletion: vi.fn(() => false),
      reconcileMarker: vi.fn(() => false),
    });
    options.manager = manager;
    pages.push(page([receipt(3, 'MSG-OLD')]));

    const report = await new AttachedCompletionPump(options).pumpOnce();

    expect(report.delivered).toBe(0);
    expect(report.blockedTerminals).toEqual([]);
    expect(cursors.get('backend|island-a')).toBe(3);
  });

  it('follows hasMore pages within the per-pump bound', async () => {
    const { options, pages, fetchCompletionReceipts, cursors } = fixture();
    pages.push(page([receipt(1)], true), page([receipt(2)], true), page([receipt(3)], false));

    await new AttachedCompletionPump(options).pumpOnce();

    expect(fetchCompletionReceipts).toHaveBeenCalledTimes(3);
    expect(fetchCompletionReceipts).toHaveBeenLastCalledWith('backend', 'island-a', 2);
    expect(cursors.get('backend|island-a')).toBe(3);
  });

  it('isolates a failing terminal and reports it', async () => {
    const { options, logger } = fixture({ terminals: ['backend', 'reviewer'] });
    options.client.fetchCompletionReceipts = vi.fn(async (terminal: string) => {
      if (terminal === 'backend') throw new Error('server unreachable');
      return page([]);
    });

    const report = await new AttachedCompletionPump(options).pumpOnce();

    expect(report.failedTerminals).toEqual(['backend']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Completion pump failed for backend: server unreachable/),
    );
  });

  it('offers a stable-idle proof for a draining terminal', async () => {
    const { options } = fixture();
    const snapshot: AttachedSessionSnapshot = {
      terminal: 'backend',
      state: 'draining',
      messageId: 'MSG-1',
      sessionGeneration: 2,
      receiptSequence: 44,
      outputEpoch: 9,
      completionGate: 'gate-1',
      lastOutputAt: T0 - 2_000,
      idleConfirmationCount: 2,
    };
    const manager = makeManager({
      snapshot: vi.fn(() => snapshot),
      acknowledgeCompletion: vi.fn(() => false),
      acknowledgeStableIdle: vi.fn(() => true),
    });
    options.manager = manager;

    const report = await new AttachedCompletionPump(options).pumpOnce();

    expect(report.released).toBe(1);
    expect(manager.acknowledgeStableIdle).toHaveBeenCalledWith({
      terminal: 'backend',
      messageId: 'MSG-1',
      sessionGeneration: 2,
      receiptSequence: 44,
      outputEpoch: 9,
      completionGate: 'gate-1',
      settledAt: new Date(T0).toISOString(),
    });
  });

  it('audits deadlines once per round and logs the events', async () => {
    const { options, logger } = fixture();
    options.manager = makeManager({
      auditDeadlines: vi.fn(() => [
        { kind: 'task_stall_warning', terminal: 'backend', messageId: 'MSG-1', stalledForMs: 700_000 },
      ]),
    });

    const report = await new AttachedCompletionPump(options).pumpOnce();

    expect(report.deadlineEvents).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/task_stall_warning \(backend\/MSG-1\): no PTY output for 700000ms/),
    );
  });
});

describe('startAttachedCompletionPump', () => {
  it('validates the interval', () => {
    const pump = { pumpOnce: vi.fn(async () => ({}) as never) };
    expect(() => startAttachedCompletionPump(pump, 99, { info: vi.fn(), warn: vi.fn() })).toThrow(
      /interval/,
    );
  });

  it('runs immediately, coalesces wakes, and stop awaits the in-flight pump', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const pump = {
        pumpOnce: vi.fn(async () => {
          calls++;
          if (calls === 1) await gate;
          return {} as never;
        }),
      };
      const handle = startAttachedCompletionPump(pump, 1_000, { info: vi.fn(), warn: vi.fn() });
      expect(calls).toBe(1);

      // Wakes during the in-flight pump coalesce into one follow-up.
      handle.wake();
      handle.wake();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);

      // Interval keeps pumping.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(3);

      await handle.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(3);
      handle.wake();
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps scheduling after a failed round and logs the failure', async () => {
    vi.useFakeTimers();
    try {
      const logger = { info: vi.fn(), warn: vi.fn() };
      let calls = 0;
      const pump = {
        pumpOnce: vi.fn(async () => {
          calls++;
          if (calls === 1) throw new Error('round failed');
          return {} as never;
        }),
      };
      const handle = startAttachedCompletionPump(pump, 1_000, logger);
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/Completion pump round failed: round failed/),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(2);
      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
