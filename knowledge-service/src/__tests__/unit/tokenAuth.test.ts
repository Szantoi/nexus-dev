/**
 * tokenAuth unit tests — hermetic, temp-file agents.yaml.
 * PINS the security contract: identity comes from the token, 'open' mode
 * preserves local-dev behavior, 'required' mode fails closed.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import type { Response } from 'express';

const AGENTS_PATH = vi.hoisted(() => {
  const runId = require('crypto').randomBytes(6).toString('hex');
  const p = require('path').join(require('os').tmpdir(), `token-auth-${runId}.yaml`);
  process.env.AGENTS_CONFIG_PATH = p;
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.AUTH_MODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MCP_TOKEN_')) delete process.env[key];
  }
  return p;
});

import {
  loadAgentTokens,
  getAgentFromToken,
  getIslandForAgent,
  getAuthMode,
  hasTokensConfigured,
  setAuthMode,
  resetAuthStateForTests,
  authenticateMcp,
  authenticateRest,
  apiAuthGate,
  requireRoot,
  requireRootForMutations,
} from '../../auth/tokenAuth';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeAgentsYaml(content: string): void {
  fs.writeFileSync(AGENTS_PATH, content, 'utf-8');
  resetAuthStateForTests();
  loadAgentTokens();
}

function removeAgentsYaml(): void {
  if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  resetAuthStateForTests();
  loadAgentTokens();
}

interface MockRes {
  statusCode: number | null;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function mockReqRes(authHeader?: string): { req: any; res: MockRes; next: ReturnType<typeof vi.fn> } {
  const req: any = {
    headers: authHeader ? { authorization: authHeader } : {},
    method: 'POST',
    originalUrl: '/test',
    ip: '127.0.0.1',
  };
  const res: MockRes = {
    statusCode: null,
    body: null,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return { req, res, next: vi.fn() };
}

const YAML_WITH_TOKENS = `
master_token: "master-secret"
agents:
  "backend-token": backend
  "conductor-token": conductor
default_agent: null
`;

afterAll(() => {
  if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  resetAuthStateForTests();
});

// ─── Token Resolution ────────────────────────────────────────────────────────

describe('getAgentFromToken', () => {
  beforeEach(() => writeAgentsYaml(YAML_WITH_TOKENS));

  it('maps the master token to root', () => {
    expect(getAgentFromToken('master-secret')).toBe('root');
  });

  it('maps agent tokens to their terminal names', () => {
    expect(getAgentFromToken('backend-token')).toBe('backend');
    expect(getAgentFromToken('conductor-token')).toBe('conductor');
  });

  it('returns null for unknown tokens', () => {
    expect(getAgentFromToken('no-such-token')).toBeNull();
  });

  it('env MCP_TOKEN_<NAME> overrides YAML and maps to the lowercased agent', () => {
    process.env.MCP_TOKEN_DESIGNER = 'designer-env-token';
    try {
      writeAgentsYaml(YAML_WITH_TOKENS);
      expect(getAgentFromToken('designer-env-token')).toBe('designer');
      expect(getAgentFromToken('backend-token')).toBe('backend'); // YAML entries survive the merge
    } finally {
      delete process.env.MCP_TOKEN_DESIGNER;
    }
  });

  it('hasTokensConfigured reflects the loaded state', () => {
    expect(hasTokensConfigured()).toBe(true);
    removeAgentsYaml();
    expect(hasTokensConfigured()).toBe(false);
  });
});

// ─── Open Mode (local dev default) ───────────────────────────────────────────

describe('AUTH_MODE=open', () => {
  it('no tokens configured -> every caller is root (dev mode)', () => {
    removeAgentsYaml();
    setAuthMode('open');
    const { req, res, next } = mockReqRes();
    authenticateRest(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.mcpTerminal).toBe('root');
  });

  it('tokens configured + valid token -> identity from token, not from client claim', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('open');
    const { req, res, next } = mockReqRes('Bearer backend-token');
    authenticateRest(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.mcpTerminal).toBe('backend');
  });

  it('tokens configured + missing header -> 401', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('open');
    const { req, res, next } = mockReqRes();
    authenticateRest(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('tokens configured + invalid token -> 403', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('open');
    const { req, res, next } = mockReqRes('Bearer wrong');
    authenticateRest(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('default_agent applies when no header is sent', () => {
    writeAgentsYaml(`${YAML_WITH_TOKENS.replace('default_agent: null', 'default_agent: explorer')}`);
    setAuthMode('open');
    const { req, res, next } = mockReqRes();
    authenticateRest(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.mcpTerminal).toBe('explorer');
  });

  it('apiAuthGate is a no-op in open mode', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('open');
    const { req, res, next } = mockReqRes(); // no token at all
    apiAuthGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });
});

// ─── Required Mode (fail closed) ─────────────────────────────────────────────

describe('AUTH_MODE=required', () => {
  it('no tokens configured -> 503, never falls back to open access', () => {
    removeAgentsYaml();
    setAuthMode('required');
    const { req, res, next } = mockReqRes();
    authenticateRest(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(req.mcpTerminal).toBeUndefined();
  });

  it('missing header -> 401 even when default_agent is configured', () => {
    writeAgentsYaml(`${YAML_WITH_TOKENS.replace('default_agent: null', 'default_agent: explorer')}`);
    setAuthMode('required');
    const { req, res, next } = mockReqRes();
    authenticateRest(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('invalid token -> 403; valid token -> identity from token', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('required');

    const bad = mockReqRes('Bearer wrong');
    authenticateRest(bad.req, bad.res, bad.next);
    expect(bad.res.statusCode).toBe(403);

    const good = mockReqRes('Bearer conductor-token');
    authenticateRest(good.req, good.res, good.next);
    expect(good.next).toHaveBeenCalled();
    expect(good.req.mcpTerminal).toBe('conductor');
  });

  it('apiAuthGate enforces auth on /api in required mode', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('required');

    const anon = mockReqRes();
    apiAuthGate(anon.req, anon.res, anon.next);
    expect(anon.next).not.toHaveBeenCalled();
    expect(anon.res.statusCode).toBe(401);

    const authed = mockReqRes('Bearer master-secret');
    apiAuthGate(authed.req, authed.res, authed.next);
    expect(authed.next).toHaveBeenCalled();
    expect(authed.req.mcpTerminal).toBe('root');
  });

  it('authenticateMcp returns JSON-RPC error shapes', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('required');

    const anon = mockReqRes();
    authenticateMcp(anon.req, anon.res, anon.next);
    expect(anon.res.statusCode).toBe(401);
    expect(anon.res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null });

    const bad = mockReqRes('Bearer wrong');
    authenticateMcp(bad.req, bad.res, bad.next);
    expect(bad.res.statusCode).toBe(403);
    expect(bad.res.body).toMatchObject({ error: { code: -32002 } });
  });
});

// ─── Config edge cases (TASK-QC-006) ─────────────────────────────────────────

describe('token loading edge cases', () => {
  it('MCP_AUTH_TOKEN env overrides the YAML master token', () => {
    process.env.MCP_AUTH_TOKEN = 'env-master';
    try {
      writeAgentsYaml(YAML_WITH_TOKENS);
      expect(getAgentFromToken('env-master')).toBe('root');
      // The YAML master token is NOT honored when the env token is set.
      expect(getAgentFromToken('master-secret')).toBeNull();
    } finally {
      delete process.env.MCP_AUTH_TOKEN;
    }
  });

  it('malformed agents.yaml falls back to env tokens only (fail closed in required mode)', () => {
    process.env.MCP_TOKEN_SOLO = 'solo-token';
    try {
      fs.writeFileSync(AGENTS_PATH, '{{{{ not yaml : [', 'utf-8');
      resetAuthStateForTests();
      setAuthMode('required');
      loadAgentTokens();
      expect(getAgentFromToken('solo-token')).toBe('solo');
      expect(getAgentFromToken('backend-token')).toBeNull();
    } finally {
      delete process.env.MCP_TOKEN_SOLO;
      removeAgentsYaml();
    }
  });

  it('reload with an unchanged mtime is a no-op (cache short-circuit)', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    loadAgentTokens(); // same mtime, tokens already loaded -> early return
    expect(getAgentFromToken('backend-token')).toBe('backend');
  });

  it('getAuthMode reflects setAuthMode overrides', () => {
    setAuthMode('open');
    expect(getAuthMode()).toBe('open');
    setAuthMode('required');
    expect(getAuthMode()).toBe('required');
  });
});

describe('getIslandForAgent (multi-island scoping)', () => {
  it('explicit mapping > default_island > service ISLAND_ID', () => {
    writeAgentsYaml(`
master_token: "master-secret"
agents:
  "backend-token": backend
  "conductor-token": conductor
agent_islands:
  backend: island-b
default_island: island-default
`);
    expect(getIslandForAgent('backend')).toBe('island-b'); // explicit
    expect(getIslandForAgent('conductor')).toBe('island-default'); // default_island

    writeAgentsYaml(YAML_WITH_TOKENS); // no islands configured at all
    // Falls back to the service's own ISLAND_ID (config/paths, default 'spaceos').
    expect(getIslandForAgent('backend')).toBeTruthy();
  });
});

describe('denial logging header handling', () => {
  it('denies identically when the client presents x-real-ip / x-forwarded-for', () => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('required');

    const realIp = mockReqRes();
    realIp.req.headers['x-real-ip'] = '198.51.100.7';
    authenticateRest(realIp.req, realIp.res, realIp.next);
    expect(realIp.res.statusCode).toBe(401);

    const fwd = mockReqRes();
    fwd.req.headers['x-forwarded-for'] = '203.0.113.5, 10.0.0.1';
    fwd.req.ip = undefined;
    authenticateRest(fwd.req, fwd.res, fwd.next);
    expect(fwd.res.statusCode).toBe(401);
  });

  it('authenticateMcp fails closed with -32000 when no tokens are configured in required mode', () => {
    removeAgentsYaml();
    setAuthMode('required');
    const { req, res, next } = mockReqRes();
    authenticateMcp(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
  });
});

describe('administrative authorization', () => {
  beforeEach(() => {
    writeAgentsYaml(YAML_WITH_TOKENS);
    setAuthMode('required');
  });

  it('allows only the master-token identity through requireRoot', () => {
    const agent = mockReqRes('Bearer backend-token');
    authenticateRest(agent.req, agent.res, () => requireRoot(agent.req, agent.res as any, agent.next));
    expect(agent.res.statusCode).toBe(403);
    expect(agent.next).not.toHaveBeenCalled();

    const root = mockReqRes('Bearer master-secret');
    authenticateRest(root.req, root.res, () => requireRoot(root.req, root.res as any, root.next));
    expect(root.next).toHaveBeenCalledOnce();
  });

  it('permits reads but protects mutations', () => {
    const read = mockReqRes();
    read.req.method = 'GET';
    requireRootForMutations(read.req, read.res as any, read.next);
    expect(read.next).toHaveBeenCalledOnce();

    const write = mockReqRes('Bearer backend-token');
    authenticateRest(write.req, write.res, () =>
      requireRootForMutations(write.req, write.res as any, write.next));
    expect(write.res.statusCode).toBe(403);
  });

  it('treats HEAD and OPTIONS as reads in requireRootForMutations', () => {
    for (const method of ['HEAD', 'OPTIONS'] as const) {
      const r = mockReqRes();
      r.req.method = method;
      requireRootForMutations(r.req, r.res as unknown as Response, r.next);
      expect(r.next).toHaveBeenCalledOnce();
      expect(r.res.statusCode).toBeNull();
    }
  });

  it('requireRoot resolves the identity itself when no upstream gate ran (open-mode wiring)', () => {
    // No req.mcpTerminal attached: requireRoot must call authenticateRest first.
    const root = mockReqRes('Bearer master-secret');
    requireRoot(root.req, root.res as unknown as Response, root.next);
    expect(root.next).toHaveBeenCalledOnce();
    expect(root.req.mcpTerminal).toBe('root');

    const agent = mockReqRes('Bearer backend-token');
    requireRoot(agent.req, agent.res as unknown as Response, agent.next);
    expect(agent.next).not.toHaveBeenCalled();
    expect(agent.res.statusCode).toBe(403);
  });
});
