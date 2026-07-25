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
import { corpusFingerprint, runGraphIndex, runIndexCli } from '../../knowledgeGraph/indexCli';
import { type ResolvedCorpus, resolveCorpus } from '../../knowledgeGraph/corpusConfig';
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

/**
 * Write a corpus config for a fixture tree and resolve it — the indexer only
 * ever runs a RESOLVED corpus, so the tests go through the same door.
 */
function writeCorpusConfig(root: string, repoRootValue: string = root): string {
  const configPath = path.join(root, 'graph-corpus.yaml');
  fs.writeFileSync(
    configPath,
    [
      'islands:',
      '  isle:',
      `    repo_root: ${JSON.stringify(repoRootValue)}`,
      '    sources:',
      '      - path: docs',
      '        extractor: markdown',
      '      - path: knowledge-service/src',
      '        extractor: typescript',
      '',
    ].join('\n'),
    'utf8'
  );
  return configPath;
}

function corpusFor(root: string): ResolvedCorpus {
  return resolveCorpus('isle', { configPath: writeCorpusConfig(root) });
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

    const stats = await runGraphIndex(corpusFor(repoRoot), 'tag-42');
    expect(stats).toEqual({ nodes: 5, relations: 4 });

    const cyphers = executeQuery.mock.calls.map((c) => String(c[0]));
    // Corpus upserts only — the index-meta MERGE deliberately runs after the
    // sweep and carries no sync tag.
    const isCorpusUpsert = (c: string) => c.includes('MERGE') && !c.includes('KnowledgeIndexMeta');
    const firstSweep = cyphers.findIndex((c) => c.includes('< $syncTag'));
    const lastUpsert = cyphers.reduce((acc, c, i) => (isCorpusUpsert(c) ? i : acc), -1);
    expect(lastUpsert).toBeGreaterThan(-1);
    expect(firstSweep).toBeGreaterThan(lastUpsert); // sweep strictly after upserts
    // Every upsert carries the tag.
    for (const [cypher, params] of executeQuery.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >) {
      if (isCorpusUpsert(String(cypher))) expect(params.syncTag).toBe('tag-42');
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

    await expect(runGraphIndex(corpusFor(repoRoot), 'tag-43')).rejects.toBeInstanceOf(
      GraphUnavailableError
    );
    const cyphers = executeQuery.mock.calls.map((c) => String(c[0]));
    // No sweep, no clear of the CORPUS. (The index fingerprint is deliberately
    // dropped before writing — that one delete is the crash guard, not a sweep.)
    const corpusDeletes = cyphers.filter(
      (c) => c.includes('DELETE') && !c.includes('KnowledgeIndexMeta')
    );
    expect(corpusDeletes).toEqual([]);
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
      await expect(runGraphIndex(corpusFor(empty), 'tag-44')).rejects.toThrow(/source root not found/);
      expect(executeQuery).not.toHaveBeenCalled(); // the island is never touched
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses to sweep when ONE source of several extracts to nothing', async () => {
    const executeQuery = vi.fn(async () => ({ records: [], summary: { counters: {} } }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    // docs/ stays but loses its only .md, while the TS tree is healthy: a
    // populated sibling must not license sweeping the empty source's subgraph.
    fs.rmSync(path.join(repoRoot, 'docs', 'knowledge', 'note.md'));
    await expect(runGraphIndex(corpusFor(repoRoot), 'tag-46')).rejects.toThrow(/refusing to sweep/);
    expect(executeQuery.mock.calls.some((c) => String(c[0]).includes('DELETE'))).toBe(false);
  });

  it('refuses to sweep a corpus with no sources at all', async () => {
    const executeQuery = vi.fn(async () => ({ records: [], summary: { counters: {} } }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    // Unreachable through the config schema (min 1 source), reachable via API.
    await expect(
      runGraphIndex({ island: 'isle', repoRoot, sources: [] }, 'tag-47')
    ).rejects.toThrow(/no sources/);
    expect(executeQuery).not.toHaveBeenCalled();
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
      await expect(runGraphIndex(corpusFor(bare), 'tag-45')).rejects.toThrow(/refusing to sweep/);
      expect(executeQuery.mock.calls.some((c) => String(c[0]).includes('DELETE'))).toBe(false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

/** Driver that can answer the index-meta read with a stored fingerprint. */
function driverWithMeta(storedHash: string | null) {
    const executeQuery = vi.fn(async (cypher: string) => {
      const text = String(cypher);
      if (text.includes('KnowledgeIndexMeta') && text.includes('RETURN m')) {
        return {
          records:
            storedHash === null
              ? []
              : [
                  {
                    get: () => ({
                      properties: {
                        corpusHash: storedHash,
                        indexedAt: '2026-07-25T00:00:00.000Z',
                        nodes: 42,
                        relations: 7,
                      },
                    }),
                  },
                ],
          summary: {},
        };
      }
      return {
        records: text.includes('count(DISTINCT n)') ? [statsRecord] : [],
        summary: { counters: {} },
      };
    });
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);
    return { executeQuery };
  }

describe('incremental re-index (--if-changed)', () => {
  it('is content-addressed: the fingerprint changes with the extraction result', () => {
    const base = corpusFingerprint(
      [{ id: 'a.ts', type: 'Module', name: 'a' }],
      [{ from: 'a.ts', to: 'b.ts', type: 'DEPENDS_ON' }]
    );
    expect(
      corpusFingerprint(
        [{ id: 'a.ts', type: 'Module', name: 'a' }],
        [{ from: 'a.ts', to: 'b.ts', type: 'DEPENDS_ON' }]
      )
    ).toBe(base); // same input, same digest — otherwise nothing could be skipped
    expect(
      corpusFingerprint(
        [{ id: 'a.ts', type: 'Module', name: 'RENAMED' }],
        [{ from: 'a.ts', to: 'b.ts', type: 'DEPENDS_ON' }]
      )
    ).not.toBe(base); // a renamed entity is a change, not just its id
    expect(corpusFingerprint([{ id: 'a.ts', type: 'Module', name: 'a' }], [])).not.toBe(base);
    // Every field that reaches the graph must move the digest, or a change to
    // it would be invisible to --if-changed.
    const variants = [
      { id: 'OTHER.ts', type: 'Module' as const, name: 'a' },
      { id: 'a.ts', type: 'Doc' as const, name: 'a' },
      { id: 'a.ts', type: 'Module' as const, name: 'a', language: 'typescript' as const },
    ];
    for (const entity of variants) {
      expect(
        corpusFingerprint([entity], [{ from: 'a.ts', to: 'b.ts', type: 'DEPENDS_ON' }])
      ).not.toBe(base);
    }
    expect(
      corpusFingerprint(
        [{ id: 'a.ts', type: 'Module', name: 'a' }],
        [{ from: 'a.ts', to: 'b.ts', type: 'REFERENCES' }]
      )
    ).not.toBe(base);
    // Order must NOT matter: the same corpus indexed from two hosts whose path
    // sort differs has to produce the same digest.
    const two = [
      { id: 'a.ts', type: 'Module' as const, name: 'a' },
      { id: 'b.ts', type: 'Module' as const, name: 'b' },
    ];
    expect(corpusFingerprint([...two].reverse(), [])).toBe(corpusFingerprint(two, []));
  });

  it('writes nothing when the corpus fingerprint already matches', async () => {
    // First run to learn what this fixture hashes to.
    const first = driverWithMeta(null);
    await runGraphIndex(corpusFor(repoRoot), 'tag-50');
    const metaWrite = first.executeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE (m:KnowledgeIndexMeta')
    )?.[1] as { corpusHash: string };
    expect(metaWrite.corpusHash).toMatch(/^[a-f0-9]{64}$/);

    resetGraphStoreForTests();
    const second = driverWithMeta(metaWrite.corpusHash);
    const result = await runGraphIndex(corpusFor(repoRoot), 'tag-51', { skipIfUnchanged: true });

    expect(result.skipped).toBe(true);
    expect(result.nodes).toBe(42); // reported from the stored meta
    const cyphers = second.executeQuery.mock.calls.map((c) => String(c[0]));
    // The point of the flag: no upsert, no sweep, no meta rewrite.
    expect(cyphers.some((c) => c.includes('MERGE (n:KnowledgeEntity'))).toBe(false);
    expect(cyphers.some((c) => c.includes('DELETE'))).toBe(false);
    expect(cyphers.some((c) => c.includes('MERGE (m:KnowledgeIndexMeta'))).toBe(false);
  });

  it('indexes normally when the stored fingerprint differs', async () => {
    const { executeQuery } = driverWithMeta('a-different-hash');
    const result = await runGraphIndex(corpusFor(repoRoot), 'tag-52', { skipIfUnchanged: true });
    expect(result.skipped).toBeUndefined();
    const cyphers = executeQuery.mock.calls.map((c) => String(c[0]));
    expect(cyphers.some((c) => c.includes('MERGE (n:KnowledgeEntity'))).toBe(true);
    expect(cyphers.some((c) => c.includes('MERGE (m:KnowledgeIndexMeta'))).toBe(true);
  });

  it('records the fingerprint only AFTER the graph actually holds the data', async () => {
    const executeQuery = vi.fn(async (cypher: string) => {
      if (String(cypher).includes('MERGE (n:KnowledgeEntity')) throw new Error('write failed');
      return { records: [], summary: { counters: {} } };
    });
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    await expect(runGraphIndex(corpusFor(repoRoot), 'tag-53')).rejects.toBeInstanceOf(
      GraphUnavailableError
    );
    // A fingerprint stored before a failed write would make the NEXT
    // --if-changed run skip a graph that never received the data.
    expect(
      executeQuery.mock.calls.some((c) => String(c[0]).includes('MERGE (m:KnowledgeIndexMeta'))
    ).toBe(false);
    // And the OLD fingerprint must be gone too: without this, reverting the
    // corpus after a failed run reads as "up to date" over a mutated graph.
    const cyphers = executeQuery.mock.calls.map((c) => String(c[0]));
    const invalidation = cyphers.findIndex((c) => c.includes('KnowledgeIndexMeta') && c.includes('DELETE'));
    const firstUpsert = cyphers.findIndex((c) => c.includes('MERGE (n:KnowledgeEntity'));
    expect(invalidation).toBeGreaterThan(-1);
    expect(invalidation).toBeLessThan(firstUpsert);
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

  /** The CLI resolves its corpus from the config — point it at the fixture. */
  function cliArgs(extra: string[] = []): string[] {
    return [
      'node',
      'indexCli.ts',
      '--island',
      'isle',
      '--config',
      writeCorpusConfig(repoRoot),
      ...extra,
    ];
  }

  it('indexes the island from --island and exits 0', async () => {
    const { close, executeQuery } = fakeDriver();
    const code = await runIndexCli(cliArgs());
    expect(code).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    const params = executeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE')
    )?.[1] as Record<string, unknown>;
    expect((params.rows as Array<{ island: string }>)[0].island).toBe('isle');
  });

  it('exits 1 when indexing fails — and still closes the driver', async () => {
    const { close } = fakeDriver({ failUpsert: true });
    const code = await runIndexCli(cliArgs());
    expect(code).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps exit 0 when only the driver close fails', async () => {
    const { close } = fakeDriver({ failClose: true });
    const code = await runIndexCli(cliArgs());
    expect(code).toBe(0); // close trouble must not fake an index failure
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('honours --if-changed end to end, and stays a FULL index without it', async () => {
    // Learn the fixture's fingerprint from a first, normal run.
    const learner = driverWithMeta(null);
    expect(await runIndexCli(cliArgs())).toBe(0);
    const learned = learner.executeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE (m:KnowledgeIndexMeta')
    )?.[1] as { corpusHash: string };
    resetGraphStoreForTests();

    // With the flag: the write is skipped.
    const auto = driverWithMeta(learned.corpusHash);
    expect(await runIndexCli(cliArgs(['--if-changed']))).toBe(0);
    const autoCyphers = auto.executeQuery.mock.calls.map((c) => String(c[0]));
    expect(autoCyphers.some((c) => c.includes('MERGE (n:KnowledgeEntity'))).toBe(false);
    resetGraphStoreForTests();

    // WITHOUT the flag: still a full index — this is the operator's escape
    // hatch when the graph and the fingerprint have drifted apart.
    const manual = driverWithMeta(learned.corpusHash);
    expect(await runIndexCli(cliArgs())).toBe(0);
    const manualCyphers = manual.executeQuery.mock.calls.map((c) => String(c[0]));
    expect(manualCyphers.some((c) => c.includes('MERGE (n:KnowledgeEntity'))).toBe(true);
  });

  it('exits 1 when the island has no corpus configured', async () => {
    const { executeQuery } = fakeDriver();
    const code = await runIndexCli([
      'node',
      'indexCli.ts',
      '--island',
      'unknown-isle',
      '--config',
      writeCorpusConfig(repoRoot),
    ]);
    expect(code).toBe(1); // fail-closed: an unconfigured island is never indexed
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('honours --repo-root over the configured repo_root', async () => {
    const { executeQuery } = fakeDriver();
    // repo_root '.' would point at the nexus-dev checkout; the override wins.
    const configPath = writeCorpusConfig(repoRoot, '.');
    const code = await runIndexCli([
      'node',
      'indexCli.ts',
      '--island',
      'isle',
      '--config',
      configPath,
      '--repo-root',
      repoRoot,
    ]);
    expect(code).toBe(0);
    const params = executeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE')
    )?.[1] as { rows: Array<{ id: string }> };
    expect(params.rows.map((row) => row.id)).toContain('docs/knowledge/note.md');
  });
});
