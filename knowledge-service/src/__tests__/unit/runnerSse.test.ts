/**
 * SSE wake-up unit tests — parser framing and poll-loop wake semantics.
 * PINS: SSE events only nudge the poll (never launch directly), heartbeats
 * are ignored, and a wake during an in-flight tick queues exactly one
 * follow-up tick.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSseParser, type SseEvent } from '../../runner/sseListener';
import { startPollLoop } from '../../runner/pollLoop';
import { RunnerConfigSchema, type RunnerConfig } from '../../runner/runnerConfig';
import { ProcessedStore } from '../../runner/processedStore';
import type { UnreadTask } from '../../runner/serverClient';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-sse-'));

function makeConfig(): RunnerConfig {
  const base = RunnerConfigSchema.parse({
    server_url: 'http://localhost:3466',
    token: 't',
    poll_interval_ms: 60_000, // Long: only wake() should trigger extra ticks
    log_dir: path.join(TMP_DIR, 'logs'),
    terminals: { backend: { workdir: TMP_DIR } },
  });
  return { ...base, token: 't' };
}

// ─── SSE parser ──────────────────────────────────────────────────────────────

describe('createSseParser', () => {
  function collect(): { events: SseEvent[]; parse: (chunk: string) => void } {
    const events: SseEvent[] = [];
    const parse = createSseParser((e) => events.push(e));
    return { events, parse };
  }

  it('parses a complete event frame', () => {
    const { events, parse } = collect();
    parse('event: new_message\ndata: {"messageId":"MSG-1"}\n\n');
    expect(events).toEqual([{ event: 'new_message', data: '{"messageId":"MSG-1"}' }]);
  });

  it('reassembles frames split across chunks (network fragmentation)', () => {
    const { events, parse } = collect();
    parse('event: new_me');
    parse('ssage\ndata: {"messageId":');
    parse('"MSG-2"}\n\n');
    expect(events).toEqual([{ event: 'new_message', data: '{"messageId":"MSG-2"}' }]);
  });

  it('handles several frames in one chunk and CRLF line endings', () => {
    const { events, parse } = collect();
    parse('event: connected\r\ndata: {}\r\n\r\nevent: new_message\r\ndata: {"a":1}\r\n\r\n');
    expect(events.map((e) => e.event)).toEqual(['connected', 'new_message']);
  });

  it('ignores heartbeat comments and frames without data', () => {
    const { events, parse } = collect();
    parse(':heartbeat\n\n');
    parse('event: nothing\n\n');
    parse(':heartbeat\ndata: real\n\n');
    expect(events).toEqual([{ event: 'message', data: 'real' }]);
  });
});

// ─── Poll-loop wake ──────────────────────────────────────────────────────────

describe('startPollLoop wake()', () => {
  function makeDeps() {
    const store = new ProcessedStore(path.join(TMP_DIR, `wake-${Math.random().toString(36).slice(2)}.json`));
    return {
      store,
      fetchUnread: vi.fn(async (): Promise<UnreadTask[]> => []),
      claimTask: vi.fn(async () => undefined),
      releaseTask: vi.fn(async () => undefined),
      launch: vi.fn().mockReturnValue({ started: true }),
      isBusy: () => false,
    };
  }

  it('wake() triggers an immediate extra poll between scheduled ticks', async () => {
    const deps = makeDeps();
    const loop = startPollLoop(makeConfig(), deps);
    await vi.waitFor(() => expect(deps.fetchUnread).toHaveBeenCalledTimes(1));

    loop.wake();
    await vi.waitFor(() => expect(deps.fetchUnread).toHaveBeenCalledTimes(2));
    loop.stop();
  });

  it('a wake during an in-flight tick queues exactly one follow-up tick', async () => {
    const deps = makeDeps();
    let release: (() => void) | undefined;
    deps.fetchUnread.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );

    const loop = startPollLoop(makeConfig(), deps);
    await vi.waitFor(() => expect(release).toBeDefined());

    // Three wakes while the first tick is still fetching → one queued tick
    loop.wake();
    loop.wake();
    loop.wake();
    release?.();

    await vi.waitFor(() => expect(deps.fetchUnread).toHaveBeenCalledTimes(2));
    // Settle: no runaway extra ticks beyond the single queued one
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deps.fetchUnread).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('wake() after stop() is a no-op', async () => {
    const deps = makeDeps();
    const loop = startPollLoop(makeConfig(), deps);
    await vi.waitFor(() => expect(deps.fetchUnread).toHaveBeenCalledTimes(1));

    loop.stop();
    loop.wake();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deps.fetchUnread).toHaveBeenCalledTimes(1);
  });

  it('drains a deferred fetch and never claims or launches its result', async () => {
    const deps = makeDeps();
    let resolveFetch: ((tasks: UnreadTask[]) => void) | undefined;
    deps.fetchUnread.mockImplementationOnce(
      () =>
        new Promise<UnreadTask[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const loop = startPollLoop(makeConfig(), deps);
    await vi.waitFor(() => expect(resolveFetch).toBeDefined());

    let drained = false;
    const drain = loop.stopAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveFetch?.([{ id: 'MSG-LATE', terminal: 'backend' }]);
    await drain;

    expect(deps.claimTask).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('releases a claim won during shutdown before reporting drained', async () => {
    const deps = makeDeps();
    deps.fetchUnread.mockResolvedValueOnce([{ id: 'MSG-CLAIM', terminal: 'backend' }]);
    let resolveClaim: (() => void) | undefined;
    deps.claimTask.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const loop = startPollLoop(makeConfig(), deps);
    await vi.waitFor(() => expect(resolveClaim).toBeDefined());

    const drain = loop.stopAndDrain();
    resolveClaim?.();
    await drain;

    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.releaseTask).toHaveBeenCalledWith('backend', 'MSG-CLAIM');
  });

  it('rejects drain when a shutdown-time claim outcome is indeterminate', async () => {
    const deps = makeDeps();
    deps.fetchUnread.mockResolvedValueOnce([{ id: 'MSG-CLAIM', terminal: 'backend' }]);
    let rejectClaim: ((error: Error) => void) | undefined;
    deps.claimTask.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClaim = reject;
        }),
    );
    const loop = startPollLoop(makeConfig(), deps);
    await vi.waitFor(() => expect(rejectClaim).toBeDefined());

    const drain = loop.stopAndDrain();
    rejectClaim?.(new Error('connection reset'));

    await expect(drain).rejects.toThrow('claim outcome indeterminate during shutdown');
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('rejects drain when a shutdown-time claim release fails', async () => {
    const deps = makeDeps();
    deps.fetchUnread.mockResolvedValueOnce([{ id: 'MSG-CLAIM', terminal: 'backend' }]);
    let resolveClaim: (() => void) | undefined;
    deps.claimTask.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    deps.releaseTask.mockRejectedValueOnce(new Error('release unavailable'));
    const loop = startPollLoop(makeConfig(), deps);
    await vi.waitFor(() => expect(resolveClaim).toBeDefined());

    const drain = loop.stopAndDrain();
    resolveClaim?.();

    await expect(drain).rejects.toThrow('claim release failed during shutdown');
    expect(deps.launch).not.toHaveBeenCalled();
  });
});
