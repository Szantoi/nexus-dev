/**
 * Runner poll integration test — a real HTTP server standing in for the
 * central knowledge-service, a real ServerClient, and a mocked launcher.
 * PINS: the full poll cycle (auth → fetch → launch → dedup) works over
 * actual HTTP, and auth failures surface as failed terminals (backoff
 * input), never as launches.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type * as http from 'node:http';
import express from 'express';
import { RunnerConfigSchema, type RunnerConfig } from '../../runner/runnerConfig';
import { ProcessedStore } from '../../runner/processedStore';
import { ServerClient } from '../../runner/serverClient';
import { pollOnce } from '../../runner/pollLoop';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-int-'));
const TOKEN = 'runner-device-token';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();

  // Same contract as the real /api surface: apiAuthGate in required mode
  app.use('/api', (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (auth.substring(7) !== TOKEN) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  });

  app.get('/api/mailbox/:terminal/inbox', (req, res) => {
    if (req.params.terminal !== 'backend' || req.query.status !== 'UNREAD') {
      res.json({ terminal: req.params.terminal, count: 0, messages: [] });
      return;
    }
    res.json({
      terminal: 'backend',
      status: 'UNREAD',
      count: 2,
      messages: [
        { frontmatter: { id: 'MSG-100', model: 'haiku', priority: 'high', status: 'UNREAD' } },
        { frontmatter: { id: 'MSG-101', priority: 'medium', status: 'UNREAD' } },
      ],
    });
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
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeConfig(): RunnerConfig {
  const base = RunnerConfigSchema.parse({
    server_url: baseUrl,
    token: TOKEN,
    log_dir: path.join(TMP_DIR, 'logs'),
    terminals: { backend: { workdir: TMP_DIR } },
  });
  return { ...base, token: TOKEN };
}

describe('runner poll cycle over HTTP', () => {
  it('fetches UNREAD tasks with the token, launches each once, dedups after', async () => {
    const cfg = makeConfig();
    const store = new ProcessedStore(path.join(TMP_DIR, 'state.json'));
    const client = new ServerClient(cfg.server_url, cfg.token);
    const launch = vi.fn().mockReturnValue({ started: true });

    const deps = {
      store,
      fetchUnread: (t: string) => client.fetchUnread(t),
      launch,
      isBusy: () => false,
    };

    const first = await pollOnce(cfg, deps);
    expect(first.failedTerminals).toEqual([]);
    expect(first.launched).toBe(2);
    expect(launch).toHaveBeenCalledWith({ terminal: 'backend', messageId: 'MSG-100', model: 'haiku' });
    expect(launch).toHaveBeenCalledWith({ terminal: 'backend', messageId: 'MSG-101', model: undefined });

    // Second cycle: server still reports them UNREAD (no ack yet) → no relaunch
    const second = await pollOnce(cfg, deps);
    expect(second.launched).toBe(0);
    expect(second.skipped).toBe(2);
    expect(launch).toHaveBeenCalledTimes(2);

    // Dedup state survives a runner restart
    const restarted = new ProcessedStore(path.join(TMP_DIR, 'state.json'));
    restarted.load();
    expect(restarted.get('MSG-100')?.attempts).toBe(1);
  });

  it('an invalid token yields a failed terminal, never a launch', async () => {
    const cfg = makeConfig();
    const store = new ProcessedStore(path.join(TMP_DIR, 'state-bad.json'));
    const client = new ServerClient(cfg.server_url, 'wrong-token');
    const launch = vi.fn();

    const res = await pollOnce(cfg, {
      store,
      fetchUnread: (t: string) => client.fetchUnread(t),
      launch,
      isBusy: () => false,
    });

    expect(res.failedTerminals).toEqual(['backend']);
    expect(launch).not.toHaveBeenCalled();
  });
});
