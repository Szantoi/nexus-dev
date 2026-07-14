/**
 * Workflow-model tests: the config-declared expected lifecycle per message type,
 * and the /api/eval/conformance endpoint that scores actual trajectories against it.
 * These tests PIN the declared expectations — changing workflows.yaml intentionally
 * should be reflected here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

const runId = crypto.randomBytes(6).toString('hex');
process.env.DATA_DIR = path.join(os.tmpdir(), `wf-data-${runId}`);
process.env.TERMINALS_PATH = path.join(os.tmpdir(), `wf-terminals-${runId}`);
process.env.AGENTS_CONFIG_PATH = path.join(os.tmpdir(), `no-agents-${runId}.yaml`); // dev-mode auth
delete process.env.MCP_AUTH_TOKEN;

import { expectedTrajectory, maxHoursIn, getWorkflow } from '../eval/workflowModel';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any, app: any;

beforeAll(async () => {
  const express = (await import('express')).default;
  const supertest = (await import('supertest')).default;
  const store = await import('../task-message-box/store');
  await store.initDatabase();
  const { createFederationApiRouter } = await import('../interfaces/http/routes/federation.routes');
  const { createEvalApiRouter } = await import('../interfaces/http/routes/eval.routes');
  const server = express();
  server.use(express.json());
  server.use('/api/federation', createFederationApiRouter());
  server.use('/api/eval', createEvalApiRouter());
  app = server; request = supertest;
});

describe('workflow definitions (from config/workflows.yaml)', () => {
  it('declares the task lifecycle: read → in_progress → completed', () => {
    expect(expectedTrajectory('task')).toEqual(['read', 'in_progress', 'completed']);
  });

  it('declares lighter lifecycles for question/info', () => {
    expect(expectedTrajectory('question')).toEqual(['read', 'completed']);
    expect(expectedTrajectory('info')).toEqual(['read', 'completed']);
  });

  it('exposes config-driven stuck thresholds', () => {
    expect(maxHoursIn('task', 'unread')).toBe(24);
    expect(maxHoursIn('task', 'in_progress')).toBe(72);
    expect(maxHoursIn('info', 'read')).toBeUndefined(); // not declared → no limit
  });

  it('falls back to default_workflow for an unknown type (never throws)', () => {
    const wf = getWorkflow('nonexistent-type');
    expect(wf.expected_trajectory).toEqual(['read', 'completed']);
  });
});

describe('POST /api/eval/conformance (actual vs declared workflow)', () => {
  async function taskWalked(steps: string[]): Promise<string> {
    const sent = await request(app).post('/api/federation/send').send({
      from_island: 'cabinet', from_terminal: 'root', to_island: 'cabinet', to_terminal: 'backend',
      type: 'task', priority: 'high', subject: `wf ${crypto.randomBytes(3).toString('hex')}`, body: 'x',
    });
    for (const to of steps) {
      await request(app).post('/api/federation/status').send({ id: sent.body.id, to, by: 'backend' });
    }
    return sent.body.id;
  }

  it('a task walked per the declared workflow scores 1.0', async () => {
    const id = await taskWalked(['read', 'in_progress', 'completed']);
    const r = await request(app).post('/api/eval/conformance').send({ message_id: id });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('task');
    expect(r.body.workflow).toEqual(['read', 'in_progress', 'completed']);
    expect(r.body.score).toBe(1);
  });

  it('a task that skipped in_progress gets the deviation named', async () => {
    const id = await taskWalked(['read', 'completed']);
    const r = await request(app).post('/api/eval/conformance').send({ message_id: id });
    expect(r.body.score).toBeLessThan(1);
    expect(r.body.deviations).toEqual([{ kind: 'missing', index: 1, expected: 'in_progress' }]);
  });

  it('404 for an unknown message', async () => {
    const r = await request(app).post('/api/eval/conformance').send({ message_id: 'MSG-NOPE-1' });
    expect(r.status).toBe(404);
  });
});
