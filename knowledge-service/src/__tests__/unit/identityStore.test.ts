/**
 * identity.ts unit tests (TASK-QC-006).
 *
 * PINS the terminal identity/memory contract:
 *  - identity is resolved through terminalConfig (unknown terminal => error),
 *  - CLAUDE.md / MEMORY.md are optional (missing file => null, never a throw),
 *  - memory writes/appends land in the terminal's own directory,
 *  - capability listing is category-filterable.
 *
 * Hermetic: TERMINALS_PATH points to a per-run temp tree created here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'node:path';
import * as fsSync from 'node:fs';

// NOTE: config-tree caveat — config/terminals.yaml hardcodes /opt directories
// for backend/frontend/designer/..., so this suite uses terminals WITHOUT an
// explicit directory (conductor, librarian): their paths derive from
// TERMINALS_PATH and stay inside the temp tree below.
const TERMINALS_ROOT = vi.hoisted(() => {
  const runId = require('crypto').randomBytes(6).toString('hex');
  const root = require('path').join(require('os').tmpdir(), `identity-terminals-${runId}`);
  process.env.TERMINALS_PATH = root;
  delete process.env.TERMINALS_DIR;
  return root as string;
});

import * as identity from '../../identity';

beforeAll(() => {
  fsSync.mkdirSync(path.join(TERMINALS_ROOT, 'conductor'), { recursive: true });
  fsSync.mkdirSync(path.join(TERMINALS_ROOT, 'librarian'), { recursive: true });
  fsSync.writeFileSync(
    path.join(TERMINALS_ROOT, 'conductor', 'CLAUDE.md'),
    '# Backend terminal\nRole: API development.\n',
  );
  fsSync.writeFileSync(
    path.join(TERMINALS_ROOT, 'conductor', 'MEMORY.md'),
    '# Memory\n- port is 3466 in DEV\n',
  );
});

afterAll(() => {
  fsSync.rmSync(TERMINALS_ROOT, { recursive: true, force: true });
});

describe('getIdentity', () => {
  it('returns CLAUDE.md and MEMORY.md content for a known terminal', async () => {
    const id = await identity.getIdentity('conductor');
    expect(id.terminal).toBe('conductor');
    expect(id.claudeMd).toContain('Backend terminal');
    expect(id.memory).toContain('port is 3466');
    expect(id.path).toContain('conductor');
    expect(id.memoryPath.endsWith('MEMORY.md')).toBe(true);
  });

  it('missing identity files yield null instead of an error', async () => {
    const id = await identity.getIdentity('librarian');
    expect(id.claudeMd).toBeNull();
    expect(id.memory).toBeNull();
  });

  it('rejects an unknown terminal with the list of valid names', async () => {
    await expect(identity.getIdentity('not-a-terminal')).rejects.toThrow(/Unknown terminal/);
  });
});

describe('listTerminals', () => {
  it('reports file presence and primary flags for every configured terminal', async () => {
    const all = await identity.listTerminals();
    expect(all.length).toBeGreaterThan(0);

    const conductor = all.find((t) => t.terminal === 'conductor');
    expect(conductor).toBeTruthy();
    expect(conductor?.hasClaudeMd).toBe(true);
    expect(conductor?.hasMemory).toBe(true);

    const librarian = all.find((t) => t.terminal === 'librarian');
    expect(librarian?.hasClaudeMd).toBe(false);
    expect(librarian?.hasMemory).toBe(false);

    for (const t of all) expect(typeof t.isPrimary).toBe('boolean');
  });
});

describe('memory read/write/append', () => {
  it('readMemory returns content, null when absent, error when terminal is unknown', async () => {
    expect(await identity.readMemory('conductor')).toContain('port is 3466');
    expect(await identity.readMemory('librarian')).toBeNull();
    await expect(identity.readMemory('bogus')).rejects.toThrow(/Unknown terminal/);
  });

  it('writeMemory replaces the file inside the terminal directory', async () => {
    const r = await identity.writeMemory('librarian', '# Fresh memory\n');
    expect(r.success).toBe(true);
    expect(r.path).toBe(path.join(TERMINALS_ROOT, 'librarian', 'MEMORY.md'));
    expect(fsSync.readFileSync(r.path, 'utf-8')).toBe('# Fresh memory\n');
    await expect(identity.writeMemory('bogus', 'x')).rejects.toThrow(/Unknown terminal/);
  });

  it('appendMemory adds a dated separator block (and works on a missing file too)', async () => {
    await identity.writeMemory('librarian', '# Base\n');
    const r = await identity.appendMemory('librarian', 'new learning');
    expect(r.success).toBe(true);
    const content = fsSync.readFileSync(r.path, 'utf-8');
    expect(content).toContain('# Base');
    expect(content).toContain('---');
    expect(content).toMatch(/_Updated: \d{4}-\d{2}-\d{2}_/);
    expect(content.trim().endsWith('new learning')).toBe(true);

    // Append with no pre-existing file starts from empty content.
    fsSync.rmSync(path.join(TERMINALS_ROOT, 'librarian', 'MEMORY.md'));
    const r2 = await identity.appendMemory('librarian', 'first note');
    expect(fsSync.readFileSync(r2.path, 'utf-8')).toContain('first note');
    await expect(identity.appendMemory('bogus', 'x')).rejects.toThrow(/Unknown terminal/);
  });
});

describe('capabilities', () => {
  it('lists all capabilities and filters by category', () => {
    const all = identity.getCapabilities();
    expect(all.length).toBeGreaterThan(10);
    const mailbox = identity.getCapabilities('mailbox');
    expect(mailbox.length).toBeGreaterThan(0);
    expect(mailbox.every((c) => c.category === 'mailbox')).toBe(true);
    expect(identity.getCapabilities('no-such-category')).toEqual([]);
  });
});
