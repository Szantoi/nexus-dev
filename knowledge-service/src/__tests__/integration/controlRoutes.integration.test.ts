/**
 * Dispatch-control HTTP API integration tests — hermetic.
 *
 * PINS the contract of /api/control (control.routes.ts):
 *  - mutating endpoints require a Bearer token verified against
 *    <SPACEOS_ROOT>/config/tokens.yaml (sha256 hashes; expired tokens denied);
 *  - budget/usage/can-dispatch answer from the dispatch SQLite DB with the
 *    seeded per-terminal defaults, and manual mode always blocks auto dispatch;
 *  - the proposal lifecycle (create -> approve/reject -> approve-all/expire)
 *    is idempotence-guarded (deciding twice is a 400);
 *  - scheduled-window CRUD and session tracking round-trip through the DB;
 *  - proposal/window endpoints fail with a redacted 500 while their DB is not
 *    wired (dependency error), and work after setProposalDb/setWindowsDb.
 *
 * Hermetic: DB under a tmp DATA_DIR, tokens.yaml under a tmp SPACEOS_ROOT,
 * no Telegram (no token configured), no tmux (the session-spawning
 * POST /dispatch happy path is intentionally NOT exercised — only its auth
 * and validation branches).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ─── Hermetic environment (must precede any src import) ──────────────────────

const runId = crypto.randomBytes(6).toString('hex');
const ROOT = path.join(os.tmpdir(), `ctlrt-${runId}`);
const TERMINALS = path.join(ROOT, 'terminals');

process.env.SPACEOS_ROOT = ROOT;
process.env.DATA_DIR = path.join(ROOT, 'data');
process.env.TERMINALS_PATH = TERMINALS;
process.env.EPICS_PATH = path.join(ROOT, 'EPICS.yaml');
process.env.AGENTS_CONFIG_PATH = path.join(ROOT, `no-agents-${runId}.yaml`);
process.env.AUTH_MODE = 'open';
delete process.env.MCP_AUTH_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MCP_TOKEN_')) delete process.env[key];
}

const VALID_TOKEN = `ctl-test-token-${runId}`;
const EXPIRED_TOKEN = `ctl-expired-token-${runId}`;

function sha256(token: string): string {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

let request: typeof import('supertest').default;
let app: import('express').Express;
type DispatchControl = typeof import('../../dispatch-control');
let dc: DispatchControl;

const auth = { Authorization: `Bearer ${VALID_TOKEN}` };

beforeAll(async () => {
  // task-audit/auth reads <SPACEOS_ROOT>/config/tokens.yaml lazily.
  fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'config', 'tokens.yaml'),
    [
      'version: "1.0"',
      'tokens:',
      '  - holder: qa',
      `    hash: "${sha256(VALID_TOKEN)}"`,
      '    scopes: ["task:create:*", "session:*"]',
      '    created: "2026-07-18"',
      '  - holder: relic',
      `    hash: "${sha256(EXPIRED_TOKEN)}"`,
      '    scopes: ["task:create:*"]',
      '    created: "2020-01-01"',
      '    expires: "2020-06-01"',
    ].join('\n'),
    'utf-8'
  );

  const express = (await import('express')).default;
  request = (await import('supertest')).default;
  const controlRoutes = (await import('../../interfaces/http/routes/control.routes')).default;
  dc = await import('../../dispatch-control');

  // Belt and braces: secrets are read lazily, keep Telegram unconfigured.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  const server = express();
  server.use(express.json());
  server.use('/api/control', controlRoutes);
  app = server;
});

// ─── Dependency errors before the proposal/window DBs are wired ──────────────

describe('before DB wiring (dependency errors)', () => {
  it('proposal endpoints answer 500 while setProposalDb has not run', async () => {
    const res = await request(app).get('/api/control/proposals');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('window endpoints answer 500 while setWindowsDb has not run', async () => {
    const res = await request(app).get('/api/control/windows');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

// ─── Wired suite ─────────────────────────────────────────────────────────────

describe('with the dispatch DB wired', () => {
  beforeAll(() => {
    const db = dc.initDispatchDb();
    dc.setProposalDb(db);
    dc.setWindowsDb(db);
  });

  describe('mode endpoints', () => {
    it('GET /mode starts in manual (schema default)', async () => {
      const res = await request(app).get('/api/control/mode');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ mode: 'manual' });
    });

    it('POST /mode without a token is 401', async () => {
      const res = await request(app).post('/api/control/mode').send({ mode: 'auto' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Missing or invalid Authorization header');
    });

    it('POST /mode with an unknown token is 401 (generic error)', async () => {
      const res = await request(app)
        .post('/api/control/mode')
        .set('Authorization', 'Bearer wrong-token')
        .send({ mode: 'auto' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid token');
    });

    it('POST /mode with an expired token is 401', async () => {
      const res = await request(app)
        .post('/api/control/mode')
        .set('Authorization', `Bearer ${EXPIRED_TOKEN}`)
        .send({ mode: 'auto' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Token expired');
    });

    it('POST /mode validates the mode value', async () => {
      const res = await request(app).post('/api/control/mode').set(auth).send({ mode: 'turbo' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid mode');
    });

    it('POST /mode switches to auto and attributes the change to the token holder', async () => {
      const res = await request(app).post('/api/control/mode').set(auth).send({ mode: 'auto' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, mode: 'auto', previousMode: 'manual', updatedBy: 'qa' });

      const check = await request(app).get('/api/control/mode');
      expect(check.body.mode).toBe('auto');
    });
  });

  describe('budget endpoints', () => {
    it('GET /budget summarizes the seeded per-terminal defaults', async () => {
      const res = await request(app).get('/api/control/budget');
      expect(res.status).toBe(200);
      expect(res.body.totalLimit).toBe(80000);
      expect(res.body.totalUsed).toBe(0);
      expect(res.body.byTerminal.root.dailyLimit).toBe(20000);
      expect(res.body.byTerminal.conductor.dailyLimit).toBe(15000);
      expect(res.body.resetAt).toBeTruthy();
    });

    it('GET /budget/:terminal answers for configured and unknown terminals', async () => {
      const known = await request(app).get('/api/control/budget/backend');
      expect(known.status).toBe(200);
      expect(known.body).toMatchObject({ terminal: 'backend', dailyLimit: 10000, status: 'ok' });

      const unknown = await request(app).get('/api/control/budget/never-configured');
      expect(unknown.status).toBe(200);
      expect(unknown.body).toMatchObject({
        terminal: 'never-configured',
        dailyLimit: 10000,
        tokensUsed: 0,
        usagePercent: 0,
        status: 'ok',
      });
    });

    it('POST /budget/:terminal requires auth and a numeric dailyLimit', async () => {
      const anon = await request(app).post('/api/control/budget/qaterm').send({ dailyLimit: 1000 });
      expect(anon.status).toBe(401);

      const bad = await request(app)
        .post('/api/control/budget/qaterm')
        .set(auth)
        .send({ dailyLimit: 'lots' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('dailyLimit must be a positive number');
    });

    it('POST /budget/:terminal sets the terminal budget', async () => {
      const res = await request(app)
        .post('/api/control/budget/qaterm')
        .set(auth)
        .send({ dailyLimit: 1000, priorityReserve: 100 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, terminal: 'qaterm', dailyLimit: 1000 });
    });
  });

  describe('usage endpoints', () => {
    it('POST /usage validates terminal and tokensUsed', async () => {
      const res = await request(app).post('/api/control/usage').send({ terminal: 'qaterm' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('terminal and tokensUsed are required');
    });

    it('POST /usage records usage and returns the updated budget status', async () => {
      const res = await request(app)
        .post('/api/control/usage')
        .send({ terminal: 'qaterm', tokensUsed: 100, model: 'sonnet', sessionId: 's-1' });
      expect(res.status).toBe(200);
      expect(res.body.recorded).toBe(100);
      expect(res.body.budgetStatus).toMatchObject({ terminal: 'qaterm', tokensUsed: 100, tokensRemaining: 900 });
    });

    it('GET /usage aggregates, optionally per terminal', async () => {
      const all = await request(app).get('/api/control/usage');
      expect(all.status).toBe(200);
      expect(all.body.today).toBeGreaterThanOrEqual(100);

      const scoped = await request(app).get('/api/control/usage').query({ terminal: 'qaterm' });
      expect(scoped.body.today).toBe(100);
      expect(scoped.body.byModel).toEqual({ sonnet: 100 });
    });
  });

  describe('can-dispatch and dispatch queue', () => {
    it('GET /can-dispatch requires the terminal query param', async () => {
      const res = await request(app).get('/api/control/can-dispatch');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('terminal query param required');
    });

    it('allows dispatch in auto mode within budget', async () => {
      const res = await request(app)
        .get('/api/control/can-dispatch')
        .query({ terminal: 'qaterm', estimatedTokens: '500' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ allowed: true, budgetRemaining: 400, estimatedAfter: 600 });
    });

    it('denies dispatch when the estimate exceeds the remaining budget', async () => {
      const res = await request(app)
        .get('/api/control/can-dispatch')
        .query({ terminal: 'qaterm', estimatedTokens: '5000' });
      expect(res.body.allowed).toBe(false);
      expect(res.body.reason).toBe('Insufficient budget: need 5000, have 900');
    });

    it('a depleted budget only admits critical priority within the reserve', async () => {
      await request(app).post('/api/control/usage').send({ terminal: 'qaterm', tokensUsed: 900 });

      const normal = await request(app)
        .get('/api/control/can-dispatch')
        .query({ terminal: 'qaterm', estimatedTokens: '50' });
      expect(normal.body.allowed).toBe(false);
      expect(normal.body.reason).toBe('Budget depleted for qaterm');

      const critical = await request(app)
        .get('/api/control/can-dispatch')
        .query({ terminal: 'qaterm', estimatedTokens: '50', priority: 'critical' });
      expect(critical.body.allowed).toBe(true);
      expect(critical.body.reason).toBe('Using priority reserve');
    });

    it('manual mode always requires explicit approval', async () => {
      await request(app).post('/api/control/mode').set(auth).send({ mode: 'manual' });
      const res = await request(app)
        .get('/api/control/can-dispatch')
        .query({ terminal: 'qaterm' });
      expect(res.body.allowed).toBe(false);
      expect(res.body.reason).toBe('Manual mode - requires explicit dispatch approval');
    });

    it('queue endpoints validate and round-trip queued dispatches', async () => {
      const empty = await request(app).get('/api/control/queue');
      expect(empty.body).toEqual({ count: 0, queue: [] });

      const bad = await request(app).post('/api/control/queue').send({ terminal: 'qaterm' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('messageId and terminal are required');

      const ok = await request(app)
        .post('/api/control/queue')
        .send({ messageId: 'MSG-CTL-1', terminal: 'qaterm', priority: 'high' });
      expect(ok.body).toMatchObject({ success: true, queued: 'MSG-CTL-1', priority: 'high' });

      const filled = await request(app).get('/api/control/queue');
      expect(filled.body.count).toBe(1);
      expect(filled.body.queue[0]).toMatchObject({ messageId: 'MSG-CTL-1', terminal: 'qaterm', status: 'queued' });
    });
  });

  describe('manual dispatch and emergency stop', () => {
    it('POST /dispatch enforces auth and validates terminal (no session is spawned)', async () => {
      const anon = await request(app).post('/api/control/dispatch').send({ terminal: 'qaterm' });
      expect(anon.status).toBe(401);

      const bad = await request(app).post('/api/control/dispatch').set(auth).send({});
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('terminal is required');
    });

    it('POST /emergency-stop requires auth, then forces manual mode and stops all schedulers', async () => {
      const anon = await request(app).post('/api/control/emergency-stop').send({});
      expect(anon.status).toBe(401);

      const res = await request(app).post('/api/control/emergency-stop').set(auth).send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.currentMode).toBe('manual');
      expect(res.body.previousMode).toBe('manual'); // manual since the can-dispatch tests
      expect(res.body.stoppedSchedulers).toHaveLength(9);
      expect(res.body.stoppedSchedulers).toContain('nightwatch');

      const mode = await request(app).get('/api/control/mode');
      expect(mode.body.mode).toBe('manual');
    });
  });

  describe('proposal lifecycle', () => {
    let firstId: string;

    it('GET /proposals starts empty with zeroed stats', async () => {
      const res = await request(app).get('/api/control/proposals');
      expect(res.status).toBe(200);
      expect(res.body.proposals).toEqual([]);
      expect(res.body.stats.pending).toBe(0);
    });

    it('POST /proposals requires auth and terminal+taskId', async () => {
      const anon = await request(app)
        .post('/api/control/proposals')
        .send({ terminal: 'qaterm', taskId: 'TASK-1' });
      expect(anon.status).toBe(401);

      const bad = await request(app).post('/api/control/proposals').set(auth).send({ terminal: 'qaterm' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('terminal and taskId are required');
    });

    it('creates a proposal with defaults attributed to the token holder', async () => {
      const res = await request(app)
        .post('/api/control/proposals')
        .set(auth)
        .send({ terminal: 'qaterm', taskId: 'TASK-1' });
      expect(res.status).toBe(201);
      expect(res.body.proposal).toMatchObject({
        terminal: 'qaterm',
        taskId: 'TASK-1',
        reason: 'UNREAD inbox detected',
        estimatedTokens: 5000,
        proposedBy: 'qa',
        status: 'pending',
      });
      expect(res.body.proposal.proposalId).toMatch(/^PROP-/);
      firstId = res.body.proposal.proposalId;
    });

    it('GET /proposals/:id returns the proposal or 404', async () => {
      const found = await request(app).get(`/api/control/proposals/${firstId}`);
      expect(found.status).toBe(200);
      expect(found.body.proposalId).toBe(firstId);

      const missing = await request(app).get('/api/control/proposals/PROP-NOPE');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('Proposal not found');
    });

    it('approval requires auth, rejects unknown ids and is not repeatable', async () => {
      const anon = await request(app).post(`/api/control/proposals/${firstId}/approve`).send({});
      expect(anon.status).toBe(401);

      const unknown = await request(app)
        .post('/api/control/proposals/PROP-NOPE/approve')
        .set(auth)
        .send({});
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toBe('Proposal not found');

      const approved = await request(app)
        .post(`/api/control/proposals/${firstId}/approve`)
        .set(auth)
        .send({});
      expect(approved.status).toBe(200);
      expect(approved.body.success).toBe(true);
      expect(approved.body.proposal.status).toBe('approved');
      expect(approved.body.sessionStarted).toBe(true); // queued + marked executing, no real session

      const again = await request(app)
        .post(`/api/control/proposals/${firstId}/approve`)
        .set(auth)
        .send({});
      expect(again.status).toBe(400);
      expect(again.body.error).toBe('Proposal already approved');
    });

    it('rejection archives the proposal without queueing a dispatch', async () => {
      const created = await request(app)
        .post('/api/control/proposals')
        .set(auth)
        .send({ terminal: 'qaterm', taskId: 'TASK-2', reason: 'second one' });
      const id = created.body.proposal.proposalId;

      const rejected = await request(app)
        .post(`/api/control/proposals/${id}/reject`)
        .set(auth)
        .send({ reason: 'not now' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.proposal.status).toBe('rejected');
      expect(rejected.body.sessionStarted).toBe(false);
    });

    it('approve-all sweeps the remaining pending proposals', async () => {
      await request(app)
        .post('/api/control/proposals')
        .set(auth)
        .send({ terminal: 'qaterm', taskId: 'TASK-3' });

      const anon = await request(app).post('/api/control/proposals/approve-all').send({});
      expect(anon.status).toBe(401);

      const res = await request(app).post('/api/control/proposals/approve-all').set(auth).send({});
      expect(res.status).toBe(200);
      expect(res.body.approved).toBe(1);
      expect(res.body.proposals).toHaveLength(1);
    });

    it('expire is a no-op for fresh proposals and stats reflect the decisions', async () => {
      const res = await request(app).post('/api/control/proposals/expire').send({ maxAgeHours: 24 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, expired: 0 });

      const stats = await request(app).get('/api/control/proposals');
      expect(stats.body.stats.pending).toBe(0);
      expect(stats.body.stats.approvedToday).toBe(2);
      expect(stats.body.stats.rejectedToday).toBe(1);
    });
  });

  describe('scheduled windows', () => {
    it('GET /windows starts empty with the manual default mode', async () => {
      const res = await request(app).get('/api/control/windows');
      expect(res.status).toBe(200);
      expect(res.body.windows).toEqual([]);
      expect(res.body.currentWindow).toBeNull();
      expect(res.body.defaultMode).toBe('manual');
      expect(res.body.stats.totalWindows).toBe(0);
    });

    it('window check outside all windows follows the default mode', async () => {
      const manual = await request(app).get('/api/control/windows/check/qaterm');
      expect(manual.status).toBe(200);
      expect(manual.body.inWindow).toBe(false);
      expect(manual.body.terminalAllowed).toBe(false);
      expect(manual.body.reason).toContain('Outside scheduled windows');
      expect(manual.body.currentTime).toMatch(/^\d{2}:\d{2}$/);

      const badMode = await request(app).post('/api/control/windows/default-mode').send({ mode: 'turbo' });
      expect(badMode.status).toBe(400);

      const setAuto = await request(app).post('/api/control/windows/default-mode').send({ mode: 'auto' });
      expect(setAuto.body).toEqual({ success: true, defaultMode: 'auto' });

      const auto = await request(app).get('/api/control/windows/check/qaterm');
      expect(auto.body.terminalAllowed).toBe(true);
      expect(auto.body.reason).toBe('Outside scheduled windows - default mode is auto');

      await request(app).post('/api/control/windows/default-mode').send({ mode: 'manual' });
    });

    it('POST /windows validates required fields and adds a window', async () => {
      const bad = await request(app).post('/api/control/windows').send({ name: 'incomplete' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain('Missing required fields');

      const ok = await request(app).post('/api/control/windows').send({
        name: 'qa-window',
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        startTime: '00:00',
        endTime: '23:59',
        allowedTerminals: ['qaterm'],
        maxSessions: 2,
      });
      expect(ok.status).toBe(200);
      expect(ok.body.message).toBe('Window "qa-window" added');

      const listed = await request(app).get('/api/control/windows');
      expect(listed.body.windows).toHaveLength(1);
      expect(listed.body.windows[0]).toMatchObject({
        name: 'qa-window',
        allowedTerminals: ['qaterm'],
        maxSessions: 2,
      });
    });

    it('window sessions can be registered, listed and ended', async () => {
      const badStart = await request(app).post('/api/control/windows/session/start').send({ terminal: 'qaterm' });
      expect(badStart.status).toBe(400);

      const start = await request(app)
        .post('/api/control/windows/session/start')
        .send({ terminal: 'qaterm', windowName: 'qa-window', sessionId: 'sess-1' });
      expect(start.body.success).toBe(true);

      const sessions = await request(app).get('/api/control/windows/sessions');
      expect(sessions.body.sessions).toHaveLength(1);
      expect(sessions.body.sessions[0]).toMatchObject({ terminal: 'qaterm', windowName: 'qa-window' });

      const badEnd = await request(app).post('/api/control/windows/session/end').send({});
      expect(badEnd.status).toBe(400);

      const end = await request(app).post('/api/control/windows/session/end').send({ terminal: 'qaterm' });
      expect(end.body.success).toBe(true);

      const after = await request(app).get('/api/control/windows/sessions');
      expect(after.body.sessions).toEqual([]);
    });

    it('DELETE /windows/:name removes only existing windows', async () => {
      const missing = await request(app).delete('/api/control/windows/no-such-window');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('Window not found');

      const removed = await request(app).delete('/api/control/windows/qa-window');
      expect(removed.status).toBe(200);
      expect(removed.body.message).toBe('Window "qa-window" removed');
    });

    it('POST /windows/load-defaults installs the preset windows', async () => {
      const res = await request(app).post('/api/control/windows/load-defaults').send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.windowsLoaded).toBe(4);
      expect(res.body.windows.map((w: { name: string }) => w.name)).toContain('Night Watch');
    });
  });

  // MUST run last: it destroys the shared SQLite handle for the whole suite.
  describe('after the DB handle dies (every endpoint degrades to a redacted 500)', () => {
    beforeAll(() => {
      // Close the shared handle WITHOUT resetting module state (closeDispatchDb
      // would null it out and let getDb() re-open): every subsequent prepared
      // statement now throws, driving each endpoint's catch branch. This also
      // proves POST /dispatch fails in canDispatch BEFORE any session spawn.
      dc.initDispatchDb().close();
    });

    it('read endpoints answer 500 without leaking the exception', async () => {
      const reads = [
        '/api/control/mode',
        '/api/control/budget',
        '/api/control/budget/backend',
        '/api/control/usage',
        '/api/control/can-dispatch?terminal=qaterm',
        '/api/control/queue',
        '/api/control/proposals',
        '/api/control/proposals/PROP-ANY',
        '/api/control/windows',
        '/api/control/windows/check/qaterm',
        '/api/control/windows/sessions',
      ];
      for (const url of reads) {
        const res = await request(app).get(url);
        expect(res.status, url).toBe(500);
        expect(res.body, url).toEqual({ error: 'Internal server error' });
      }
    });

    it('mutating endpoints answer 500 after passing auth/validation', async () => {
      const posts: Array<[string, Record<string, unknown>]> = [
        ['/api/control/mode', { mode: 'manual' }],
        ['/api/control/budget/backend', { dailyLimit: 10 }],
        ['/api/control/usage', { terminal: 'qaterm', tokensUsed: 1 }],
        ['/api/control/queue', { messageId: 'MSG-DEAD-1', terminal: 'qaterm' }],
        ['/api/control/dispatch', { terminal: 'qaterm' }], // dies in canDispatch, no session
        ['/api/control/emergency-stop', {}],
        ['/api/control/proposals', { terminal: 'qaterm', taskId: 'TASK-DEAD' }],
        ['/api/control/proposals/PROP-ANY/approve', {}],
        ['/api/control/proposals/PROP-ANY/reject', {}],
        ['/api/control/proposals/approve-all', {}],
        ['/api/control/proposals/expire', {}],
        ['/api/control/windows', {
          name: 'dead-window',
          days: ['mon'],
          startTime: '01:00',
          endTime: '02:00',
          allowedTerminals: ['qaterm'],
        }],
        ['/api/control/windows/session/start', { terminal: 'qaterm', windowName: 'w' }],
        ['/api/control/windows/session/end', { terminal: 'qaterm' }],
        ['/api/control/windows/default-mode', { mode: 'auto' }],
        ['/api/control/windows/load-defaults', {}],
      ];
      for (const [url, body] of posts) {
        const res = await request(app).post(url).set(auth).send(body);
        expect(res.status, url).toBe(500);
        expect(res.body, url).toEqual({ error: 'Internal server error' });
      }

      const del = await request(app).delete('/api/control/windows/dead-window');
      expect(del.status).toBe(500);
      expect(del.body).toEqual({ error: 'Internal server error' });
    });
  });
});
