/**
 * MCP transport unit tests (TASK-QC-006) — the pieces of src/mcp.ts that the
 * contract suite (integration/mcpContract.integration.test.ts) does not pin:
 *
 *  - authorizeMailboxRest: the full REST /api/mailbox authorization matrix
 *    (identity missing, root/conductor, monitor read-only, broadcast guard,
 *    public read paths, own-vs-foreign mailbox, create_task permission).
 *  - JSON-RPC protocol edges: invalid jsonrpc version, tools/call without a
 *    name, notifications/initialized, unknown method.
 *
 * Hermetic: no tokens configured + AUTH_MODE=open -> every caller resolves to
 * 'root' for the HTTP layer; the mailbox matrix is driven by direct middleware
 * calls with mock req/res, so no terminal file tree is needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  // Point auth at a nonexistent agents.yaml -> "no tokens configured".
  const runId = require('crypto').randomBytes(6).toString('hex');
  process.env.AGENTS_CONFIG_PATH = require('path').join(
    require('os').tmpdir(),
    `mcp-transport-none-${runId}.yaml`,
  );
  process.env.AUTH_MODE = 'open';
  delete process.env.MCP_AUTH_TOKEN;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MCP_TOKEN_')) delete process.env[key];
  }
});

import express, { type Express, type Request } from 'express';
import supertest from 'supertest';
import { resetAuthStateForTests, setAuthMode, loadAgentTokens } from '../../auth/tokenAuth';
import mcpRouter, { authorizeMailboxRest } from '../../mcp';

let app: Express;

beforeAll(() => {
  resetAuthStateForTests();
  setAuthMode('open');
  loadAgentTokens();

  const server = express();
  server.use(express.json());
  server.use('/mcp', mcpRouter);
  app = server;
});
const request = supertest;

afterAll(() => {
  resetAuthStateForTests();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface MockRes {
  statusCode: number | null;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

// Typed shim so the middleware under test accepts the lightweight mock res.
const callAuthorize = authorizeMailboxRest as unknown as (
  req: Request,
  res: MockRes,
  next: () => void,
) => void;

function mailboxReq(options: {
  terminal?: string; // resolved identity (req.mcpTerminal)
  target?: string; // req.params.terminal
  method?: string;
  path?: string;
}): { req: Request; res: MockRes; next: ReturnType<typeof vi.fn> } {
  const req = {
    mcpTerminal: options.terminal,
    params: options.target ? { terminal: options.target } : {},
    method: options.method ?? 'GET',
    path: options.path ?? '/',
    originalUrl: options.path ?? '/',
    headers: {},
  } as unknown as Request;
  const res: MockRes = {
    statusCode: null,
    body: null,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return { req, res, next: vi.fn() };
}

// ─── authorizeMailboxRest matrix ─────────────────────────────────────────────

describe('authorizeMailboxRest', () => {
  it('rejects requests without a resolved terminal identity (401)', () => {
    const { req, res, next } = mailboxReq({ terminal: undefined, method: 'GET' });
    callAuthorize(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: expect.stringContaining('No terminal identity') });
  });

  it.each(['root', 'conductor'])('%s has full access to any mailbox', (who) => {
    const { req, res, next } = mailboxReq({
      terminal: who, target: 'backend', method: 'DELETE', path: '/backend/inbox/MSG-1',
    });
    callAuthorize(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it('monitor may GET anything but never mutate (read-only role)', () => {
    const read = mailboxReq({ terminal: 'monitor', target: 'backend', method: 'GET', path: '/backend/inbox' });
    callAuthorize(read.req, read.res, read.next);
    expect(read.next).toHaveBeenCalledOnce();

    const write = mailboxReq({ terminal: 'monitor', target: 'monitor', method: 'POST', path: '/monitor/inbox' });
    callAuthorize(write.req, write.res, write.next);
    expect(write.next).not.toHaveBeenCalled();
    expect(write.res.statusCode).toBe(403);
    expect(write.res.body).toMatchObject({ error: expect.stringContaining('GET operations') });
  });

  it('broadcast is root/conductor only', () => {
    const { req, res, next } = mailboxReq({ terminal: 'backend', method: 'POST', path: '/broadcast' });
    callAuthorize(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringContaining('broadcast') });
  });

  it.each(['/counter', '/outbox/unread', '/tasks/status'])(
    'read-only shared path %s is open to any terminal',
    (sharedPath) => {
      const { req, res, next } = mailboxReq({ terminal: 'backend', method: 'GET', path: sharedPath });
      callAuthorize(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.statusCode).toBeNull();
    },
  );

  it('a terminal has full access to its OWN mailbox', () => {
    const { req, res, next } = mailboxReq({
      terminal: 'backend', target: 'backend', method: 'POST', path: '/backend/inbox',
    });
    callAuthorize(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('POST to a FOREIGN inbox requires the create_task tool permission (backend lacks it)', () => {
    // config/tool-permissions.yaml: create_task -> [root, conductor]
    const { req, res, next } = mailboxReq({
      terminal: 'backend', target: 'frontend', method: 'POST', path: '/frontend/inbox',
    });
    callAuthorize(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringContaining('cannot send tasks') });
  });

  it('any other operation on a foreign mailbox is denied', () => {
    const { req, res, next } = mailboxReq({
      terminal: 'backend', target: 'frontend', method: 'DELETE', path: '/frontend/inbox/MSG-1',
    });
    callAuthorize(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringContaining('their own mailbox') });
  });

  it('non-terminal-scoped paths without special handling fall through to next', () => {
    const { req, res, next } = mailboxReq({ terminal: 'backend', method: 'GET', path: '/some/other' });
    callAuthorize(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ─── JSON-RPC protocol edges ─────────────────────────────────────────────────

describe('MCP JSON-RPC edge handling', () => {
  it('rejects a non-2.0 jsonrpc version with -32600', async () => {
    const r = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '1.0', method: 'initialize', id: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32600);
    expect(r.body.error.message).toContain('jsonrpc must be "2.0"');
  });

  it('rejects tools/call without a tool name with -32602', async () => {
    const r = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'tools/call', params: { arguments: {} }, id: 2 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32602);
    expect(r.body.error.message).toContain('name is required');
  });

  it('accepts notifications/initialized with 204 and no body', async () => {
    const r = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(204);
  });

  it('answers an unknown method with -32601', async () => {
    const r = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'resources/list', id: 3 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32601);
    expect(r.body.error.message).toContain('Method not found');
  });
});
