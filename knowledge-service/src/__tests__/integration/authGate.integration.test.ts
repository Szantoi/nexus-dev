/**
 * API auth-gate integration test — a real Express app with the same wiring
 * order as bootstrap/app.ts (gate before routes). PINS: in required mode the
 * whole /api surface needs a token; in open mode behavior is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { vi } from 'vitest';

const AGENTS_PATH = vi.hoisted(() => {
  const runId = require('crypto').randomBytes(6).toString('hex');
  const p = require('path').join(require('os').tmpdir(), `auth-gate-${runId}.yaml`);
  process.env.AGENTS_CONFIG_PATH = p;
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.AUTH_MODE;
  return p;
});

import {
  loadAgentTokens,
  setAuthMode,
  resetAuthStateForTests,
  apiAuthGate,
} from '../../auth/tokenAuth';

let request: any;
let app: any;

beforeAll(async () => {
  fs.writeFileSync(
    AGENTS_PATH,
    'master_token: "gate-master"\nagents:\n  "gate-backend": backend\n',
    'utf-8',
  );
  resetAuthStateForTests();
  loadAgentTokens();

  const express = (await import('express')).default;
  const supertest = (await import('supertest')).default;

  const server = express();
  server.use(express.json());
  server.use('/api', apiAuthGate); // same wiring order as bootstrap/app.ts
  server.get('/api/echo', (req: any, res: any) => {
    res.json({ ok: true, terminal: req.mcpTerminal ?? null });
  });
  server.get('/health', (_req: any, res: any) => res.json({ status: 'ok' }));

  app = server;
  request = supertest;
});

afterAll(() => {
  if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  resetAuthStateForTests();
});

describe('apiAuthGate wiring', () => {
  it('open mode: /api passes without a token (current behavior preserved)', async () => {
    setAuthMode('open');
    const r = await request(app).get('/api/echo');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('required mode: /api without token -> 401, invalid -> 403, valid -> identity attached', async () => {
    setAuthMode('required');

    const anon = await request(app).get('/api/echo');
    expect(anon.status).toBe(401);

    const bad = await request(app).get('/api/echo').set('Authorization', 'Bearer nope');
    expect(bad.status).toBe(403);

    const good = await request(app).get('/api/echo').set('Authorization', 'Bearer gate-backend');
    expect(good.status).toBe(200);
    expect(good.body.terminal).toBe('backend');

    const master = await request(app).get('/api/echo').set('Authorization', 'Bearer gate-master');
    expect(master.status).toBe(200);
    expect(master.body.terminal).toBe('root');

    setAuthMode('open');
  });

  it('required mode: non-/api routes (health) stay public', async () => {
    setAuthMode('required');
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    setAuthMode('open');
  });
});
