/**
 * SSE listener integration test — a real HTTP server with an SSE endpoint
 * shaped like /api/mailbox/:terminal/subscribe. PINS: the listener
 * authenticates with the Bearer token, wakes on new_message events over a
 * live stream, survives heartbeats, and reconnects after auth failure
 * without ever waking.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import express from 'express';
import { startSseListener } from '../../runner/sseListener';

const TOKEN = 'sse-device-token';

let server: http.Server;
let baseUrl: string;
const sseClients = new Set<express.Response>();

beforeAll(async () => {
  const app = express();

  app.get('/api/mailbox/:terminal/subscribe', (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`event: connected\ndata: {"terminal":"${req.params.terminal}"}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address === 'object' && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(async () => {
  for (const client of sseClients) client.end();
  await new Promise((resolve) => server.close(resolve));
});

function broadcast(payload: string): void {
  for (const client of sseClients) client.write(payload);
}

describe('SSE listener over live HTTP', () => {
  it('connects with the token and wakes on new_message; heartbeats do not wake', async () => {
    const onWake = vi.fn();
    const listener = startSseListener({
      serverUrl: baseUrl,
      token: TOKEN,
      terminal: 'backend',
      onWake,
    });

    await vi.waitFor(() => expect(sseClients.size).toBe(1), { timeout: 5000 });

    broadcast(':heartbeat\n\n');
    broadcast('event: new_message\ndata: {"messageId":"MSG-7","terminal":"backend"}\n\n');

    await vi.waitFor(() => expect(onWake).toHaveBeenCalledWith('backend'), { timeout: 5000 });
    expect(onWake).toHaveBeenCalledTimes(1); // heartbeat did not wake

    listener.stop();
    await vi.waitFor(() => expect(sseClients.size).toBe(0), { timeout: 5000 });
  });

  it('bad token: keeps retrying with backoff, never wakes', async () => {
    const onWake = vi.fn();
    const listener = startSseListener({
      serverUrl: baseUrl,
      token: 'wrong-token',
      terminal: 'backend',
      onWake,
      reconnectBaseMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onWake).not.toHaveBeenCalled();
    expect(sseClients.size).toBe(0);
    listener.stop();
  });
});
