/**
 * Real token → terminal/island completion isolation.
 *
 * Unlike the mailbox route fixture, this suite uses authenticateMcp and
 * authenticateRest with an actual agents.yaml mapping. It proves that island
 * rotation cannot complete a claim created under another authenticated scope.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const fixture = vi.hoisted(() => {
  const hoistedPath = require('node:path') as typeof import('node:path');
  const hoistedOs = require('node:os') as typeof import('node:os');
  const hoistedCrypto = require('node:crypto') as typeof import('node:crypto');
  const root = hoistedPath.join(
    hoistedOs.tmpdir(),
    `completion-auth-${hoistedCrypto.randomBytes(6).toString('hex')}`,
  );
  process.env.SPACEOS_ROOT = root;
  process.env.DATA_DIR = hoistedPath.join(root, 'data');
  process.env.TERMINALS_PATH = hoistedPath.join(root, 'terminals');
  process.env.AGENTS_CONFIG_PATH = hoistedPath.join(root, 'agents.yaml');
  process.env.AUTH_MODE = 'required';
  delete process.env.MCP_AUTH_TOKEN;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MCP_TOKEN_')) delete process.env[key];
  }
  return {
    root,
    agents: process.env.AGENTS_CONFIG_PATH,
    terminals: process.env.TERMINALS_PATH,
  };
});

import express from 'express';
import supertest from 'supertest';
import mcpRouter from '../../mcp';
import mailboxRoutes from '../../interfaces/http/routes/mailbox.routes';
import {
  authenticateRest,
  loadAgentTokens,
  resetAuthStateForTests,
  setAuthMode,
} from '../../auth/tokenAuth';
import {
  getTerminalContext,
  listRunnerCompletionReceipts,
  setTerminalContext,
} from '../../pipeline/epicRouter';

const TERMINAL_TOKEN = 'conductor-token-for-completion-auth';
const ROOT_TOKEN = 'root-token-for-completion-auth';
const MESSAGE_ID = 'MSG-CONDUCTOR-AUTH-1';
let app: express.Express;

function configureIsland(islandId: string): void {
  fs.mkdirSync(path.dirname(fixture.agents), { recursive: true });
  fs.writeFileSync(fixture.agents, [
    `master_token: "${ROOT_TOKEN}"`,
    'agents:',
    `  "${TERMINAL_TOKEN}": conductor`,
    'agent_islands:',
    `  conductor: ${islandId}`,
    '  root: root-island',
    `default_island: ${islandId}`,
    '',
  ].join('\n'), 'utf-8');
  resetAuthStateForTests();
  setAuthMode('required');
  loadAgentTokens();
}

async function callComplete(token: string): Promise<Record<string, unknown>> {
  const response = await supertest(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .send({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'complete_task',
        arguments: { terminal: 'conductor', message_id: MESSAGE_ID },
      },
      id: 1,
  });
  expect(response.status).toBe(200);
  const text = String(response.body.result.content[0].text);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text };
  }
}

beforeAll(() => {
  const inbox = path.join(fixture.terminals, 'conductor', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'auth-task.md'), [
    '---',
    `id: ${MESSAGE_ID}`,
    'from: root',
    'to: conductor',
    'type: task',
    'priority: high',
    'status: UNREAD',
    'created: 2026-07-22',
    '---',
    '',
    '# Auth-scoped completion task',
  ].join('\n'), 'utf-8');

  configureIsland('island-a');
  setTerminalContext('conductor', null, null, null, 'idle');

  app = express();
  app.use(express.json());
  app.use('/mcp', mcpRouter);
  app.use('/api/mailbox', authenticateRest, mailboxRoutes);
});

afterAll(() => {
  resetAuthStateForTests();
  try { fs.rmSync(fixture.root, { recursive: true, force: true }); } catch { /* SQLite may be open */ }
});

describe('authenticated completion ownership', () => {
  it('rejects root override and island rotation, then completes in the claimed scope', async () => {
    const claim = await supertest(app)
      .post(`/api/mailbox/conductor/inbox/${MESSAGE_ID}/claim`)
      .set('Authorization', `Bearer ${TERMINAL_TOKEN}`);
    expect(claim.status).toBe(200);
    expect(getTerminalContext('conductor')).toMatchObject({
      current_task_id: MESSAGE_ID,
      current_island_id: 'island-a',
      status: 'working',
    });

    const rootAttempt = await callComplete(ROOT_TOKEN);
    expect(rootAttempt.error).toContain('cannot complete tasks for terminal conductor');

    configureIsland('island-b');
    const rotatedAttempt = await callComplete(TERMINAL_TOKEN);
    expect(rotatedAttempt.error).toContain('claimed island does not match caller');
    expect(getTerminalContext('conductor')).toMatchObject({
      current_task_id: MESSAGE_ID,
      current_island_id: 'island-a',
      status: 'working',
    });
    expect(listRunnerCompletionReceipts('island-a', 'conductor', 0).receipts).toHaveLength(0);
    expect(listRunnerCompletionReceipts('island-b', 'conductor', 0).receipts).toHaveLength(0);

    const wrongScopeRead = await supertest(app)
      .get('/api/mailbox/conductor/completions')
      .set('Authorization', `Bearer ${TERMINAL_TOKEN}`);
    expect(wrongScopeRead.status).toBe(200);
    expect(wrongScopeRead.body).toMatchObject({ islandId: 'island-b', count: 0 });

    configureIsland('island-a');
    const completed = await callComplete(TERMINAL_TOKEN);
    expect(completed).toMatchObject({ success: true, completed: true, idempotent: false });

    const read = await supertest(app)
      .get('/api/mailbox/conductor/completions')
      .set('Authorization', `Bearer ${TERMINAL_TOKEN}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ islandId: 'island-a', count: 1 });
    expect(read.body.receipts[0]).toMatchObject({
      islandId: 'island-a', terminalId: 'conductor', messageId: MESSAGE_ID,
    });
  });
});
