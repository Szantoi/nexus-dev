/**
 * runGraphIndex tests — upsert-then-sweep ordering is the crash-safety
 * contract: a failed run must leave the previous graph untouched (no sweep),
 * a successful run sweeps exactly once, after every upsert batch.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver-lite';
import { runGraphIndex, runIndexCli } from '../../knowledgeGraph/indexCli';
import {
  GraphUnavailableError,
  resetGraphStoreForTests,
  setGraphDriverForTests,
} from '../../knowledgeGraph/graphStore';

let repoRoot: string;

function write(relPath: string, content: string): void {
  const abs = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-index-'));
  write('docs/knowledge/note.md', 'a note');
  write('knowledge-service/src/a.ts', "import { b } from './b';\n");
  write('knowledge-service/src/b.ts', 'export const b = 1;\n');
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  resetGraphStoreForTests();
  vi.restoreAllMocks();
});

const statsRecord = {
  get(field: string) {
    if (field === 'nodes') return 5;
    if (field === 'relations') return 4;
    return undefined;
  },
};

describe('runGraphIndex', () => {
  it('upserts everything with the sync tag and sweeps ONLY afterwards', async () => {
    const executeQuery = vi.fn(async (cypher: string) => ({
      records: String(cypher).includes('count(DISTINCT n)') ? [statsRecord] : [],
      summary: { counters: {} },
    }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    const stats = await runGraphIndex('isle', repoRoot, 'tag-42');
    expect(stats).toEqual({ nodes: 5, relations: 4 });

    const cyphers = executeQuery.mock.calls.map((c) => String(c[0]));
    const firstSweep = cyphers.findIndex((c) => c.includes('< $syncTag'));
    const lastUpsert = cyphers.reduce(
      (acc, c, i) => (c.includes('MERGE') ? i : acc),
      -1
    );
    expect(firstSweep).toBeGreaterThan(lastUpsert); // sweep strictly after upserts
    // Every upsert carries the tag.
    for (const [cypher, params] of executeQuery.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >) {
      if (String(cypher).includes('MERGE')) expect(params.syncTag).toBe('tag-42');
    }
    // Old-graph destruction never happens up front.
    expect(cyphers.some((c) => c.includes('DETACH DELETE') && !c.includes('$syncTag'))).toBe(
      false
    );
  });

  it('leaves the previous graph unswept when an upsert batch fails', async () => {
    const executeQuery = vi.fn(async (cypher: string) => {
      if (String(cypher).includes('MERGE')) throw new Error('neo4j heap hiccup');
      return { records: [], summary: { counters: {} } };
    });
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    await expect(runGraphIndex('isle', repoRoot, 'tag-43')).rejects.toBeInstanceOf(
      GraphUnavailableError
    );
    const cyphers = executeQuery.mock.calls.map((c) => String(c[0]));
    expect(cyphers.some((c) => c.includes('DELETE'))).toBe(false); // no sweep, no clear
  });

  it('refuses to index a repo root without the expected source trees', async () => {
    const executeQuery = vi.fn(async () => ({ records: [], summary: { counters: {} } }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-empty-'));
    try {
      // A mistyped --repo-root must not look like "the repo lost its content".
      await expect(runGraphIndex('isle', empty, 'tag-44')).rejects.toThrow(/source root not found/);
      expect(executeQuery).not.toHaveBeenCalled(); // the island is never touched
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses to sweep when the corpus extracts to nothing', async () => {
    const executeQuery = vi.fn(async () => ({ records: [], summary: { counters: {} } }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    // Both roots exist but hold no indexable files (unreadable dirs degrade to
    // the same state) — sweeping here would silently empty the island.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-bare-'));
    fs.mkdirSync(path.join(bare, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(bare, 'knowledge-service', 'src'), { recursive: true });
    try {
      await expect(runGraphIndex('isle', bare, 'tag-45')).rejects.toThrow(/refusing to sweep/);
      expect(executeQuery.mock.calls.some((c) => String(c[0]).includes('DELETE'))).toBe(false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('runIndexCli', () => {
  function fakeDriver(overrides: { failUpsert?: boolean; failClose?: boolean } = {}) {
    const close = vi.fn(async () => {
      if (overrides.failClose === true) throw new Error('socket already gone');
    });
    const executeQuery = vi.fn(async (cypher: string) => {
      if (overrides.failUpsert === true && String(cypher).includes('MERGE'))
        throw new Error('neo4j heap hiccup');
      return {
        records: String(cypher).includes('count(DISTINCT n)') ? [statsRecord] : [],
        summary: { counters: {} },
      };
    });
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close,
    } as unknown as Driver);
    return { close, executeQuery };
  }

  it('indexes the island from --island and exits 0', async () => {
    const { close, executeQuery } = fakeDriver();
    const code = await runIndexCli(['node', 'indexCli.ts', '--island', 'isle', '--repo-root', repoRoot]);
    expect(code).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    const params = executeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE')
    )?.[1] as Record<string, unknown>;
    expect((params.rows as Array<{ island: string }>)[0].island).toBe('isle');
  });

  it('exits 1 when indexing fails — and still closes the driver', async () => {
    const { close } = fakeDriver({ failUpsert: true });
    const code = await runIndexCli(['node', 'indexCli.ts', '--island', 'isle', '--repo-root', repoRoot]);
    expect(code).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps exit 0 when only the driver close fails', async () => {
    const { close } = fakeDriver({ failClose: true });
    const code = await runIndexCli(['node', 'indexCli.ts', '--island', 'isle', '--repo-root', repoRoot]);
    expect(code).toBe(0); // close trouble must not fake an index failure
    expect(close).toHaveBeenCalledTimes(1);
  });
});
