import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertRunnerShutdownBudget,
  RunnerShutdownCoordinator,
  stopRunnerIngress,
} from '../../runner/runnerLifecycle';
import type { TerminalSink } from '../../runner/terminalSink';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeSink(options: {
  active?: () => number;
  shutdown?: () => Promise<void>;
} = {}): TerminalSink {
  return {
    dispatch: vi.fn(() => ({ started: true })),
    isBusy: vi.fn(() => false),
    cancel: vi.fn(() => false),
    cancelAll: vi.fn(() => 0),
    activeCount: vi.fn(options.active ?? (() => 0)),
    shutdown: vi.fn(options.shutdown ?? (async () => Promise.resolve())),
  };
}

function fixture(options: {
  sink?: TerminalSink;
  saveState?: () => void;
  graceMs?: number;
} = {}) {
  const exit = vi.fn<(code: 0 | 1) => void>();
  const logger = { info: vi.fn(), error: vi.fn() };
  const coordinator = new RunnerShutdownCoordinator({
    sink: options.sink ?? makeSink(),
    graceMs: options.graceMs ?? 1_000,
    saveState: options.saveState ?? vi.fn(),
    exit,
    logger,
  });
  return { coordinator, exit, logger };
}

describe('RunnerShutdownCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits zero only after ingress drain, state save, cleanup, and active=0', async () => {
    const cleanup = deferred();
    const sink = makeSink({ shutdown: () => cleanup.promise });
    const saveState = vi.fn();
    const { coordinator, exit } = fixture({ sink, saveState });
    const stopIngress = vi.fn(async () => Promise.resolve());
    coordinator.registerIngressStopper(stopIngress);

    const completion = coordinator.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();
    expect(stopIngress).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledTimes(1);

    cleanup.resolve(undefined);
    await completion;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits one when state persistence fails even if cleanup succeeds', async () => {
    const { coordinator, exit, logger } = fixture({
      saveState: () => {
        throw new Error('disk full');
      },
    });

    await coordinator.begin('SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith('[Runner] runner state save failed:', 'disk full');
  });

  it('preserves a nested cleanup root cause and exits one', async () => {
    const sink = makeSink({
      shutdown: async () => Promise.reject(new Error('rollback child cleanup failed')),
    });
    const { coordinator, exit, logger } = fixture({ sink });

    await coordinator.begin('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[Runner] terminal cleanup failed:',
      'rollback child cleanup failed',
    );
  });

  it('bounds and single-lines operator-visible lifecycle details', async () => {
    const sink = makeSink({
      shutdown: async () => Promise.reject(new Error(`cleanup\nsecret-adjacent ${'x'.repeat(2_000)}`)),
    });
    const { coordinator, logger } = fixture({ sink });

    await coordinator.begin('SIGTERM');

    const detail = logger.error.mock.calls[0]?.[1] as string;
    expect(detail).toContain('cleanup secret-adjacent');
    expect(detail).not.toContain('\n');
    expect(detail.length).toBeLessThanOrEqual(500);
  });

  it('uses exit one at the grace deadline while ingress is still pending', async () => {
    const ingress = deferred();
    const sink = makeSink();
    const { coordinator, exit } = fixture({ graceMs: 500, sink });
    coordinator.registerIngressStopper(() => ingress.promise);

    const completion = coordinator.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.shutdown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await completion;

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('waits for active sessions after cleanup but never beyond grace', async () => {
    let active = 1;
    const sink = makeSink({ active: () => active });
    const { coordinator, exit } = fixture({ sink });
    const completion = coordinator.begin('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).not.toHaveBeenCalled();

    active = 0;
    await vi.advanceTimersByTimeAsync(50);
    await completion;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent when a second signal arrives', async () => {
    const sink = makeSink();
    const { coordinator, exit } = fixture({ sink });

    const first = coordinator.begin('SIGTERM');
    const second = coordinator.begin('SIGINT');
    await Promise.all([first, second]);

    expect(sink.shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('forces a startup failure to exit one after rollback', async () => {
    const sink = makeSink();
    const { coordinator, exit, logger } = fixture({ sink });

    await coordinator.begin('startup-failure', new Error('quarantine unavailable'));

    expect(sink.shutdown).toHaveBeenCalledWith('runner-startup-failure');
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[Runner] runner startup failed:',
      'quarantine unavailable',
    );
  });
});

describe('stopRunnerIngress', () => {
  it('flips the poll drain gate before stopping listeners and preserves every failure', async () => {
    const order: string[] = [];
    const loop = {
      stopAndDrain: vi.fn(async () => {
        order.push('poll-aborted');
        throw new Error('claim release uncertain');
      }),
    };
    const listeners = [
      {
        stop: vi.fn(() => {
          order.push('listener-one');
          throw new Error('listener close failed');
        }),
      },
      { stop: vi.fn(() => order.push('listener-two')) },
    ];

    const failure = await stopRunnerIngress(loop, listeners).catch((error: unknown) => error);

    expect(order).toEqual(['poll-aborted', 'listener-one', 'listener-two']);
    expect((failure as Error).message).toContain('listener close failed');
    expect((failure as Error).message).toContain('claim release uncertain');
  });
});

describe('assertRunnerShutdownBudget', () => {
  it('rejects a grace interval below a sink cleanup requirement', () => {
    const sink = {
      ...makeSink(),
      minimumShutdownGraceMs: () => 17_000,
    };

    expect(() => assertRunnerShutdownBudget(sink, 16_999)).toThrow(
      'below the terminal cleanup requirement 17000',
    );
    expect(() => assertRunnerShutdownBudget(sink, 17_000)).not.toThrow();
  });

  it('rejects an invalid sink-reported requirement', () => {
    const sink = { ...makeSink(), minimumShutdownGraceMs: () => Number.NaN };

    expect(() => assertRunnerShutdownBudget(sink, 20_000)).toThrow(
      'invalid shutdown grace requirement',
    );
  });
});
