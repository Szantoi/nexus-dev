/**
 * Multi-island scoping tests.
 * PINS the security contract of one-service-many-islands: the island is
 * derived from the caller's IDENTITY via server-side config — never from
 * client input — and island ids are validated before becoming collection
 * names. Also pins backward compatibility: no island → the default island.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';

const AGENTS_PATH = vi.hoisted(() => {
  const runId = require('crypto').randomBytes(6).toString('hex');
  const p = require('path').join(require('os').tmpdir(), `island-auth-${runId}.yaml`);
  process.env.AGENTS_CONFIG_PATH = p;
  process.env.ISLAND_ID = 'nexus-dev'; // service's own island
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.AUTH_MODE;
  delete process.env.COLLECTION_NAME;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MCP_TOKEN_')) delete process.env[key];
  }
  return p;
});

import {
  loadAgentTokens,
  getIslandForAgent,
  resetAuthStateForTests,
  authenticateRest,
  setAuthMode,
} from '../../auth/tokenAuth';
import {
  DEFAULT_ISLAND,
  collectionNameForIsland,
  searchKnowledge,
  UnknownIslandError,
} from '../../vectorStore';

function writeAgentsYaml(content: string): void {
  fs.writeFileSync(AGENTS_PATH, content, 'utf-8');
  resetAuthStateForTests();
  loadAgentTokens();
}

function mockReqRes(authHeader?: string) {
  const req: any = {
    headers: authHeader ? { authorization: authHeader } : {},
    method: 'GET',
    originalUrl: '/api/x',
    ip: '127.0.0.1',
  };
  const res: any = {
    statusCode: null,
    body: null,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return { req, res, next: vi.fn() };
}

const YAML = `
master_token: "master-tok"
agents:
  "backend-tok": backend
  "doorstar-tok": doorstar-dev
  "stranger-tok": stranger
agent_islands:
  backend: nexus-dev
  doorstar-dev: doorstar
default_island: nexus-dev
`;

afterAll(() => {
  if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  resetAuthStateForTests();
});

// ─── Identity → island ───────────────────────────────────────────────────────

describe('getIslandForAgent', () => {
  beforeEach(() => writeAgentsYaml(YAML));

  it('maps agents to their configured island', () => {
    expect(getIslandForAgent('backend')).toBe('nexus-dev');
    expect(getIslandForAgent('doorstar-dev')).toBe('doorstar');
  });

  it('falls back to default_island for agents with no explicit island', () => {
    expect(getIslandForAgent('stranger')).toBe('nexus-dev');
  });

  it('falls back to the service island when no default_island is configured', () => {
    writeAgentsYaml(YAML.replace('default_island: nexus-dev', ''));
    expect(getIslandForAgent('stranger')).toBe(DEFAULT_ISLAND);
  });

  it('attaches the island to the request from the TOKEN, not from client input', () => {
    setAuthMode('required');
    const { req, res, next } = mockReqRes('Bearer doorstar-tok');
    // A client trying to claim another island gets ignored: only the token counts.
    req.query = { island: 'spaceos' };
    req.body = { island: 'spaceos' };
    authenticateRest(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.mcpTerminal).toBe('doorstar-dev');
    expect(req.mcpIsland).toBe('doorstar'); // NOT 'spaceos'
    setAuthMode('open');
  });
});

// ─── Collection naming ───────────────────────────────────────────────────────

describe('collectionNameForIsland', () => {
  it('derives <island>-knowledge per island', () => {
    expect(collectionNameForIsland('doorstar')).toBe('doorstar-knowledge');
    expect(collectionNameForIsland('spaceos')).toBe('spaceos-knowledge');
  });

  it('keeps the default island on its configured collection name', () => {
    expect(collectionNameForIsland(DEFAULT_ISLAND)).toBe(`${DEFAULT_ISLAND}-knowledge`);
  });
});

// ─── Island id validation (collection-name injection guard) ──────────────────

describe('island id validation', () => {
  it('rejects ids that could escape the collection namespace', async () => {
    for (const bad of ['../spaceos', 'UPPER', 'has space', 'semi;colon', '-leading', '']) {
      await expect(searchKnowledge('q', 5, bad)).rejects.toThrowError(UnknownIslandError);
    }
  });

  it('accepts well-formed island ids', async () => {
    // No ChromaDB in unit tests → in-memory fallback returns [] rather than throwing.
    await expect(searchKnowledge('q', 5, 'doorstar')).resolves.toEqual([]);
    await expect(searchKnowledge('q', 5, 'nexus-dev')).resolves.toEqual([]);
  });
});
