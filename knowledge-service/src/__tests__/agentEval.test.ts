/**
 * Agent-eval suite tests: trajectory comparator (deterministic scoring with named
 * deviations) + golden path recording + the /api/eval HTTP roundtrip.
 * These tests PIN the expected behavior — the eval suite itself must be provably correct.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

vi.hoisted(() => {
  process.env.AUTH_MODE = 'open';
  delete process.env.MCP_AUTH_TOKEN;
});

const runId = crypto.randomBytes(6).toString('hex');
process.env.DATA_DIR = path.join(os.tmpdir(), `eval-data-${runId}`);
process.env.TERMINALS_PATH = path.join(os.tmpdir(), `eval-terminals-${runId}`);
process.env.GOLDEN_PATHS_DIR = path.join(os.tmpdir(), `eval-golden-${runId}`);
process.env.AGENTS_CONFIG_PATH = path.join(os.tmpdir(), `no-agents-${runId}.yaml`); // dev-mode auth
process.env.AUTH_MODE = 'open';
delete process.env.MCP_AUTH_TOKEN;

import { compareTrajectory } from '../eval/trajectoryComparator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any, app: any, store: any;

beforeAll(async () => {
  const express = (await import('express')).default;
  const supertest = (await import('supertest')).default;
  store = await import('../task-message-box/store');
  await store.initDatabase();
  const { createFederationApiRouter } = await import('../interfaces/http/routes/federation.routes');
  const { createEvalApiRouter } = await import('../interfaces/http/routes/eval.routes');
  const server = express();
  server.use(express.json());
  server.use('/api/federation', createFederationApiRouter());
  server.use('/api/eval', createEvalApiRouter());
  app = server; request = supertest;
});

describe('trajectory comparator (deterministic, explainable)', () => {
  it('scores an exact match as 1.0 with zero deviations', () => {
    const r = compareTrajectory(['read', 'in_progress', 'completed'], ['read', 'in_progress', 'completed']);
    expect(r.score).toBe(1);
    expect(r.deviations).toEqual([]);
  });

  it('names a skipped step as missing', () => {
    const r = compareTrajectory(['read', 'completed'], ['read', 'in_progress', 'completed']);
    expect(r.score).toBeCloseTo(1 - 1 / 3, 3);
    expect(r.deviations).toEqual([{ kind: 'missing', index: 1, expected: 'in_progress' }]);
  });

  it('names an added step as extra', () => {
    const r = compareTrajectory(['read', 'blocked', 'in_progress', 'completed'], ['read', 'in_progress', 'completed']);
    expect(r.deviations).toEqual([{ kind: 'extra', index: 1, actual: 'blocked' }]);
  });

  it('names a diverging step as substituted', () => {
    const r = compareTrajectory(['read', 'blocked'], ['read', 'completed']);
    expect(r.deviations).toEqual([{ kind: 'substituted', index: 1, expected: 'completed', actual: 'blocked' }]);
  });

  it('handles empty actual (nothing happened yet) without crashing', () => {
    const r = compareTrajectory([], ['read', 'completed']);
    expect(r.score).toBe(0);
    expect(r.deviations.length).toBe(2);
  });
});

describe('golden path recording + /api/eval roundtrip', () => {
  async function completedTask(): Promise<string> {
    const sent = await request(app).post('/api/federation/send').send({
      from_island: 'spaceos', from_terminal: 'root', to_island: 'cabinet', to_terminal: 'backend',
      type: 'task', priority: 'high', subject: `golden ${crypto.randomBytes(3).toString('hex')}`, body: 'walk',
    });
    const id = sent.body.id;
    for (const to of ['read', 'in_progress', 'completed']) {
      await request(app).post('/api/federation/status').send({ id, to, by: 'backend' });
    }
    return id;
  }

  it('records a completed task as a golden path and lists it', async () => {
    const id = await completedTask();
    const rec = await request(app).post('/api/eval/golden').send({ message_id: id, name: 'backend-task-happy' });
    expect(rec.status).toBe(200);
    expect(rec.body.trajectory).toEqual(['read', 'in_progress', 'completed']);

    const list = await request(app).get('/api/eval/golden');
    expect(list.body.golden_paths).toContain('backend-task-happy');

    const one = await request(app).get('/api/eval/golden/backend-task-happy');
    expect(one.body.golden.recorded_from).toBe(id);
  });

  it('refuses to record a golden path from a message with no walked lifecycle', async () => {
    const sent = await request(app).post('/api/federation/send').send({
      from_island: 'spaceos', from_terminal: 'root', to_island: 'cabinet', to_terminal: 'backend',
      type: 'task', priority: 'low', subject: 'untouched', body: 'x',
    });
    const rec = await request(app).post('/api/eval/golden').send({ message_id: sent.body.id, name: 'nope' });
    expect(rec.status).toBe(422);
    expect(rec.body.error).toContain('no status_history');
  });

  it('compare: a perfect run scores 1.0; a deviating run gets named deviations', async () => {
    // golden already recorded above; perfect run:
    const good = await completedTask();
    const cmpGood = await request(app).post('/api/eval/compare').send({ message_id: good, golden: 'backend-task-happy' });
    expect(cmpGood.status).toBe(200);
    expect(cmpGood.body.score).toBe(1);

    // deviating run: skips in_progress (read → completed)
    const sent = await request(app).post('/api/federation/send').send({
      from_island: 'spaceos', from_terminal: 'root', to_island: 'cabinet', to_terminal: 'backend',
      type: 'task', priority: 'high', subject: 'deviant run', body: 'skip a step',
    });
    const dev = sent.body.id;
    await request(app).post('/api/federation/status').send({ id: dev, to: 'read', by: 'backend' });
    await request(app).post('/api/federation/status').send({ id: dev, to: 'completed', by: 'backend' });

    const cmpDev = await request(app).post('/api/eval/compare').send({ message_id: dev, golden: 'backend-task-happy' });
    expect(cmpDev.body.score).toBeLessThan(1);
    expect(cmpDev.body.deviations).toEqual([{ kind: 'missing', index: 1, expected: 'in_progress' }]);
  });
});

describe('golden path bulk import (legacy-data migration)', () => {
  it('imports valid migrated golden paths and rejects malformed ones per-item', async () => {
    const res = await request(app).post('/api/eval/golden/import').send({
      golden_paths: [
        { // valid: canonical trajectory + richer fields for the future execution layer
          name: 'legacy-backend-feature',
          type: 'task', from_terminal: 'root', to_terminal: 'backend',
          trajectory: ['read', 'in_progress', 'completed'],
          source: 'migrated', sample_count: 219,
          semantic_steps: ['task_received', 'tests_run', 'implementation', 'tests_passed', 'done_written'],
          expected_deliverables: ['*.ts files', 'tests passing', 'security review'],
        },
        { name: 'bad-noncanonical', type: 'task', trajectory: ['task_received', 'done_written'] },
        { name: 'bad-empty', type: 'task', trajectory: [] },
        { type: 'task', trajectory: ['read', 'completed'] }, // missing name
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual(['legacy-backend-feature']);
    expect(res.body.rejected).toHaveLength(3);
    expect(res.body.rejected.find((r: any) => r.name === 'bad-noncanonical').reason).toContain('non-canonical');

    // the imported golden carries the richer fields and is usable in compare
    const one = await request(app).get('/api/eval/golden/legacy-backend-feature');
    expect(one.body.golden.source).toBe('migrated');
    expect(one.body.golden.sample_count).toBe(219);
    expect(one.body.golden.expected_deliverables).toContain('security review');
  });
});
