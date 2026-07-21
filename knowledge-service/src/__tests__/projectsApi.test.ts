/**
 * Server-managed projects API tests (epics + cornerstones).
 * PINS the expected behavior: goals change ONLY through the API (validated,
 * logged, audit-trailed), and "where are we?" is one GET /status call.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import * as fs from 'fs';

vi.hoisted(() => {
  process.env.AUTH_MODE = 'open';
  delete process.env.MCP_AUTH_TOKEN;
});

const runId = crypto.randomBytes(6).toString('hex');
process.env.DATA_DIR = path.join(os.tmpdir(), `proj-data-${runId}`);
process.env.TERMINALS_PATH = path.join(os.tmpdir(), `proj-terminals-${runId}`);
process.env.AGENTS_CONFIG_PATH = path.join(os.tmpdir(), `no-agents-${runId}.yaml`); // dev-mode auth
process.env.AUTH_MODE = 'open';
delete process.env.MCP_AUTH_TOKEN;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any, app: any;

beforeAll(async () => {
  const express = (await import('express')).default;
  const supertest = (await import('supertest')).default;
  const projectsRoutes = (await import('../interfaces/http/routes/projects.routes')).default;
  const server = express();
  server.use(express.json());
  server.use('/api/projects', projectsRoutes);
  app = server; request = supertest;
});

describe('server-managed epics + cornerstones', () => {
  it('creates an epic and its cornerstones through the API, then reads status in ONE call', async () => {
    const e = await request(app).post('/api/projects/epic').send({
      id: 'EPIC-TEST-CAD', name: 'Test CAD epic', status: 'active',
    });
    expect(e.status).toBe(200);

    for (const [id, name] of [['CP-T1', 'first stone'], ['CP-T2', 'second stone']] as const) {
      const c = await request(app).post('/api/projects/checkpoint').send({
        id, epic_id: 'EPIC-TEST-CAD', name, condition: `measurable: ${name}`, trigger_to: ['root'],
      });
      expect(c.status).toBe(200);
    }

    const s = await request(app).get('/api/projects/status');
    expect(s.status).toBe(200);
    const epic = s.body.projects.find((p: any) => p.epic_id === 'EPIC-TEST-CAD');
    expect(epic).toBeTruthy();
    expect(epic.progress).toEqual({ done: 0, total: 2, percent: 0 });
    expect(epic.next_checkpoint.id).toBe('CP-T1');
  });

  it('completes a cornerstone with audit trail and returns who to notify', async () => {
    const r = await request(app).post('/api/projects/checkpoint/CP-T1/complete').send({ by: 'backend' });
    expect(r.status).toBe(200);
    expect(r.body.checkpoint.status).toBe('done');
    expect(r.body.checkpoint.status_history[0]).toMatchObject({ from: 'pending', to: 'done', by: 'backend' });
    expect(r.body.notify).toEqual(['root']); // dense milestone feedback target

    const s = await request(app).get('/api/projects/status');
    const epic = s.body.projects.find((p: any) => p.epic_id === 'EPIC-TEST-CAD');
    expect(epic.progress).toEqual({ done: 1, total: 2, percent: 50 });
    expect(epic.next_checkpoint.id).toBe('CP-T2'); // next pending advanced
  });

  it('completion is idempotent; unknown checkpoint is 404', async () => {
    const again = await request(app).post('/api/projects/checkpoint/CP-T1/complete').send({});
    expect(again.status).toBe(200);
    expect(again.body.notify).toEqual([]); // no re-notification

    const nope = await request(app).post('/api/projects/checkpoint/CP-NOPE/complete').send({});
    expect(nope.status).toBe(404);
  });

  it('rejects a checkpoint for a nonexistent epic (validation at the server)', async () => {
    const r = await request(app).post('/api/projects/checkpoint').send({
      id: 'CP-ORPHAN', epic_id: 'EPIC-NOPE', name: 'orphan', condition: 'x',
    });
    expect(r.status).toBe(404);
  });

  it('seeds from a legacy EPICS.yaml file, after which the DB serves the truth', async () => {
    const seedFile = path.join(os.tmpdir(), `epics-seed-${runId}.yaml`);
    fs.writeFileSync(seedFile, [
      'epics:',
      '  - id: EPIC-SEEDED',
      '    name: "Seeded epic"',
      '    status: active',
      '    checkpoints:',
      '      - id: CP-S1',
      '        name: "seeded stone"',
      '        status: done',
      '        condition: "was already done"',
      '      - id: CP-S2',
      '        name: "open stone"',
      '        condition: "still open"',
      '        trigger_to: [root]',
    ].join('\n'), 'utf-8');

    const imp = await request(app).post('/api/projects/import-yaml').send({ path: seedFile });
    expect(imp.status).toBe(200);
    expect(imp.body.epics).toBe(1);
    expect(imp.body.checkpoints).toBe(2);

    const s = await request(app).get('/api/projects/status');
    const seeded = s.body.projects.find((p: any) => p.epic_id === 'EPIC-SEEDED');
    expect(seeded.progress).toEqual({ done: 1, total: 2, percent: 50 });
    expect(seeded.next_checkpoint.id).toBe('CP-S2');
  });
});
