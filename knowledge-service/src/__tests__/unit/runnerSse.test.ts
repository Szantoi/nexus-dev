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
      fetchUnread: vi.fn(async () => []),
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
});
