/**
 * sseListener.ts — Second-level wake-up for the runner.
 *
 * Opens an OUTBOUND SSE stream to the server's existing
 * `GET /api/mailbox/:terminal/subscribe` endpoint (Bearer-authenticated).
 * An incoming `new_message` event only WAKES the poll loop — the launch
 * decision stays with the poll (single source of truth), so a spoofed or
 * duplicated event can never cause more than one harmless early poll.
 * The poll itself remains the fallback when the stream is down.
 */

import { logger } from '../core/logger';

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE frame parser: feed it raw chunks, it emits complete
 * events. Comment lines (`:heartbeat`) are ignored per the SSE spec.
 */
export function createSseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let buffer = '';

  return (chunk: string): void => {
    buffer += chunk.replace(/\r\n/g, '\n');

    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let event = 'message'; // SSE default event name
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue; // comment / heartbeat
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) {
        onEvent({ event, data: dataLines.join('\n') });
      }

      sep = buffer.indexOf('\n\n');
    }
  };
}

export interface SseListenerOptions {
  serverUrl: string;
  token: string;
  terminal: string;
  /** Called when the server signals inbox activity for the terminal. */
  onWake: (terminal: string) => void;
  reconnectBaseMs?: number;
  maxBackoffMs?: number;
  fetchFn?: typeof fetch;
}

export interface SseListenerHandle {
  stop(): void;
}

export function startSseListener(opts: SseListenerOptions): SseListenerHandle {
  const reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
  const maxBackoffMs = opts.maxBackoffMs ?? 300_000;
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${opts.serverUrl.replace(/\/+$/, '')}/api/mailbox/${encodeURIComponent(opts.terminal)}/subscribe`;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let controller: AbortController | null = null;
  let failures = 0;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    controller = new AbortController();

    try {
      const res = await fetchFn(url, {
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE subscribe(${opts.terminal}) -> HTTP ${res.status}`);
      }

      const parse = createSseParser((event) => {
        if (event.event === 'connected') {
          failures = 0; // Stream is genuinely up — reset the backoff
          logger.info(`[Runner] SSE connected: ${opts.terminal}`);
          return;
        }
        // new_message / broadcast → just wake the poll, never act on payload
        logger.info(`[Runner] SSE wake (${event.event}): ${opts.terminal}`);
        opts.onWake(opts.terminal);
      });

      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (stopped) break;
        parse(decoder.decode(chunk, { stream: true }));
      }
      // Server closed the stream — reconnect below
    } catch (err) {
      if (stopped) return;
      failures++;
      logger.warn(
        `[Runner] SSE stream down (${opts.terminal}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!stopped) {
      const delay = Math.min(reconnectBaseMs * 2 ** failures, maxBackoffMs);
      timer = setTimeout(() => void connect(), delay);
      // Unref'd on purpose: the poll loop keeps the process alive; a dead
      // SSE reconnect timer must not.
      timer.unref();
    }
  };

  void connect();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    },
  };
}
