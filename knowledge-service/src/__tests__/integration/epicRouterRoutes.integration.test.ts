/**
 * Epic-router HTTP API + pipeline/epicRouter integration tests — hermetic.
 *
 * PINS the contract:
 *  - terminal-token authorization matrix on /routing, /dispatch, /task/:t/complete,
 *    /fetch and /ack: server-derived identity (root or own terminal) passes,
 *    foreign identity is 403, anonymous access requires a derived
 *    SHA256(secret + terminal)[:32] Bearer token (503 unconfigured / 401 missing /
 *    403 wrong), and /token/:terminal is a root+admin-secret-gated provisioning
 *    endpoint;
 *  - epic-aware routing: same-epic tasks first, then priority-ordered epic
 *    switching, wait while working, stop on empty queue;
 *  - /fetch and /ack only serve the task currently assigned to the terminal and
 *    read/patch the markdown mailbox on disk;
 *  - the MCP helper functions (fetchTaskForMcp/ackTaskForMcp/completeTaskForMcp)
 *    follow the same assignment rules; a continuous-mode terminal never gets a
 *    cold-session termination;
 *  - POST /sync ingests projects and epics from an EPICS.yaml file.
 *
 * Everything (SQLite DB, terminals tree, EPICS.yaml, logs) lives under
 * os.tmpdir(); env overrides are applied BEFORE any src import because
 * config/paths.ts and pipeline/epicRouter.ts read process.env at import.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ─── Hermetic environment (must precede any src import) ──────────────────────

const runId = crypto.randomBytes(6).toString('hex');
const ROOT = path.join(os.tmpdir(), `epicrt-${runId}`);
const TERMINALS = path.join(ROOT, 'terminals');
const EPICS = path.join(ROOT, 'EPICS.yaml');

process.env.SPACEOS_ROOT = ROOT;
process.env.DATA_DIR = path.join(ROOT, 'data');
process.env.TERMINALS_PATH = TERMINALS;
process.env.EPICS_PATH = EPICS;
process.env.AGENTS_CONFIG_PATH = path.join(ROOT, `no-agents-${runId}.yaml`);
process.env.AUTH_MODE = 'open';
delete process.env.MCP_AUTH_TOKEN;
delete process.env.TERMINAL_TOKEN_SECRET;
delete process.env.ADMIN_SECRET;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MCP_TOKEN_')) delete process.env[key];
}

let request: typeof import('supertest').default;
let app: import('express').Express;
type EpicRouterModule = typeof import('../../pipeline/epicRouter');
type RoutesModule = typeof import('../../interfaces/http/routes/epic-router.routes');
let epicRouter: EpicRouterModule;
let routes: RoutesModule;

/** Same derivation the router uses: SHA256(secret + terminal)[:32]. */
function deriveToken(secret: string, terminal: string): string {
  return crypto.createHash('sha256').update(secret + terminal).digest('hex').slice(0, 32);
}

function writeInboxMessage(terminal: string, filename: string, content: string): string {
  const inbox = path.join(TERMINALS, terminal, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, filename);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

beforeAll(async () => {
  fs.mkdirSync(path.join(TERMINALS, 'explorer', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(TERMINALS, 'conductor', 'inbox'), { recursive: true });

  const express = (await import('express')).default;
  request = (await import('supertest')).default;
  routes = await import('../../interfaces/http/routes/epic-router.routes');
  epicRouter = await import('../../pipeline/epicRouter');

  // better-sqlite3 enforces foreign keys: task_queue.epic_id/project_id and
  // terminal_context reference the epics/projects tables, so seed them first
  // (in production the EPICS.yaml sync does this before any task is queued).
  epicRouter.createProject({ id: 'proj-a', name: 'Project A', status: 'active' });
  for (const id of ['EPIC-ALPHA', 'EPIC-BETA', 'EPIC-F', 'EPIC-CP']) {
    epicRouter.createEpic({ id, project_id: 'proj-a', name: id, status: 'active', priority: 2 });
  }

  // Secrets are read lazily (config/env.ts secrets accessor); make sure the
  // suite starts from the unconfigured state even if the shell had them set.
  delete process.env.TERMINAL_TOKEN_SECRET;
  delete process.env.ADMIN_SECRET;

  const server = express();
  server.use(express.json());
  // Simulate an upstream-authenticated identity (what apiAuthGate would set).
  server.use((req, _res, next) => {
    const identity = req.headers['x-test-identity'];
    if (typeof identity === 'string' && identity) req.mcpTerminal = identity;
    next();
  });
  server.use('/api/epic-router', routes.default);
  app = server;
});

afterAll(() => {
  epicRouter.closeDatabase();
});

// ─── Terminal status + queue management ──────────────────────────────────────

describe('terminal status and queue endpoints', () => {
  it('GET /terminals lists the auto-initialized terminal contexts', async () => {
    const res = await request(app).get('/api/epic-router/terminals');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBeGreaterThanOrEqual(9);
    const conductor = res.body.terminals.find(
      (t: { terminal: string; status: string; queue_size: number }) => t.terminal === 'conductor'
    );
    expect(conductor).toBeTruthy();
    expect(conductor.status).toBe('idle');
    expect(conductor.queue_size).toBe(0);
  });

  it('GET /terminals/:terminal returns one context, 404 for unknown', async () => {
    const ok = await request(app).get('/api/epic-router/terminals/explorer');
    expect(ok.status).toBe(200);
    expect(ok.body.terminal.terminal).toBe('explorer');

    const missing = await request(app).get('/api/epic-router/terminals/no-such-terminal');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ success: false, error: 'Terminal no-such-terminal not found' });
  });

  it('POST /queue validates messageId and terminal', async () => {
    const res = await request(app).post('/api/epic-router/queue').send({ terminal: 'explorer' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'messageId and terminal are required' });
  });

  it('POST /queue enqueues tasks and GET /queue reports statistics', async () => {
    for (const [messageId, epicId, priority] of [
      ['MSG-EX-MED', 'EPIC-ALPHA', 'medium'],
      ['MSG-EX-HIGH', 'EPIC-ALPHA', 'high'],
      ['MSG-EX-CRIT', 'EPIC-BETA', 'critical'],
    ] as const) {
      const res = await request(app)
        .post('/api/epic-router/queue')
        .send({ messageId, terminal: 'explorer', epicId, projectId: 'proj-a', priority });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe(`Task ${messageId} queued for explorer`);
    }

    const stats = await request(app).get('/api/epic-router/queue');
    expect(stats.status).toBe(200);
    expect(stats.body.totalQueued).toBe(3);
  });

  it('POST /queue surfaces DB errors (duplicate messageId) as 500', async () => {
    const res = await request(app)
      .post('/api/epic-router/queue')
      .send({ messageId: 'MSG-EX-MED', terminal: 'explorer' });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('UNIQUE');
  });

  it('GET /queue/terminal/:terminal orders by priority', async () => {
    const res = await request(app).get('/api/epic-router/queue/terminal/explorer');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.tasks[0].message_id).toBe('MSG-EX-CRIT'); // critical first
  });

  it('GET /queue/epic/:epicId filters by epic', async () => {
    const res = await request(app).get('/api/epic-router/queue/epic/EPIC-ALPHA');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(
      res.body.tasks.map((t: { message_id: string }) => t.message_id).sort()
    ).toEqual(['MSG-EX-HIGH', 'MSG-EX-MED']);
  });
});

// ─── Terminal-token authorization matrix ─────────────────────────────────────

describe('requireTerminalAuth matrix (GET /routing/:terminal)', () => {
  const SECRET = 'unit-terminal-secret'; // secret-scan:allow — non-production test fixture

  it('root identity is authorized for any terminal', async () => {
    const res = await request(app)
      .get('/api/epic-router/routing/explorer')
      .set('x-test-identity', 'root');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.decision.shouldDispatch).toBe(true);
  });

  it('a terminal is authorized for itself', async () => {
    const res = await request(app)
      .get('/api/epic-router/routing/explorer')
      .set('x-test-identity', 'explorer');
    expect(res.status).toBe(200);
    expect(res.body.terminal).toBe('explorer');
  });

  it('a foreign identity is rejected with 403', async () => {
    const res = await request(app)
      .get('/api/epic-router/routing/explorer')
      .set('x-test-identity', 'backend');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Forbidden for terminal explorer' });
  });

  it('anonymous access without a configured secret is 503', async () => {
    const res = await request(app).get('/api/epic-router/routing/explorer');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Terminal token authentication is not configured');
  });

  it('anonymous access with a secret but no Bearer header is 401', async () => {
    process.env.TERMINAL_TOKEN_SECRET = SECRET;
    try {
      const res = await request(app).get('/api/epic-router/routing/explorer');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Bearer <token>');
    } finally {
      delete process.env.TERMINAL_TOKEN_SECRET;
    }
  });

  it('a wrong token is 403', async () => {
    process.env.TERMINAL_TOKEN_SECRET = SECRET;
    try {
      const res = await request(app)
        .get('/api/epic-router/routing/explorer')
        .set('Authorization', 'Bearer definitely-not-the-token');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Invalid token for terminal explorer');
    } finally {
      delete process.env.TERMINAL_TOKEN_SECRET;
    }
  });

  it('a malformed token that breaks buffer comparison is 403 (verification failed)', async () => {
    process.env.TERMINAL_TOKEN_SECRET = SECRET;
    try {
      // 32 JS characters but 33 UTF-8 bytes -> timingSafeEqual throws -> catch branch
      const tricky = `é${'a'.repeat(31)}`;
      const res = await request(app)
        .get('/api/epic-router/routing/explorer')
        .set('Authorization', `Bearer ${tricky}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Token verification failed');
    } finally {
      delete process.env.TERMINAL_TOKEN_SECRET;
    }
  });

  it('the correctly derived token is accepted', async () => {
    process.env.TERMINAL_TOKEN_SECRET = SECRET;
    try {
      const res = await request(app)
        .get('/api/epic-router/routing/explorer')
        .set('Authorization', `Bearer ${deriveToken(SECRET, 'explorer')}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    } finally {
      delete process.env.TERMINAL_TOKEN_SECRET;
    }
  });
});

describe('GET /token/:terminal (admin provisioning)', () => {
  it('is 503 when no admin secret is configured', async () => {
    const res = await request(app).get('/api/epic-router/token/explorer');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Admin token provisioning is not configured');
  });

  it('rejects non-root identities before the admin secret check', async () => {
    const res = await request(app)
      .get('/api/epic-router/token/explorer')
      .set('x-test-identity', 'backend');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden: root access required');
  });

  it('rejects a missing or wrong x-admin-secret with 403', async () => {
    process.env.ADMIN_SECRET = 'the-admin-secret';
    process.env.TERMINAL_TOKEN_SECRET = 'unit-terminal-secret';
    try {
      const missing = await request(app).get('/api/epic-router/token/explorer');
      expect(missing.status).toBe(403);
      expect(missing.body.error).toBe('Admin access required');

      const wrong = await request(app)
        .get('/api/epic-router/token/explorer')
        .set('x-admin-secret', 'nope');
      expect(wrong.status).toBe(403);
    } finally {
      delete process.env.ADMIN_SECRET;
      delete process.env.TERMINAL_TOKEN_SECRET;
    }
  });

  it('returns the derived token for the correct admin secret', async () => {
    process.env.ADMIN_SECRET = 'the-admin-secret';
    process.env.TERMINAL_TOKEN_SECRET = 'unit-terminal-secret';
    try {
      const res = await request(app)
        .get('/api/epic-router/token/explorer')
        .set('x-admin-secret', 'the-admin-secret');
      expect(res.status).toBe(200);
      expect(res.body.terminal).toBe('explorer');
      expect(res.body.token).toBe(deriveToken('unit-terminal-secret', 'explorer'));
      expect(res.body.usage).toContain(res.body.token);
    } finally {
      delete process.env.ADMIN_SECRET;
      delete process.env.TERMINAL_TOKEN_SECRET;
    }
  });
});

// ─── Epic-aware routing flow ─────────────────────────────────────────────────

describe('dispatch/complete routing flow', () => {
  const asRoot = { 'x-test-identity': 'root' };

  it('dispatches the highest-priority task and switches the epic context', async () => {
    const res = await request(app).post('/api/epic-router/dispatch/explorer').set(asRoot);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.task.message_id).toBe('MSG-EX-CRIT');

    const ctx = epicRouter.getTerminalContext('explorer');
    expect(ctx!.status).toBe('working');
    expect(ctx!.current_task_id).toBe('MSG-EX-CRIT');
    expect(ctx!.current_epic_id).toBe('EPIC-BETA');
  });

  it('a working terminal is told to wait', async () => {
    const routing = await request(app)
      .get('/api/epic-router/routing/explorer')
      .set(asRoot);
    expect(routing.body.decision).toMatchObject({
      shouldDispatch: false,
      nextAction: 'wait',
      reason: 'Terminal explorer is working, not idle',
    });

    const dispatch = await request(app).post('/api/epic-router/dispatch/explorer').set(asRoot);
    expect(dispatch.status).toBe(200);
    expect(dispatch.body.success).toBe(false);
    expect(dispatch.body.nextAction).toBe('wait');
  });

  it('POST /task/:terminal/complete requires messageId', async () => {
    const res = await request(app)
      .post('/api/epic-router/task/explorer/complete')
      .set(asRoot)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('messageId is required');
  });

  it('completion returns the next routing decision (epic switch)', async () => {
    const res = await request(app)
      .post('/api/epic-router/task/explorer/complete')
      .set(asRoot)
      .send({ messageId: 'MSG-EX-CRIT', epicId: 'EPIC-BETA' });
    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe('MSG-EX-CRIT');
    expect(res.body.decision.shouldDispatch).toBe(true);
    expect(res.body.decision.task.message_id).toBe('MSG-EX-HIGH');
    expect(res.body.decision.reason).toBe('Switching to new epic (EPIC-ALPHA)');
  });

  it('same-epic tasks are preferred after completion within the epic', async () => {
    const dispatch = await request(app).post('/api/epic-router/dispatch/explorer').set(asRoot);
    expect(dispatch.body.task.message_id).toBe('MSG-EX-HIGH');

    const complete = await request(app)
      .post('/api/epic-router/task/explorer/complete')
      .set(asRoot)
      .send({ messageId: 'MSG-EX-HIGH', epicId: 'EPIC-ALPHA' });
    expect(complete.body.decision.task.message_id).toBe('MSG-EX-MED');
    expect(complete.body.decision.reason).toBe('Found task in same epic (EPIC-ALPHA)');
  });

  it('an empty queue yields a stop decision', async () => {
    await request(app).post('/api/epic-router/dispatch/explorer').set(asRoot); // MSG-EX-MED
    const complete = await request(app)
      .post('/api/epic-router/task/explorer/complete')
      .set(asRoot)
      .send({ messageId: 'MSG-EX-MED', epicId: 'EPIC-ALPHA' });
    expect(complete.body.decision).toMatchObject({
      shouldDispatch: false,
      nextAction: 'stop',
      reason: 'No queued tasks for explorer',
    });

    const dispatch = await request(app).post('/api/epic-router/dispatch/explorer').set(asRoot);
    expect(dispatch.body.success).toBe(false);
    expect(dispatch.body.nextAction).toBe('stop');
  });

  it('legacy REST completion cannot finish an island-scoped runner claim', async () => {
    expect(epicRouter.claimTerminalTask(
      'explorer', 'MSG-SCOPED-REST', 'island-a', null, null,
    )).toBe('claimed');

    const res = await request(app)
      .post('/api/epic-router/task/explorer/complete')
      .set(asRoot)
      .send({ messageId: 'MSG-SCOPED-REST' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Legacy completion refused');
    expect(epicRouter.getTerminalContext('explorer')).toMatchObject({
      current_task_id: 'MSG-SCOPED-REST',
      current_island_id: 'island-a',
      status: 'working',
    });
    expect(epicRouter.listRunnerCompletionReceipts('island-a', 'explorer', 0).receipts)
      .toHaveLength(0);

    const { ProjectDispatcher } = await import('../../pipeline/projectDispatcher');
    const dispatcher = new ProjectDispatcher({
      enabled: false,
      projectsDir: path.join(ROOT, 'legacy-projects'),
      terminalsDir: TERMINALS,
    });
    await (dispatcher as unknown as {
      processProjectDone(done: Record<string, unknown>): Promise<void>;
    }).processProjectDone({
      from: 'explorer',
      task_id: 'MSG-SCOPED-REST',
      timestamp: new Date(),
      filePath: '',
      content: '',
    });
    expect(epicRouter.getTerminalContext('explorer')).toMatchObject({
      current_task_id: 'MSG-SCOPED-REST',
      current_island_id: 'island-a',
      status: 'working',
    });
    expect(() => epicRouter.markTerminalIdle('explorer')).toThrow(
      /Direct idle transition refused/,
    );

    epicRouter.handleTaskCompletion('explorer', 'MSG-SCOPED-REST', null, {
      islandId: 'island-a', source: 'mcp_complete_task',
    });
  });

  it('rejects generic context writes and legacy dispatch over a scoped claim', () => {
    expect(() => epicRouter.setTerminalContext(
      'explorer', null, null, 'MSG-SCOPED-IMMUTABLE', 'working', 0, 'island-a',
    )).toThrow(/cannot establish a scoped claim/);
    expect(epicRouter.claimTerminalTask(
      'explorer', 'MSG-SCOPED-IMMUTABLE', 'island-a', null, null,
    )).toBe('claimed');
    const before = epicRouter.getTerminalContext('explorer');

    expect(() => epicRouter.setTerminalContext(
      'explorer', null, null, 'MSG-LEGACY-CLOBBER', 'working', 0,
    )).toThrow(epicRouter.ScopedClaimMutationRefusedError);

    epicRouter.queueTask('MSG-LEGACY-DISPATCH', 'explorer', null, null, 'high');
    const queued = epicRouter.getQueueForTerminal('explorer')
      .find((task) => task.message_id === 'MSG-LEGACY-DISPATCH')!;
    expect(() => epicRouter.dispatchTask('explorer', queued))
      .toThrow(epicRouter.ScopedClaimMutationRefusedError);
    expect(epicRouter.getTerminalContext('explorer')).toMatchObject({
      current_task_id: before!.current_task_id,
      current_island_id: before!.current_island_id,
      status: before!.status,
    });
    expect(epicRouter.getQueueForTerminal('explorer')
      .some((task) => task.message_id === 'MSG-LEGACY-DISPATCH')).toBe(true);

    epicRouter.handleTaskCompletion('explorer', 'MSG-SCOPED-IMMUTABLE', null, {
      islandId: 'island-a', source: 'mcp_complete_task',
    });
    epicRouter.cancelQueuedTask('MSG-LEGACY-DISPATCH');
  });
});

// ─── Fetch/ack mailbox endpoints ─────────────────────────────────────────────

describe('GET /fetch and POST /ack', () => {
  const asRoot = { 'x-test-identity': 'root' };

  beforeAll(() => {
    writeInboxMessage(
      'explorer',
      '2026-07-18-fetch-task.md',
      ['---', 'id: MSG-FETCH-1', 'from: conductor', 'status: UNREAD', '---', '', '# Do the thing', 'Body text.'].join('\n')
    );
    epicRouter.queueTask('MSG-FETCH-1', 'explorer', 'EPIC-F', null, 'high');
    const decision = epicRouter.getNextTaskForTerminal('explorer');
    epicRouter.dispatchTask('explorer', decision.task!);
  });

  it('404 for an unknown terminal', async () => {
    const res = await request(app).get('/api/epic-router/fetch/ghost/MSG-X').set(asRoot);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Terminal ghost not found');
  });

  it('403 when the requested task is not the assigned one', async () => {
    const res = await request(app).get('/api/epic-router/fetch/explorer/MSG-OTHER').set(asRoot);
    expect(res.status).toBe(403);
    expect(res.body.currentTask).toBe('MSG-FETCH-1');
  });

  it('serves the assigned task with parsed frontmatter and body', async () => {
    const res = await request(app).get('/api/epic-router/fetch/explorer/MSG-FETCH-1').set(asRoot);
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe('MSG-FETCH-1');
    expect(res.body.task.epic_id).toBe('EPIC-F');
    expect(res.body.task.frontmatter).toMatchObject({ id: 'MSG-FETCH-1', from: 'conductor' });
    expect(res.body.task.content).toContain('# Do the thing');
    expect(res.body.task.filePath).toContain('2026-07-18-fetch-task.md');
  });

  it('ack rejects a non-assigned task and marks the assigned one READ', async () => {
    const wrong = await request(app).post('/api/epic-router/ack/explorer/MSG-OTHER').set(asRoot);
    expect(wrong.status).toBe(403);

    const ok = await request(app).post('/api/epic-router/ack/explorer/MSG-FETCH-1').set(asRoot);
    expect(ok.status).toBe(200);
    expect(ok.body.acknowledged).toBe(true);

    const content = fs.readFileSync(
      path.join(TERMINALS, 'explorer', 'inbox', '2026-07-18-fetch-task.md'),
      'utf-8'
    );
    expect(content).toContain('status: READ');
    expect(content).not.toContain('status: UNREAD');

    // Second ack finds no UNREAD marker left
    const again = await request(app).post('/api/epic-router/ack/explorer/MSG-FETCH-1').set(asRoot);
    expect(again.status).toBe(200);
    expect(again.body.acknowledged).toBe(false);
  });

  it('404 when the assigned task has no backing inbox file', async () => {
    epicRouter.handleLegacyTaskCompletion('explorer', 'MSG-FETCH-1', 'EPIC-F');
    epicRouter.queueTask('MSG-GONE', 'explorer', null, null, 'medium');
    const decision = epicRouter.getNextTaskForTerminal('explorer');
    epicRouter.dispatchTask('explorer', decision.task!);

    const res = await request(app).get('/api/epic-router/fetch/explorer/MSG-GONE').set(asRoot);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task MSG-GONE not found in explorer inbox');

    epicRouter.handleLegacyTaskCompletion('explorer', 'MSG-GONE', null); // leave terminal idle
  });
});

// ─── MCP helper functions ────────────────────────────────────────────────────

describe('fetchTaskForMcp / ackTaskForMcp / completeTaskForMcp', () => {
  const mcpFile = path.join(TERMINALS, 'conductor', 'inbox', 'mcp-task.md');

  beforeAll(() => {
    writeInboxMessage(
      'conductor',
      'mcp-task.md',
      ['---', 'id: MSG-MCP-1', 'status: UNREAD', '---', '', 'MCP body.'].join('\n')
    );
  });

  it('rejects fetch for unknown terminals and unassigned tasks', async () => {
    const unknown = await routes.fetchTaskForMcp('never-heard-of-it', 'MSG-MCP-1');
    expect(unknown).toEqual({ success: false, error: 'Terminal never-heard-of-it not found' });

    const unassigned = await routes.fetchTaskForMcp('conductor', 'MSG-MCP-1');
    expect(unassigned.success).toBe(false);
    expect(unassigned.error).toContain('is not assigned to terminal conductor');
    expect(unassigned.error).toContain('Current task: none');
  });

  it('serves the assigned task after queue + dispatch', async () => {
    epicRouter.queueTask('MSG-MCP-1', 'conductor', null, null, 'high');
    const decision = epicRouter.getNextTaskForTerminal('conductor');
    expect(decision.task!.message_id).toBe('MSG-MCP-1');
    epicRouter.dispatchTask('conductor', decision.task!);
    expect(epicRouter.claimTerminalTask(
      'conductor', 'MSG-MCP-1', 'island-mcp-test', null, null,
    )).toBe('claimed');

    const res = await routes.fetchTaskForMcp('conductor', 'MSG-MCP-1');
    expect(res.success).toBe(true);
    expect(res.task!.frontmatter.id).toBe('MSG-MCP-1');
    expect(res.task!.content).toContain('MCP body.');
  });

  it('ack only the assigned task, patching the file to READ', async () => {
    const wrong = await routes.ackTaskForMcp('conductor', 'MSG-WRONG');
    expect(wrong.success).toBe(false);

    const ok = await routes.ackTaskForMcp('conductor', 'MSG-MCP-1');
    expect(ok).toEqual({ success: true, acknowledged: true });
    expect(fs.readFileSync(mcpFile, 'utf-8')).toContain('status: READ');
  });

  it('complete: continuous-mode terminal finishes without session termination', async () => {
    epicRouter.queueTask('MSG-MCP-NEXT', 'conductor', null, null, 'medium');

    const wrong = await routes.completeTaskForMcp(
      'conductor', 'MSG-WRONG', undefined, 'island-mcp-test',
    );
    expect(wrong.success).toBe(false);
    expect(wrong.error).toContain('not assigned');

    const done = await routes.completeTaskForMcp(
      'conductor',
      'MSG-MCP-1',
      'all done',
      'island-mcp-test',
    );
    expect(done.success).toBe(true);
    expect(done.completed).toBe(true);
    expect(done.sessionTerminated).toBe(false); // conductor is continuous, never cold-killed
    expect(done.nextTask).toBe('MSG-MCP-NEXT');
    expect(done.completionSequence).toEqual(expect.any(Number));
    expect(done.idempotent).toBe(false);

    const receipts = epicRouter.listRunnerCompletionReceipts('island-mcp-test', 'conductor', 0);
    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.receipts[0]).toMatchObject({
      terminalId: 'conductor',
      messageId: 'MSG-MCP-1',
      source: 'mcp_complete_task',
    });

    const retry = await routes.completeTaskForMcp(
      'conductor',
      'MSG-MCP-1',
      undefined,
      'island-mcp-test',
    );
    expect(retry).toMatchObject({
      success: true,
      completed: true,
      completionSequence: done.completionSequence,
      idempotent: true,
    });
    expect(epicRouter.listRunnerCompletionReceipts('island-mcp-test', 'conductor', 0).receipts)
      .toHaveLength(1);
  });

  it('rolls task state back when durable receipt creation fails', () => {
    epicRouter.queueTask('MSG-ATOMIC-ROLLBACK', 'explorer', null, null, 'high');
    const decision = epicRouter.getNextTaskForTerminal('explorer');
    epicRouter.dispatchTask('explorer', decision.task!);
    expect(epicRouter.claimTerminalTask(
      'explorer', 'MSG-ATOMIC-ROLLBACK', 'island-rollback', null, null,
    )).toBe('claimed');

    expect(() => epicRouter.handleTaskCompletion(
      'explorer',
      'MSG-ATOMIC-ROLLBACK',
      null,
      { islandId: '', source: 'mcp_complete_task' },
    )).toThrow(/island scope must be non-empty/);
    expect(epicRouter.getTerminalContext('explorer')).toMatchObject({
      current_task_id: 'MSG-ATOMIC-ROLLBACK',
      status: 'working',
    });

    epicRouter.handleTaskCompletion('explorer', 'MSG-ATOMIC-ROLLBACK', null, {
      islandId: 'island-rollback', source: 'mcp_complete_task',
    });
  });

  it('fetch/ack report a missing file for a dispatched task with no markdown', async () => {
    const decision = epicRouter.getNextTaskForTerminal('conductor');
    epicRouter.dispatchTask('conductor', decision.task!); // MSG-MCP-NEXT has no file
    expect(epicRouter.claimTerminalTask(
      'conductor', 'MSG-MCP-NEXT', 'island-mcp-test', null, null,
    )).toBe('claimed');

    const fetch = await routes.fetchTaskForMcp('conductor', 'MSG-MCP-NEXT');
    expect(fetch).toEqual({ success: false, error: 'Task MSG-MCP-NEXT not found in conductor inbox' });

    const ack = await routes.ackTaskForMcp('conductor', 'MSG-MCP-NEXT');
    expect(ack).toEqual({ success: false, error: 'Task MSG-MCP-NEXT not found' });

    const done = await routes.completeTaskForMcp(
      'conductor', 'MSG-MCP-NEXT', undefined, 'island-mcp-test',
    );
    expect(done.success).toBe(true);
    expect(done.nextTask).toBeNull();
  });

  it('a frontmatter-less message is served whole with an empty frontmatter', async () => {
    writeInboxMessage('conductor', 'plain.md', 'id: MSG-PLAIN\nstatus: UNREAD\nPlain body without markers');
    epicRouter.queueTask('MSG-PLAIN', 'conductor', null, null, 'low');
    const decision = epicRouter.getNextTaskForTerminal('conductor');
    epicRouter.dispatchTask('conductor', decision.task!);

    const res = await routes.fetchTaskForMcp('conductor', 'MSG-PLAIN');
    expect(res.success).toBe(true);
    expect(res.task!.frontmatter).toEqual({});
    expect(res.task!.content).toContain('Plain body without markers');

    epicRouter.handleLegacyTaskCompletion('conductor', 'MSG-PLAIN', null);
  });
});

// ─── EPICS.yaml sync + projects/epics CRUD ───────────────────────────────────

describe('POST /sync and projects/epics endpoints', () => {
  it('syncs projects and epics from a YAML file', async () => {
    const syncFile = path.join(ROOT, `sync-epics-${runId}.yaml`);
    fs.writeFileSync(
      syncFile,
      [
        'epics:',
        '  - id: EPIC-S1',
        '    name: First epic',
        '    project: spaceos/alpha',
        '    status: active',
        '    priority: 3',
        '    depends_on: [EPIC-S0]',
        '  - id: EPIC-S2',
        '    name: Second epic',
      ].join('\n'),
      'utf-8'
    );

    const res = await request(app).post('/api/epic-router/sync').send({ path: syncFile });
    expect(res.status).toBe(200);
    expect(res.body.synced).toEqual({ projects: 2, epics: 2 });
    expect(res.body.message).toBe('Synced 2 projects and 2 epics');
  });

  it('GET /projects and GET /epics reflect the synced state', async () => {
    const projects = await request(app).get('/api/epic-router/projects');
    expect(projects.status).toBe(200);
    const projectIds = projects.body.projects.map((p: { id: string }) => p.id);
    expect(projectIds).toContain('spaceos/alpha');
    expect(projectIds).toContain('default');

    const epics = await request(app).get('/api/epic-router/epics');
    expect(epics.status).toBe(200);
    const s1 = epics.body.epics.find((e: { id: string }) => e.id === 'EPIC-S1');
    expect(s1.depends_on).toEqual(['EPIC-S0']);
    expect(s1.status).toBe('active');
    const s2 = epics.body.epics.find((e: { id: string }) => e.id === 'EPIC-S2');
    expect(s2.project_id).toBe('default');
    expect(s2.status).toBe('pending');
    expect(s2.priority).toBe(2);
  });

  it('sync of a YAML without epics is a no-op; a missing file is 500', async () => {
    const emptyFile = path.join(ROOT, `sync-empty-${runId}.yaml`);
    fs.writeFileSync(emptyFile, 'not_epics: true\n', 'utf-8');
    const empty = await request(app).post('/api/epic-router/sync').send({ path: emptyFile });
    expect(empty.status).toBe(200);
    expect(empty.body.synced).toEqual({ projects: 0, epics: 0 });

    const missing = await request(app)
      .post('/api/epic-router/sync')
      .send({ path: path.join(ROOT, 'nope.yaml') });
    expect(missing.status).toBe(500);
    expect(missing.body.success).toBe(false);
  });

  it('POST /projects validates and creates', async () => {
    const bad = await request(app).post('/api/epic-router/projects').send({ id: 'proj-x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('id and name are required');

    const ok = await request(app)
      .post('/api/epic-router/projects')
      .send({ id: 'proj-x', name: 'Project X', description: 'manual' });
    expect(ok.status).toBe(200);
    expect(ok.body.project).toMatchObject({ id: 'proj-x', name: 'Project X', status: 'active' });
  });

  it('POST /epics validates and creates with dependency round-trip', async () => {
    const bad = await request(app).post('/api/epic-router/epics').send({ id: 'EPIC-MAN', name: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('id, project_id and name are required');

    const ok = await request(app).post('/api/epic-router/epics').send({
      id: 'EPIC-MAN',
      project_id: 'proj-x',
      name: 'Manual epic',
      status: 'active',
      priority: 1,
      depends_on: ['EPIC-S1'],
      target_date: '2026-08-01',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.epic).toMatchObject({
      id: 'EPIC-MAN',
      project_id: 'proj-x',
      priority: 1,
      target_date: '2026-08-01',
    });
    expect(ok.body.epic.depends_on).toEqual(['EPIC-S1']);
  });
});

// ─── Direct pipeline/epicRouter coverage ─────────────────────────────────────

describe('pipeline/epicRouter direct API', () => {
  it('project/epic lookups handle both hits and misses', () => {
    expect(epicRouter.getProjectById('proj-x')!.name).toBe('Project X');
    expect(epicRouter.getProjectById('proj-does-not-exist')).toBeUndefined();
    expect(epicRouter.getEpicById('EPIC-NOPE')).toBeUndefined();
    const forProject = epicRouter.getEpicsForProject('spaceos/alpha');
    expect(forProject.map((e) => e.id)).toContain('EPIC-S1');
  });

  it('setEpicStatus moves an epic out of the active list', () => {
    epicRouter.setEpicStatus('EPIC-S1', 'done');
    expect(epicRouter.getEpicById('EPIC-S1')!.status).toBe('done');
    expect(epicRouter.listActiveEpics().map((e) => e.id)).not.toContain('EPIC-S1');
  });

  it('terminal context transitions: working -> blocked -> idle', () => {
    epicRouter.markTerminalWorking('backend', 'MSG-W1');
    expect(epicRouter.getTerminalContext('backend')!.status).toBe('working');

    epicRouter.markTerminalBlocked('backend');
    expect(epicRouter.getTerminalContext('backend')!.status).toBe('blocked');
    const decision = epicRouter.getNextTaskForTerminal('backend');
    expect(decision).toMatchObject({ shouldDispatch: false, nextAction: 'wait' });

    epicRouter.markTerminalIdle('backend');
    const ctx = epicRouter.getTerminalContext('backend')!;
    expect(ctx.status).toBe('idle');
    expect(ctx.current_task_id).toBeNull();
    expect(ctx.last_task_completed_at).toBeTruthy();
  });

  it('markTerminalWorking is a no-op for unknown terminals', () => {
    epicRouter.markTerminalWorking('ghost-terminal-x', 'MSG-NONE');
    expect(epicRouter.getTerminalContext('ghost-terminal-x')).toBeUndefined();
  });

  it('cancelQueuedTask removes a task from the queue', () => {
    epicRouter.queueTask('MSG-CANCEL-ME', 'backend', null, null, 'low');
    expect(epicRouter.getQueueForTerminal('backend').length).toBe(1);
    epicRouter.cancelQueuedTask('MSG-CANCEL-ME');
    expect(epicRouter.getQueueForTerminal('backend')).toEqual([]);
  });

  it('initializeTerminals is idempotent and the DB accessors agree', () => {
    epicRouter.initializeTerminals(); // all contexts already exist
    expect(epicRouter.getTerminalContext('root')).toBeTruthy();
    expect(epicRouter.getEpicRouterDb()).toBe(epicRouter.getDatabase());
  });

  it('handleTaskCompletion flips a matching EPICS.yaml checkpoint to done', () => {
    fs.writeFileSync(
      EPICS,
      [
        'epics:',
        '  - id: EPIC-CP',
        '    checkpoints:',
        '      - id: CP-X',
        '        condition: "MSG-CP-1 status=DONE"',
        '        status: pending',
        '      - id: CP-Y',
        '        condition: "MSG-OTHER status=DONE"',
        '        status: pending',
      ].join('\n'),
      'utf-8'
    );

    // Completing an unrelated message leaves the file untouched
    epicRouter.handleLegacyTaskCompletion('backend', 'MSG-NOT-IN-YAML', 'EPIC-CP');
    expect(fs.readFileSync(EPICS, 'utf-8')).not.toContain('status: done');

    // Completing the checkpoint-bound message updates only its checkpoint
    epicRouter.handleLegacyTaskCompletion('backend', 'MSG-CP-1', 'EPIC-CP');
    const updated = fs.readFileSync(EPICS, 'utf-8');
    const cpxBlock = updated.slice(updated.indexOf('CP-X'), updated.indexOf('CP-Y'));
    expect(cpxBlock).toContain('status: done');
    expect(updated.match(/status: pending/g)).toHaveLength(1); // CP-Y untouched
  });

  it('matches checkpoint message IDs literally when they contain regex metacharacters', () => {
    fs.writeFileSync(
      EPICS,
      [
        'epics:',
        '  - id: EPIC-CP',
        '    checkpoints:',
        '      - id: CP-LITERAL',
        '        condition: "MSG-CP-[1] status=DONE"',
        '        status: pending',
      ].join('\n'),
      'utf-8'
    );

    epicRouter.handleLegacyTaskCompletion('backend', 'MSG-CP-1', 'EPIC-CP');
    expect(fs.readFileSync(EPICS, 'utf-8')).toContain('status: pending');

    epicRouter.handleLegacyTaskCompletion('backend', 'MSG-CP-[1]', 'EPIC-CP');
    expect(fs.readFileSync(EPICS, 'utf-8')).toContain('status: done');
  });
});
