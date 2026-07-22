/**
 * mailbox.routes integration tests — hermetic, temp TERMINALS_PATH tree.
 *
 * PINS the mailbox REST contract (router mounted directly with a stub
 * identity middleware; auth is covered elsewhere — this file is route logic):
 *  - GET  /:terminal/inbox|outbox — list with status filter, terminal-name
 *    validation (zod TerminalParamSchema -> 400 with details)
 *  - POST /:terminal/inbox — send: required-field 400, MSG id sequencing,
 *    frontmatter + body written to disk
 *  - POST /:terminal/outbox — submit DONE: required-field 400, file created,
 *    immediate pipeline triggered (mocked — real one execs child processes)
 *  - GET  /outbox/unread, /counter — fleet-wide aggregation
 *  - POST /:terminal/:box/:messageId/read — mark READ, 404 when absent,
 *    400 on bad box
 *  - POST /broadcast — 400 without message, sentTo = SSE client count
 *  - GET  /tasks/status — docs/tasks tree with optional task_id filter
 *  - SSE  /:terminal/subscribe — invalid terminal 400; live connect smoke
 *    (connected event, client counted, cleanup on disconnect); teardown via
 *    closeAllSSEConnections so no open handles survive the run
 *
 * TERMINALS_PATH is read from env at import time by config/paths, so env is
 * set at module top level BEFORE the dynamic imports in beforeAll.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';

const runId = crypto.randomBytes(6).toString('hex');
const ROOT = path.join(os.tmpdir(), `mbx-root-${runId}`);
process.env.SPACEOS_ROOT = ROOT;
process.env.TERMINALS_PATH = path.join(ROOT, 'terminals');
process.env.DATA_DIR = path.join(ROOT, 'data');

// The real immediate pipeline runs reviews and execs tmux/child processes on
// DONE submissions — stub it out; we only pin that the route triggers it.
vi.mock('../../pipeline/immediatePipeline', () => ({
  triggerImmediatePipelineAsync: vi.fn(),
}));

const TERMINALS = path.join(ROOT, 'terminals');

let request: typeof import('supertest').default;
let app: import('express').Express;
let routes: typeof import('../../interfaces/http/routes/mailbox.routes');
let epicRouter: typeof import('../../pipeline/epicRouter');
let triggerMock: ReturnType<typeof vi.fn>;
let liveServer: http.Server | null = null;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

function message(id: string, status: 'UNREAD' | 'READ', body: string): string {
  return [
    '---',
    `id: ${id}`,
    'from: conductor',
    'to: root',
    'type: task',
    'priority: high',
    `status: ${status}`,
    'created: 2026-07-18',
    '---',
    '',
    body,
  ].join('\n');
}

beforeAll(async () => {
  write(path.join(TERMINALS, 'root', 'inbox', '2026-07-18_001_first.md'),
    message('MSG-ROOT-001', 'UNREAD', '# First task\n\nfirst body text'));
  write(path.join(TERMINALS, 'root', 'inbox', '2026-07-18_002_second.md'),
    message('MSG-ROOT-002', 'READ', '# Second task\n\nsecond body text'));
  write(path.join(TERMINALS, 'root', 'inbox', 'notes.txt'), 'non-md files are ignored');
  fs.mkdirSync(path.join(TERMINALS, 'root', 'outbox'), { recursive: true });
  write(path.join(TERMINALS, 'backend', 'outbox', '2026-07-18_001_done.md'),
    message('MSG-BACKEND-001-DONE', 'UNREAD', '# Done report\n\nshipped'));
  write(path.join(TERMINALS, 'README.md'), 'stray file in terminals root, must be skipped by scans');

  // TASKS_ROOT = dirname(TERMINALS_PATH)/docs/tasks
  write(path.join(ROOT, 'docs', 'tasks', 'new', 'task1.md'), [
    '---',
    'id: MSG-BACKEND-042',
    'title: "Implement the widget"',
    'priority: high',
    'assignee: backend',
    'created: 2026-07-01',
    '---',
    '',
    '# Implement the widget',
  ].join('\n'));

  const express = (await import('express')).default;
  const supertest = (await import('supertest')).default;
  routes = await import('../../interfaces/http/routes/mailbox.routes');
  epicRouter = await import('../../pipeline/epicRouter');
  const pipeline = await import('../../pipeline/immediatePipeline');
  triggerMock = pipeline.triggerImmediatePipelineAsync as unknown as ReturnType<typeof vi.fn>;

  const server = express();
  server.use(express.json());
  // Stub identity middleware in place of authenticateRest + authorizeMailboxRest
  server.use('/api/mailbox', (req, _res, next) => {
    const terminal = req.headers['x-test-terminal'];
    const island = req.headers['x-test-island'];
    req.mcpTerminal = typeof terminal === 'string' ? terminal : 'root';
    req.mcpIsland = typeof island === 'string' ? island : 'island-a';
    next();
  }, routes.default);
  app = server;
  request = supertest;
});

afterAll(async () => {
  routes.closeAllSSEConnections();
  if (liveServer) {
    liveServer.closeAllConnections?.();
    await new Promise<void>(resolve => liveServer!.close(() => resolve()));
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* sqlite may hold locks */ }
});

// ─── Inbox listing ──────────────────────────────────────────────────────────

describe('GET /:terminal/inbox', () => {
  it('lists all messages with parsed frontmatter and content', async () => {
    const res = await request(app).get('/api/mailbox/root/inbox');
    expect(res.status).toBe(200);
    expect(res.body.terminal).toBe('root');
    expect(res.body.status).toBe('all');
    expect(res.body.count).toBe(2); // notes.txt ignored

    interface Listed { frontmatter: Record<string, string>; content: string; filePath: string }
    const messages = res.body.messages as Listed[];
    const first = messages.find(m => m.frontmatter.id === 'MSG-ROOT-001')!;
    expect(first.frontmatter).toMatchObject({ from: 'conductor', type: 'task', priority: 'high', status: 'UNREAD' });
    expect(first.content).toContain('first body text');
    expect(first.filePath).toContain('2026-07-18_001_first.md');
  });

  it('filters by status; unknown status values degrade to all', async () => {
    const unread = await request(app).get('/api/mailbox/root/inbox?status=UNREAD');
    expect(unread.body.count).toBe(1);
    expect(unread.body.messages[0].frontmatter.id).toBe('MSG-ROOT-001');

    const bogus = await request(app).get('/api/mailbox/root/inbox?status=SHINY');
    expect(bogus.body.status).toBe('all');
    expect(bogus.body.count).toBe(2);
  });

  it('returns frontmatter-only records for runner metadata polling', async () => {
    const res = await request(app).get('/api/mailbox/root/inbox?status=UNREAD&metadata=true');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.messages[0].frontmatter.id).toBe('MSG-ROOT-001');
    expect(res.body.messages[0].content).toBeUndefined();
  });

  it('rejects an unknown terminal name with a zod validation error', async () => {
    const res = await request(app).get('/api/mailbox/definitely-not-real/inbox');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details[0].path).toBe('terminal');
  });

  it('accepts an alias, but the handler uses the RAW name for the mailbox path', async () => {
    // "dragon" is an alias of root in config/terminals.yaml. Validation passes,
    // yet listInbox receives the raw "dragon" -> empty (no terminals/dragon dir).
    const res = await request(app).get('/api/mailbox/dragon/inbox');
    expect(res.status).toBe(200);
    expect(res.body.terminal).toBe('dragon');
    expect(res.body.count).toBe(0);
  });
});

// ─── Send message ───────────────────────────────────────────────────────────

describe('runner claim lifecycle', () => {
  it('claims only an unread task and releases only the matching context', async () => {
    const claimed = await request(app).post('/api/mailbox/root/inbox/MSG-ROOT-001/claim');
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ success: true, terminal: 'root', messageId: 'MSG-ROOT-001' });
    expect(epicRouter.getTerminalContext('root')?.current_island_id).toBe('island-a');

    const wrongIslandClaim = await request(app)
      .post('/api/mailbox/root/inbox/MSG-ROOT-001/claim')
      .set('x-test-island', 'island-b');
    expect(wrongIslandClaim.status).toBe(409);

    const conflicting = await request(app).post('/api/mailbox/root/inbox/MSG-ROOT-002/claim');
    expect(conflicting.status).toBe(409);

    const wrongIslandRelease = await request(app)
      .post('/api/mailbox/root/inbox/MSG-ROOT-001/release')
      .set('x-test-island', 'island-b');
    expect(wrongIslandRelease.status).toBe(409);

    const released = await request(app).post('/api/mailbox/root/inbox/MSG-ROOT-001/release');
    expect(released.status).toBe(200);
    const releasedAgain = await request(app).post('/api/mailbox/root/inbox/MSG-ROOT-001/release');
    expect(releasedAgain.status).toBe(409);
  });
});

describe('durable runner completion feed', () => {
  it('is island/terminal scoped, cursor paginated, and rejects foreign readers', async () => {
    epicRouter.setTerminalContext(
      'backend', null, null, 'MSG-RECEIPT-1', 'working', 0, 'island-a',
    );
    epicRouter.handleTaskCompletion('backend', 'MSG-RECEIPT-1', null, {
      islandId: 'island-a', source: 'mcp_complete_task',
    });
    epicRouter.setTerminalContext(
      'backend', null, null, 'MSG-RECEIPT-FOREIGN', 'working', 0, 'island-b',
    );
    epicRouter.handleTaskCompletion('backend', 'MSG-RECEIPT-FOREIGN', null, {
      islandId: 'island-b', source: 'mcp_complete_task',
    });
    epicRouter.setTerminalContext(
      'backend', null, null, 'MSG-RECEIPT-2', 'working', 0, 'island-a',
    );
    epicRouter.handleTaskCompletion('backend', 'MSG-RECEIPT-2', null, {
      islandId: 'island-a', source: 'mcp_complete_task',
    });

    const first = await request(app)
      .get('/api/mailbox/backend/completions?after=0&limit=1')
      .set('x-test-terminal', 'backend')
      .set('x-test-island', 'island-a');
    expect(first.status).toBe(200);
    expect(first.body.islandId).toBe('island-a');
    expect(first.body.count).toBe(1);
    expect(first.body.receipts[0]).toMatchObject({
      terminalId: 'backend', messageId: 'MSG-RECEIPT-1', source: 'mcp_complete_task',
    });
    expect(first.body.hasMore).toBe(true);

    const second = await request(app)
      .get(`/api/mailbox/backend/completions?after=${first.body.nextCursor}&limit=10`)
      .set('x-test-terminal', 'backend')
      .set('x-test-island', 'island-a');
    expect(second.status).toBe(200);
    expect(second.body.receipts.map((receipt: { messageId: string }) => receipt.messageId))
      .toEqual(['MSG-RECEIPT-2']);
    expect(second.body.hasMore).toBe(false);

    const foreign = await request(app)
      .get('/api/mailbox/backend/completions')
      .set('x-test-terminal', 'frontend')
      .set('x-test-island', 'island-a');
    expect(foreign.status).toBe(403);

    const malformed = await request(app)
      .get('/api/mailbox/backend/completions?after=-1')
      .set('x-test-terminal', 'backend')
      .set('x-test-island', 'island-a');
    expect(malformed.status).toBe(400);
  });
});

describe('POST /:terminal/inbox', () => {
  it('400 when type/content/priority are missing', async () => {
    const res = await request(app).post('/api/mailbox/conductor/inbox').send({ type: 'task' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('type, content, and priority are required');
  });

  it('writes the message file with sequenced MSG id and frontmatter', async () => {
    const res = await request(app).post('/api/mailbox/conductor/inbox').send({
      type: 'task',
      content: '# Fix the pipeline\n\ndetailed instructions',
      priority: 'high',
      ref: 'MSG-ROOT-001',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toBe('MSG-CONDUCTOR-001');
    expect(fs.existsSync(res.body.path)).toBe(true);

    const raw = fs.readFileSync(res.body.path, 'utf-8');
    expect(raw).toContain('id: MSG-CONDUCTOR-001');
    expect(raw).toContain('to: conductor');
    expect(raw).toContain('status: UNREAD');
    expect(raw).toContain('ref: MSG-ROOT-001');
    expect(raw).toContain('detailed instructions');
    expect(path.basename(res.body.path)).toContain('fix-the-pipeline'); // slug from H1

    const second = await request(app).post('/api/mailbox/conductor/inbox').send({
      type: 'question', content: 'plain question without heading', priority: 'low',
    });
    expect(second.body.id).toBe('MSG-CONDUCTOR-002'); // sequence advances
  });
});

// ─── Submit DONE ────────────────────────────────────────────────────────────

describe('POST /:terminal/outbox', () => {
  it('400 when task_id/summary/files_changed are missing', async () => {
    const res = await request(app).post('/api/mailbox/backend/outbox').send({ task_id: 'MSG-BACKEND-010' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('task_id, summary, and files_changed are required');
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it('writes the DONE file and triggers the immediate pipeline', async () => {
    const res = await request(app).post('/api/mailbox/backend/outbox').send({
      task_id: 'MSG-BACKEND-010',
      summary: 'Implemented the widget end to end',
      files_changed: ['src/widget.ts', 'src/widget.test.ts'],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toMatch(/^MSG-BACKEND-\d{3}-DONE$/);
    expect(fs.existsSync(res.body.path)).toBe(true);

    const raw = fs.readFileSync(res.body.path, 'utf-8');
    expect(raw).toContain('type: done');
    expect(raw).toContain('ref: MSG-BACKEND-010');
    expect(raw).toContain('## Files Changed');
    expect(raw).toContain('- src/widget.ts');

    expect(triggerMock).toHaveBeenCalledTimes(1);
    expect(triggerMock).toHaveBeenCalledWith(res.body.path, {
      from: 'backend',
      taskId: 'MSG-BACKEND-010',
      summary: 'Implemented the widget end to end',
    });
  });
});

// ─── Outbox listing + fleet aggregation ─────────────────────────────────────

describe('outbox listing and aggregation', () => {
  it('GET /:terminal/outbox lists messages (fixture + submitted DONE)', async () => {
    const res = await request(app).get('/api/mailbox/backend/outbox');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const messages = res.body.messages as Array<{ frontmatter: { id: string } }>;
    expect(messages.map(m => m.frontmatter.id)).toContain('MSG-BACKEND-001-DONE');
  });

  it('GET /outbox/unread aggregates UNREAD outbox across terminals', async () => {
    const res = await request(app).get('/api/mailbox/outbox/unread');
    expect(res.status).toBe(200);
    const results = res.body.results as Array<{ terminal: string; messages: unknown[] }>;
    const backend = results.find(r => r.terminal === 'backend')!;
    expect(backend).toBeTruthy();
    expect(backend.messages.length).toBe(2); // fixture + submitted, both UNREAD
    // root outbox is empty -> not listed
    expect(results.find(r => r.terminal === 'root')).toBeUndefined();
    expect(res.body.totalCount).toBe(
      results.reduce((sum, r) => sum + r.messages.length, 0)
    );
  });

  it('GET /counter reports unread/total per terminal', async () => {
    const res = await request(app).get('/api/mailbox/counter');
    expect(res.status).toBe(200);
    expect(res.body.terminals.root).toEqual({ unread: 1, total: 2 });
    expect(res.body.terminals.conductor).toEqual({ unread: 2, total: 2 }); // sent above
    expect(res.body.terminals.backend).toEqual({ unread: 0, total: 0 }); // no inbox dir
    expect(res.body.totalUnread).toBe(3);
    expect(res.body.totalMessages).toBe(4);
  });
});

// ─── Mark as READ ───────────────────────────────────────────────────────────

describe('POST /:terminal/:box/:messageId/read', () => {
  it('400 on an invalid box name', async () => {
    const res = await request(app).post('/api/mailbox/root/trash/MSG-ROOT-001/read');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('box must be "inbox" or "outbox"');
  });

  it('marks an UNREAD message READ once, then 404s', async () => {
    const ok = await request(app).post('/api/mailbox/root/inbox/MSG-ROOT-001/read');
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);

    const raw = fs.readFileSync(path.join(TERMINALS, 'root', 'inbox', '2026-07-18_001_first.md'), 'utf-8');
    expect(raw).toContain('status: READ');

    const again = await request(app).post('/api/mailbox/root/inbox/MSG-ROOT-001/read');
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('Message not found or already READ');
  });
});

// ─── Tasks status ───────────────────────────────────────────────────────────

describe('GET /tasks/status', () => {
  it('lists tasks from docs/tasks with frontmatter fields', async () => {
    const res = await request(app).get('/api/mailbox/tasks/status');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.tasks[0]).toMatchObject({
      id: 'MSG-BACKEND-042',
      title: 'Implement the widget',
      status: 'new',
      priority: 'high',
      assignee: 'backend',
    });
  });

  it('filters by task_id', async () => {
    const hit = await request(app).get('/api/mailbox/tasks/status?task_id=MSG-BACKEND-042');
    expect(hit.body.count).toBe(1);
    const miss = await request(app).get('/api/mailbox/tasks/status?task_id=MSG-NOPE-999');
    expect(miss.body.count).toBe(0);
  });
});

// ─── Broadcast + SSE ────────────────────────────────────────────────────────

describe('broadcast and SSE', () => {
  it('POST /broadcast requires a message', async () => {
    const res = await request(app).post('/api/mailbox/broadcast').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('message is required');
  });

  it('broadcast with no subscribers reports sentTo 0', async () => {
    const res = await request(app).post('/api/mailbox/broadcast').send({ message: 'hello fleet' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, sentTo: 0 });
    expect(routes.getSSEClientCount()).toBe(0);
  });

  it('subscribe rejects an invalid terminal before opening a stream', async () => {
    const res = await request(app).get('/api/mailbox/no-such-terminal/subscribe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid terminal name');
  });

  it('SSE connect smoke: connected event, client counted, broadcast delivered, cleanup on disconnect', async () => {
    liveServer = http.createServer(app);
    await new Promise<void>(resolve => liveServer!.listen(0, '127.0.0.1', resolve));
    const port = (liveServer!.address() as { port: number }).port;

    const received: string[] = [];
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/mailbox/root/subscribe' },
      res => { res.on('data', (chunk: Buffer) => received.push(chunk.toString('utf-8'))); }
    );

    // Wait for the initial connected event
    await vi.waitFor(() => {
      expect(received.join('')).toContain('event: connected');
    }, { timeout: 5000 });

    expect(routes.getSSEClientCount('root')).toBe(1);
    expect(routes.getSSEClientCount('all')).toBe(1); // same client, broadcast set
    expect(routes.getSSEClientCount()).toBe(2); // total across both sets

    // Broadcast reaches the live subscriber
    const b = await request(app).post('/api/mailbox/broadcast').send({ message: 'ping' });
    expect(b.body.sentTo).toBe(1);
    await vi.waitFor(() => {
      expect(received.join('')).toContain('event: broadcast');
      expect(received.join('')).toContain('ping');
    }, { timeout: 5000 });

    // Disconnect -> req close handler removes the client from both sets
    req.destroy();
    await vi.waitFor(() => {
      expect(routes.getSSEClientCount()).toBe(0);
    }, { timeout: 5000 });
  });
});
