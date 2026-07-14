/**
 * Federation HTTP API tests (ADR-066 reference, increment 2).
 * Exercises POST /send → GET /inbox → GET /message/:id → POST /ack over Express.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

const runId = crypto.randomBytes(6).toString('hex');
process.env.DATA_DIR = path.join(os.tmpdir(), `fedroutes-data-${runId}`);
process.env.TERMINALS_PATH = path.join(os.tmpdir(), `fedroutes-terminals-${runId}`);
// Point agents config at a nonexistent file so no tokens load → dev-mode auth (allow all).
process.env.AGENTS_CONFIG_PATH = path.join(os.tmpdir(), `no-such-agents-${runId}.yaml`);
delete process.env.MCP_AUTH_TOKEN;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any, app: any;

beforeAll(async () => {
  const express = (await import('express')).default;
  const supertest = (await import('supertest')).default;
  const store = await import('../task-message-box/store');
  await store.initDatabase();
  const { createFederationApiRouter } = await import('../interfaces/http/routes/federation.routes');

  const server = express();
  server.use(express.json());
  server.use('/api/federation', createFederationApiRouter());
  app = server;
  request = supertest;
});

describe('Federation HTTP API', () => {
  it('rejects a send missing required fields (400)', async () => {
    const res = await request(app).post('/api/federation/send').send({ from_island: 'spaceos' });
    expect(res.status).toBe(400);
  });

  it('send → inbox (metadata) → message (full) → ack (read)', async () => {
    // send
    const sent = await request(app).post('/api/federation/send').send({
      from_island: 'spaceos', from_terminal: 'root',
      to_island: 'cabinet', to_terminal: 'root',
      type: 'task', priority: 'high',
      subject: 'HTTP roundtrip', body: 'full body via http',
    });
    expect(sent.status).toBe(200);
    expect(sent.body.success).toBe(true);
    const id = sent.body.id;
    expect(id).toBeTruthy();

    // inbox — metadata only, no body
    const inbox = await request(app).get('/api/federation/inbox?island=cabinet&status=unread');
    expect(inbox.status).toBe(200);
    const row = inbox.body.messages.find((m: any) => m.id === id);
    expect(row).toBeTruthy();
    expect(row.subject).toBe('HTTP roundtrip');
    expect(row.description).toBeUndefined(); // token-optimized: no body in list

    // full message on demand
    const full = await request(app).get(`/api/federation/message/${id}`);
    expect(full.status).toBe(200);
    expect(full.body.message.description).toBe('full body via http');
    expect(full.body.message.to_island).toBe('cabinet');

    // ack → read
    const ack = await request(app).post('/api/federation/ack').send({ id });
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe('read');

    // after ack it is no longer in the unread inbox
    const unreadAfter = await request(app).get('/api/federation/inbox?island=cabinet&status=unread');
    expect(unreadAfter.body.messages.some((m: any) => m.id === id)).toBe(false);
  });

  it('inbox requires the island query param (400)', async () => {
    const res = await request(app).get('/api/federation/inbox');
    expect(res.status).toBe(400);
  });

  it('message/:id returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/federation/message/MSG-NOPE-999');
    expect(res.status).toBe(404);
  });

  it('status transitions via tool-call endpoint are validated + recorded in history', async () => {
    const sent = await request(app).post('/api/federation/send').send({
      from_island: 'spaceos', from_terminal: 'root',
      to_island: 'cabinet', to_terminal: 'backend',
      type: 'task', priority: 'high',
      subject: 'lifecycle walk', body: 'walk me through the lifecycle',
    });
    const id = sent.body.id;

    // valid chain: unread → read → in_progress → completed
    for (const to of ['read', 'in_progress', 'completed']) {
      const r = await request(app).post('/api/federation/status').send({ id, to, by: 'backend' });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe(to);
    }

    // trajectory is fully recorded, in order, with actor
    const hist = await request(app).get(`/api/federation/history/${id}`);
    expect(hist.status).toBe(200);
    expect(hist.body.status).toBe('completed');
    expect(hist.body.history.map((h: any) => h.to)).toEqual(['read', 'in_progress', 'completed']);
    expect(hist.body.history[0].by).toBe('backend');
  });

  it('rejects an invalid lifecycle transition with 409', async () => {
    const sent = await request(app).post('/api/federation/send').send({
      from_island: 'spaceos', from_terminal: 'root',
      to_island: 'cabinet', to_terminal: 'backend',
      type: 'task', priority: 'low',
      subject: 'bad transition', body: 'x',
    });
    const r = await request(app).post('/api/federation/status')
      .send({ id: sent.body.id, to: 'completed' }); // unread → completed not allowed
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('Invalid status transition');
  });

  it('rejects a non-canonical status value with 400', async () => {
    const r = await request(app).post('/api/federation/status')
      .send({ id: 'MSG-ANY-001', to: 'DONE' }); // legacy value, not canonical
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('not a canonical status');
  });

  it('history returns 404 for an unknown message', async () => {
    const r = await request(app).get('/api/federation/history/MSG-NOPE-999');
    expect(r.status).toBe(404);
  });
});
