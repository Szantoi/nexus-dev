import { describe, expect, it, vi } from 'vitest';
import type { LaunchRequest, LaunchResult } from '../../runner/sessionLauncher';
import type { TerminalSink } from '../../runner/terminalSink';
import {
  TerminalSinkLifecycleError,
  TerminalSinkRouter,
} from '../../runner/terminalSinkRouter';

interface SinkFixture {
  sink: TerminalSink;
  dispatch: ReturnType<typeof vi.fn<(req: LaunchRequest) => LaunchResult>>;
  isBusy: ReturnType<typeof vi.fn<(terminal: string) => boolean>>;
  cancel: ReturnType<typeof vi.fn<(terminal: string, reason?: string) => boolean>>;
  cancelAll: ReturnType<typeof vi.fn<(reason?: string) => number>>;
  activeCount: ReturnType<typeof vi.fn<() => number>>;
  ensureReady: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
  shutdown: ReturnType<typeof vi.fn<(reason?: string) => Promise<void>>>;
}

function makeSink(options: {
  launchResult?: LaunchResult;
  busy?: boolean;
  cancelled?: boolean;
  cancelAllCount?: number;
  activeCount?: number;
  ensureReady?: () => void | Promise<void>;
  shutdown?: (reason?: string) => Promise<void>;
  minimumShutdownGraceMs?: number;
} = {}): SinkFixture {
  const dispatch = vi.fn<(req: LaunchRequest) => LaunchResult>(() =>
    options.launchResult ?? { started: true },
  );
  const isBusy = vi.fn<(terminal: string) => boolean>(() => options.busy ?? false);
  const cancel = vi.fn<(terminal: string, reason?: string) => boolean>(
    () => options.cancelled ?? false,
  );
  const cancelAll = vi.fn<(reason?: string) => number>(() => options.cancelAllCount ?? 0);
  const activeCount = vi.fn<() => number>(() => options.activeCount ?? 0);
  const ensureReady = vi.fn<() => void | Promise<void>>(options.ensureReady ?? (() => undefined));
  const shutdown = vi.fn<(reason?: string) => Promise<void>>(
    options.shutdown ?? (async () => Promise.resolve()),
  );
  return {
    sink: {
      dispatch,
      isBusy,
      cancel,
      cancelAll,
      activeCount,
      ensureReady,
      shutdown,
      minimumShutdownGraceMs:
        options.minimumShutdownGraceMs === undefined
          ? undefined
          : () => options.minimumShutdownGraceMs!,
    },
    dispatch,
    isBusy,
    cancel,
    cancelAll,
    activeCount,
    ensureReady,
    shutdown,
  };
}

describe('TerminalSinkRouter', () => {
  it('routes mixed headless and attached terminals to their configured sinks', () => {
    const headless = makeSink({ launchResult: { started: true, provider: 'codex' } });
    const attached = makeSink({ launchResult: { started: true, provider: 'claude' } });
    const router = new TerminalSinkRouter(
      new Map([
        ['backend', headless.sink],
        ['explorer', attached.sink],
      ]),
    );
    const headlessRequest = { terminal: 'backend', messageId: 'MSG-1' };
    const attachedRequest = { terminal: 'explorer', messageId: 'MSG-2' };

    expect(router.dispatch(headlessRequest)).toEqual({ started: true, provider: 'codex' });
    expect(router.dispatch(attachedRequest)).toEqual({ started: true, provider: 'claude' });
    expect(headless.dispatch).toHaveBeenCalledWith(headlessRequest);
    expect(attached.dispatch).toHaveBeenCalledWith(attachedRequest);
  });

  it('fails closed for an unknown terminal without calling any sink', () => {
    const configured = makeSink();
    const router = new TerminalSinkRouter(new Map([['backend', configured.sink]]));

    expect(router.isBusy('unknown')).toBe(true);
    expect(router.dispatch({ terminal: 'unknown', messageId: 'MSG-1' })).toEqual({
      started: false,
      reason: 'terminal sink not configured: unknown',
    });
    expect(router.cancel('unknown', 'shutdown')).toBe(false);
    expect(configured.isBusy).not.toHaveBeenCalled();
    expect(configured.dispatch).not.toHaveBeenCalled();
    expect(configured.cancel).not.toHaveBeenCalled();
  });

  it('routes terminal-scoped busy and cancel calls', () => {
    const headless = makeSink({ busy: true, cancelled: true });
    const attached = makeSink();
    const router = new TerminalSinkRouter(
      new Map([
        ['backend', headless.sink],
        ['explorer', attached.sink],
      ]),
    );

    expect(router.isBusy('backend')).toBe(true);
    expect(router.cancel('backend', 'operator-request')).toBe(true);
    expect(headless.isBusy).toHaveBeenCalledWith('backend');
    expect(headless.cancel).toHaveBeenCalledWith('backend', 'operator-request');
    expect(attached.isBusy).not.toHaveBeenCalled();
    expect(attached.cancel).not.toHaveBeenCalled();
  });

  it('aggregates cancel and active counts once per unique sink instance', () => {
    const sharedHeadless = makeSink({ cancelAllCount: 2, activeCount: 2 });
    const attached = makeSink({ cancelAllCount: 1, activeCount: 1 });
    const router = new TerminalSinkRouter(
      new Map([
        ['backend', sharedHeadless.sink],
        ['reviewer', sharedHeadless.sink],
        ['explorer', attached.sink],
      ]),
    );

    expect(router.activeCount()).toBe(3);
    expect(router.cancelAll('runner-shutdown')).toBe(3);
    expect(sharedHeadless.activeCount).toHaveBeenCalledTimes(1);
    expect(attached.activeCount).toHaveBeenCalledTimes(1);
    expect(sharedHeadless.cancelAll).toHaveBeenCalledTimes(1);
    expect(sharedHeadless.cancelAll).toHaveBeenCalledWith('runner-shutdown');
    expect(attached.cancelAll).toHaveBeenCalledTimes(1);
    expect(attached.cancelAll).toHaveBeenCalledWith('runner-shutdown');
  });

  it('reports the strictest shutdown grace requirement across unique sinks', () => {
    const headless = makeSink();
    const attached = makeSink({ minimumShutdownGraceMs: 17_000 });
    const router = new TerminalSinkRouter(
      new Map([
        ['backend', headless.sink],
        ['explorer', attached.sink],
      ]),
    );

    expect(router.minimumShutdownGraceMs()).toBe(17_000);
  });

  it('prepares every unique sink once, including asynchronous readiness', async () => {
    const sharedHeadless = makeSink();
    const attached = makeSink({ ensureReady: async () => Promise.resolve() });
    const router = new TerminalSinkRouter(
      new Map([
        ['backend', sharedHeadless.sink],
        ['reviewer', sharedHeadless.sink],
        ['explorer', attached.sink],
      ]),
    );

    await router.ensureReady();

    expect(sharedHeadless.ensureReady).toHaveBeenCalledTimes(1);
    expect(attached.ensureReady).toHaveBeenCalledTimes(1);
  });

  it('propagates a readiness failure', async () => {
    const expected = new Error('attached preflight failed');
    const failing = makeSink({ ensureReady: async () => Promise.reject(expected) });
    const router = new TerminalSinkRouter(new Map([['explorer', failing.sink]]));

    await expect(router.ensureReady()).rejects.toBe(expected);
    expect(failing.ensureReady).toHaveBeenCalledTimes(1);
  });

  it('rolls back sinks that were ready before a later preflight failure', async () => {
    const prepared = makeSink();
    const expected = new Error('attached preflight failed');
    const failing = makeSink({ ensureReady: async () => Promise.reject(expected) });
    const router = new TerminalSinkRouter(
      new Map([
        ['backend', prepared.sink],
        ['explorer', failing.sink],
      ]),
    );

    await expect(router.ensureReady()).rejects.toBe(expected);

    expect(prepared.shutdown).toHaveBeenCalledWith('preflight-rollback');
    expect(failing.shutdown).toHaveBeenCalledWith('preflight-rollback');
  });

  it('reports both readiness and rollback cleanup failures', async () => {
    const expected = new Error('attached preflight failed');
    const prepared = makeSink({
      shutdown: async () => Promise.reject(new Error('rollback cleanup failed')),
    });
    const failing = makeSink({ ensureReady: async () => Promise.reject(expected) });
    const router = new TerminalSinkRouter(
      new Map([
        ['backend', prepared.sink],
        ['explorer', failing.sink],
      ]),
    );

    const failure = await router.ensureReady().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TerminalSinkLifecycleError);
    expect((failure as TerminalSinkLifecycleError).errors).toEqual([
      expected,
      expect.objectContaining({ message: 'rollback cleanup failed' }),
    ]);
    expect((failure as Error).message).toContain(
      'attached preflight failed | rollback cleanup failed',
    );
    expect(prepared.shutdown).toHaveBeenCalledWith('preflight-rollback');
    expect(failing.shutdown).toHaveBeenCalledWith('preflight-rollback');
  });

  it('awaits shutdown once per unique sink instance', async () => {
    const shared = makeSink();
    const attached = makeSink();
    const router = new TerminalSinkRouter(
      new Map([
        ['backend', shared.sink],
        ['reviewer', shared.sink],
        ['explorer', attached.sink],
      ]),
    );

    await router.shutdown('operator-request');

    expect(shared.shutdown).toHaveBeenCalledTimes(1);
    expect(shared.shutdown).toHaveBeenCalledWith('operator-request');
    expect(attached.shutdown).toHaveBeenCalledTimes(1);
    expect(attached.shutdown).toHaveBeenCalledWith('operator-request');
  });

  it('keeps bounded shutdown root causes in the operator-visible message', async () => {
    const longCause = `provider cleanup failed ${'x'.repeat(400)}`;
    const failing = makeSink({
      shutdown: async () => Promise.reject(new Error(longCause)),
    });
    const router = new TerminalSinkRouter(new Map([['explorer', failing.sink]]));

    const failure = await router.shutdown().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TerminalSinkLifecycleError);
    expect((failure as Error).message).toContain('provider cleanup failed');
    expect((failure as Error).message).not.toContain('x'.repeat(200));
    expect((failure as Error).message).not.toContain('\n');
  });

  it('does not observe mutations to the caller-owned routing map', () => {
    const original = makeSink({ busy: false });
    const replacement = makeSink({ busy: false });
    const routes = new Map([['backend', original.sink]]);
    const router = new TerminalSinkRouter(routes);
    routes.set('backend', replacement.sink);

    router.isBusy('backend');

    expect(original.isBusy).toHaveBeenCalledWith('backend');
    expect(replacement.isBusy).not.toHaveBeenCalled();
  });
});
