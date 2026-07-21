/**
 * TASK-QC-007 — Central config layer regression tests.
 *
 * Covers:
 *  - fail-fast validation of scalar env config (parseEnv / EnvValidationError)
 *  - preserved flag semantics (only the literal 'true' enables; opt-out flags)
 *  - empty-string env values behaving as "unset"
 *  - platform-independent path derivation (POSIX and Windows style roots,
 *    bare checkout defaults) in config/paths.ts
 *  - lazy secret accessors observing runtime env mutations
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'node:path';

// Env vars this suite touches — saved and restored around every test so
// nothing leaks into other test files sharing this worker process.
const TOUCHED = [
  'SPACEOS_ROOT',
  'TERMINALS_PATH',
  'TERMINALS_DIR',
  'EPICS_PATH',
  'PROJECTS_DIR',
  'PLANNING_FOCUS_PATH',
  'KNOWLEDGE_SERVICE_URL',
  'PORT',
  'ADMIN_SECRET',
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of TOUCHED) saved[k] = process.env[k];

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function freshPaths() {
  vi.resetModules();
  return await import('../../config/paths');
}

async function freshEnv() {
  vi.resetModules();
  return await import('../../config/env');
}

describe('parseEnv — fail-fast scalar validation', () => {
  it('throws a readable EnvValidationError for a non-numeric PORT', async () => {
    const { parseEnv, EnvValidationError } = await import('../../config/env');
    expect(() => parseEnv({ PORT: 'not-a-number' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ PORT: 'not-a-number' })).toThrow(/PORT/);
  });

  it('rejects an out-of-range TRUST_PROXY_HOPS', async () => {
    const { parseEnv } = await import('../../config/env');
    expect(() => parseEnv({ TRUST_PROXY_HOPS: '99' })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('rejects an invalid AUTH_MODE enum value', async () => {
    const { parseEnv } = await import('../../config/env');
    expect(() => parseEnv({ AUTH_MODE: 'maybe' })).toThrow(/AUTH_MODE/);
  });

  it('applies secure defaults on an empty environment', async () => {
    const { parseEnv } = await import('../../config/env');
    const env = parseEnv({});
    expect(env.PORT).toBe(3456);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.AUTH_MODE).toBe('required');
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });

  it('treats empty-string values as unset (defaults apply)', async () => {
    const { parseEnv } = await import('../../config/env');
    const env = parseEnv({ REVIEW_MODE: '', PORT: '' });
    expect(env.REVIEW_MODE).toBe('api');
    expect(env.PORT).toBe(3456);
  });
});

describe('parseEnv — feature flag semantics preserved', () => {
  it("only the literal 'true' enables an opt-in flag", async () => {
    const { parseEnv } = await import('../../config/env');
    expect(parseEnv({}).ENABLE_NIGHTWATCH).toBe(false);
    expect(parseEnv({ ENABLE_NIGHTWATCH: 'true' }).ENABLE_NIGHTWATCH).toBe(true);
    expect(parseEnv({ ENABLE_NIGHTWATCH: '1' }).ENABLE_NIGHTWATCH).toBe(false);
  });

  it("opt-out flags stay on unless explicitly 'false'", async () => {
    const { parseEnv } = await import('../../config/env');
    expect(parseEnv({}).ENABLE_HOURLY_DIGEST).toBe(true);
    expect(parseEnv({ ENABLE_HOURLY_DIGEST: 'false' }).ENABLE_HOURLY_DIGEST).toBe(false);
    expect(parseEnv({}).PRE_REVIEW_ENABLED).toBe(true);
    expect(parseEnv({ PRE_REVIEW_ENABLED: 'false' }).PRE_REVIEW_ENABLED).toBe(false);
  });

  it('rejects a non-numeric scheduler interval instead of yielding NaN', async () => {
    const { parseEnv } = await import('../../config/env');
    expect(() => parseEnv({ NIGHTWATCH_INTERVAL: 'often' })).toThrow(/NIGHTWATCH_INTERVAL/);
    expect(parseEnv({ NIGHTWATCH_INTERVAL: '5000' }).NIGHTWATCH_INTERVAL).toBe(5000);
  });
});

describe('config/paths — platform-independent derivation', () => {
  it('derives the SpaceOS tree from a POSIX-style SPACEOS_ROOT', async () => {
    process.env.SPACEOS_ROOT = '/srv/testos';
    delete process.env.EPICS_PATH;
    delete process.env.PROJECTS_DIR;
    delete process.env.TERMINALS_PATH;
    delete process.env.TERMINALS_DIR;
    const paths = await freshPaths();
    expect(paths.SPACEOS_ROOT).toBe('/srv/testos');
    expect(paths.getEpicsPath()).toBe(
      path.join('/srv/testos', 'docs', 'projects', 'EPICS.yaml'),
    );
    expect(paths.getTerminalsPath()).toBe(path.join('/srv/testos', 'terminals'));
    expect(paths.getProjectsDir()).toBe(path.join('/srv/testos', 'docs', 'projects'));
  });

  it('derives the SpaceOS tree from a Windows-style SPACEOS_ROOT', async () => {
    process.env.SPACEOS_ROOT = 'C:\\nexus\\live';
    delete process.env.EPICS_PATH;
    delete process.env.PROJECTS_DIR;
    delete process.env.TERMINALS_PATH;
    delete process.env.TERMINALS_DIR;
    const paths = await freshPaths();
    expect(paths.getEpicsPath()).toBe(
      path.join('C:\\nexus\\live', 'docs', 'projects', 'EPICS.yaml'),
    );
    expect(paths.getPlanningFocusPath()).toBe(
      path.join('C:\\nexus\\live', 'docs', 'planning', 'domain-focus.md'),
    );
  });

  it('falls back to the checkout root on a bare checkout (no /opt hardcode)', async () => {
    delete process.env.SPACEOS_ROOT;
    delete process.env.TERMINALS_PATH;
    delete process.env.TERMINALS_DIR;
    const paths = await freshPaths();
    expect(path.isAbsolute(paths.SPACEOS_ROOT)).toBe(true);
    // The derived root is the directory containing knowledge-service.
    // Equality with the checkout root proves the default is derived from the
    // code location, not from a hardcoded host path.
    expect(paths.SPACEOS_ROOT).toBe(path.resolve(paths.KNOWLEDGE_SERVICE_ROOT, '..'));
    expect(paths.getTerminalsPath()).toBe(path.join(paths.SPACEOS_ROOT, 'terminals'));
  });

  it('explicit path overrides always win over derivation', async () => {
    process.env.SPACEOS_ROOT = '/srv/testos';
    process.env.EPICS_PATH = '/somewhere/else/EPICS.yaml';
    process.env.TERMINALS_PATH = '/data/terminals';
    const paths = await freshPaths();
    expect(paths.getEpicsPath()).toBe('/somewhere/else/EPICS.yaml');
    expect(paths.getTerminalsPath()).toBe('/data/terminals');
  });

  it('recognizes the TERMINALS_DIR legacy alias', async () => {
    delete process.env.TERMINALS_PATH;
    process.env.TERMINALS_DIR = '/legacy/terminals';
    const paths = await freshPaths();
    expect(paths.getTerminalsPath()).toBe('/legacy/terminals');
  });
});

describe('config/env — derived URLs and lazy secrets', () => {
  it('SELF_BASE_URL derives from PORT (loopback) by default', async () => {
    process.env.PORT = '3466';
    delete process.env.KNOWLEDGE_SERVICE_URL;
    const cfg = await freshEnv();
    expect(cfg.SELF_BASE_URL).toBe('http://127.0.0.1:3466');
  });

  it('KNOWLEDGE_SERVICE_URL override wins for self-calls', async () => {
    process.env.KNOWLEDGE_SERVICE_URL = 'http://10.0.0.5:3456';
    const cfg = await freshEnv();
    expect(cfg.SELF_BASE_URL).toBe('http://10.0.0.5:3456');
    expect(cfg.MCP_SERVER_URL).toBe('http://10.0.0.5:3456/mcp');
  });

  it('secrets accessor reads process.env lazily (runtime reload support)', async () => {
    delete process.env.ADMIN_SECRET;
    const cfg = await freshEnv();
    expect(cfg.secrets.adminSecret).toBeUndefined();
    process.env.ADMIN_SECRET = 'runtime-set-secret';
    expect(cfg.secrets.adminSecret).toBe('runtime-set-secret');
  });
});
