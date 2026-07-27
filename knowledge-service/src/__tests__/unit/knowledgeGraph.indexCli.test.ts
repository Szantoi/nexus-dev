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

/**
 * The machine-independent meta key of the env-gated coverage source: the
 * LITERAL '${...}' declared path, not a template placeholder — assembled by
 * concatenation so the linter's template-curly heuristic stays quiet.
 */
const GATED_COVERAGE_KEY = ['coverage:$', '{NEXUS_COVERAGE_ROOT}'].join('');

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
      runGraphIndex({ island: 'isle', repoRoot, sources: [], skippedSources: [] }, 'tag-47')
    ).rejects.toThrow(/no sources/);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('scopes the relation sweep to the corpus extractors\' declared types', async () => {
    const executeQuery = vi.fn(async (cypher: string) => ({
      records: String(cypher).includes('count(DISTINCT n)') ? [statsRecord] : [],
      summary: { counters: {} },
    }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    await runGraphIndex(corpusFor(repoRoot), 'tag-60');
    const sweep = executeQuery.mock.calls.find((c) =>
      String(c[0]).includes("coalesce(r.syncedAt, '') < $syncTag DELETE r")
    ) as unknown as [string, { types: string[] }];
    expect(sweep).toBeDefined();
    // markdown + typescript own exactly these — COVERS (another machine's
    // coverage source) must never be in a docs+src run's sweep scope.
    expect(sweep[1].types).toEqual(['DEPENDS_ON', 'PART_OF', 'REFERENCES']);
  });

  it('fails closed when an extractor emits an undeclared relation type', async () => {
    const executeQuery = vi.fn(async () => ({ records: [], summary: { counters: {} } }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    // An undeclared type would be upserted but never swept: permanently stale
    // edges presented as live data. The run must refuse instead.
    const rogue = {
      island: 'isle',
      repoRoot,
      skippedSources: [],
      sources: [
        {
          root: path.join(repoRoot, 'docs'),
          declaredPath: 'docs',
          extractor: 'markdown' as const,
          extract: () => ({
            entities: [{ id: 'docs/a.md', type: 'Doc' as const, name: 'a' }],
            relations: [{ from: 'docs/a.md', to: 'docs/b.md', type: 'COVERS' as const }],
          }),
        },
      ],
    };
    await expect(runGraphIndex(rogue, 'tag-61')).rejects.toThrow(/undeclared relation type/);
    expect(
      executeQuery.mock.calls.some((c) => String(c[0]).includes('MERGE (n:KnowledgeEntity'))
    ).toBe(false);
  });

  it('skips an env-gated source explicitly and keeps its types out of the sweep', async () => {
    const executeQuery = vi.fn(async (cypher: string) => ({
      records: String(cypher).includes('count(DISTINCT n)') ? [statsRecord] : [],
      summary: { counters: {} },
    }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    const configPath = path.join(repoRoot, 'gated-corpus.yaml');
    fs.writeFileSync(
      configPath,
      [
        'islands:',
        '  isle:',
        `    repo_root: ${JSON.stringify(repoRoot)}`,
        '    sources:',
        '      - path: docs',
        '        extractor: markdown',
        `      - path: "${['$', '{KG_TEST_UNSET_COVERAGE_ROOT}'].join('')}"`,
        '        extractor: coverage',
        '',
      ].join('\n'),
      'utf8'
    );
    delete process.env.KG_TEST_UNSET_COVERAGE_ROOT;
    const corpus = resolveCorpus('isle', { configPath });
    expect(corpus.skippedSources).toEqual([
      {
        declaredPath: ['$', '{KG_TEST_UNSET_COVERAGE_ROOT}'].join(''),
        extractor: 'coverage',
        variable: 'KG_TEST_UNSET_COVERAGE_ROOT',
      },
    ]);

    await runGraphIndex(corpus, 'tag-62');
    const sweep = executeQuery.mock.calls.find((c) =>
      String(c[0]).includes("coalesce(r.syncedAt, '') < $syncTag DELETE r")
    ) as unknown as [string, { types: string[] }];
    // The skipped coverage source's COVERS type is NOT swept — this is the
    // invariant that lets the VPS timer run without deleting the dev
    // machine's test→code edges.
    expect(sweep[1].types).toEqual(['REFERENCES']);
  });

  it('drops a gated source\'s orphans — edges may only attach to durable entities', async () => {
    const executeQuery = vi.fn(async (cypher: string) => ({
      records: String(cypher).includes('count(DISTINCT n)') ? [statsRecord] : [],
      summary: { counters: {} },
    }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    // The gated source links one entity the unconditional source owns
    // ('src/a.ts') and one it does NOT ('vitest.config.ts') — the orphan and
    // both its edges must be dropped, or the next docs+src run's island-wide
    // entity sweep would DETACH-delete them anyway (quiet decay).
    const corpus = {
      island: 'isle',
      repoRoot,
      skippedSources: [],
      sources: [
        {
          root: path.join(repoRoot, 'knowledge-service', 'src'),
          declaredPath: 'knowledge-service/src',
          envGated: false,
          extractor: 'typescript' as const,
          extract: () => ({
            entities: [
              { id: 'src/a.ts', type: 'Module' as const, name: 'a' },
              { id: 'src/a.test.ts', type: 'Module' as const, name: 'a.test' },
            ],
            relations: [{ from: 'src/a.test.ts', to: 'src/a.ts', type: 'DEPENDS_ON' as const }],
          }),
        },
        {
          root: path.join(repoRoot, 'docs'),
          declaredPath: ['$', '{KG_TEST_COVER}'].join(''),
          envGated: true,
          extractor: 'coverage' as const,
          extract: () => ({
            entities: [
              { id: 'src/a.ts', type: 'Module' as const, name: 'a' },
              { id: 'vitest.config.ts', type: 'Module' as const, name: 'vitest.config' },
            ],
            relations: [
              { from: 'src/a.test.ts', to: 'src/a.ts', type: 'COVERS' as const },
              { from: 'src/a.test.ts', to: 'vitest.config.ts', type: 'COVERS' as const },
            ],
          }),
        },
      ],
    };
    await runGraphIndex(corpus, 'tag-63');

    const upsertParams = executeQuery.mock.calls
      .filter((c) => String(c[0]).includes('MERGE (n:KnowledgeEntity'))
      .flatMap((c) => (c[1] as { rows: Array<{ id: string }> }).rows.map((r) => r.id));
    expect(upsertParams).not.toContain('vitest.config.ts');

    // Relation rows carry island-prefixed endpoint keys (fromKey/toKey).
    const relationRows = executeQuery.mock.calls
      .filter((c) => String(c[0]).includes('MERGE (a)-[r:RELATES'))
      .flatMap((c) => (c[1] as { rows: Array<{ toKey: string; type: string }> }).rows);
    expect(relationRows.some((r) => r.type === 'COVERS' && r.toKey.endsWith('src/a.ts'))).toBe(
      true
    );
    expect(relationRows.some((r) => r.toKey.endsWith('vitest.config.ts'))).toBe(false);
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

/** Driver that can answer the index-meta read with stored source hashes.
 *  `indexedAt` defaults to matching entries' `t` claims made by callers —
 *  pass it explicitly when testing the latest-run gate. */
function driverWithMeta(storedHashesJson: string | null, indexedAt = '2026-07-25T00:00:00.000Z') {
    const executeQuery = vi.fn(async (cypher: string) => {
      const text = String(cypher);
      if (text.includes('KnowledgeIndexMeta') && text.includes('RETURN m')) {
        return {
          records:
            storedHashesJson === null
              ? []
              : [
                  {
                    get: () => ({
                      properties: {
                        sourceHashesJson: storedHashesJson,
                        indexedAt,
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

  it('writes nothing when every source fingerprint already matches', async () => {
    // First run to learn what this fixture hashes to.
    const first = driverWithMeta(null);
    await runGraphIndex(corpusFor(repoRoot), 'tag-50');
    const metaWrite = first.executeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE (m:KnowledgeIndexMeta')
    )?.[1] as { sourceHashesJson: string };
    const learnedHashes = JSON.parse(metaWrite.sourceHashesJson) as Record<
      string,
      { h: string; t: string }
    >;
    // Per SOURCE, keyed machine-independently (extractor:declaredPath), each
    // entry stamped with the run that wrote it.
    expect(Object.keys(learnedHashes).sort()).toEqual([
      'markdown:docs',
      'typescript:knowledge-service/src',
    ]);
    for (const entry of Object.values(learnedHashes)) {
      expect(entry.h).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.t).toBe('tag-50');
    }

    resetGraphStoreForTests();
    // A foreign entry (another machine's env-gated source) must not disturb
    // the skip decision — this run only consults its OWN sources.
    const second = driverWithMeta(
      JSON.stringify({
        ...learnedHashes,
        [GATED_COVERAGE_KEY]: { h: 'f'.repeat(64), t: 'tag-40' },
      }),
      'tag-50' // the island's latest run IS the one that wrote our entries
    );
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

  it('refuses to skip when the entries are not from the island\'s LATEST run', async () => {
    // Learn real hashes first.
    const first = driverWithMeta(null);
    await runGraphIndex(corpusFor(repoRoot), 'tag-70');
    const metaWrite = first.executeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE (m:KnowledgeIndexMeta')
    )?.[1] as { sourceHashesJson: string };
    resetGraphStoreForTests();

    // Same hashes, but the island's latest run (indexedAt) is NEWER than the
    // run that wrote them — another machine indexed in between and its
    // island-wide entity sweep may have taken this host's edges (checkout
    // drift). A matching hash proves nothing here: must re-index, not skip.
    const { executeQuery } = driverWithMeta(metaWrite.sourceHashesJson, 'tag-99-newer-run');
    const result = await runGraphIndex(corpusFor(repoRoot), 'tag-71', { skipIfUnchanged: true });
    expect(result.skipped).toBeUndefined();
    expect(
      executeQuery.mock.calls.some((c) => String(c[0]).includes('MERGE (n:KnowledgeEntity'))
    ).toBe(true);
  });

  it('prunes a REMOVED source\'s ghost entry but keeps declared env-gated ones', async () => {
    // Stored meta: an entry for a source this config no longer declares
    // ('typescript:gone/src') and one for a declared-but-skipped env-gated
    // coverage source. The island-wide entity sweep just deleted the removed
    // source's nodes, so its hash MUST go (else re-adding the unchanged
    // source would falsely skip) — while the env-gated entry survives.
    const configPath = path.join(repoRoot, 'pruning-corpus.yaml');
    fs.writeFileSync(
      configPath,
      [
        'islands:',
        '  isle:',
        `    repo_root: ${JSON.stringify(repoRoot)}`,
        '    sources:',
        '      - path: docs',
        '        extractor: markdown',
        `      - path: "${['$', '{KG_TEST_UNSET_COVERAGE_ROOT}'].join('')}"`,
        '        extractor: coverage',
        '',
      ].join('\n'),
      'utf8'
    );
    delete process.env.KG_TEST_UNSET_COVERAGE_ROOT;
    const gatedKey = ['coverage:$', '{KG_TEST_UNSET_COVERAGE_ROOT}'].join('');
    const stored = JSON.stringify({
      'markdown:docs': { h: 'a'.repeat(64), t: 't0' },
      'typescript:gone/src': { h: 'b'.repeat(64), t: 't0' },
      [gatedKey]: { h: 'c'.repeat(64), t: 't0' },
    });
    const { executeQuery } = driverWithMeta(stored, 't0');
    await runGraphIndex(resolveCorpus('isle', { configPath }), 'tag-72');

    const metaWrite = executeQuery.mock.calls.find((c) =>
      String(c[0]).includes('MERGE (m:KnowledgeIndexMeta')
    )?.[1] as { sourceHashesJson: string };
    const written = JSON.parse(metaWrite.sourceHashesJson) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([gatedKey, 'markdown:docs'].sort());
  });

  it('records the fingerprint only AFTER the graph actually holds the data', async () => {
    // Existing meta: this run's own sources are recorded as fresh, plus a
    // FOREIGN entry owned by another machine's env-gated source.
    const storedJson = JSON.stringify({
      'markdown:docs': { h: 'a'.repeat(64), t: 't0' },
      'typescript:knowledge-service/src': { h: 'b'.repeat(64), t: 't0' },
      [GATED_COVERAGE_KEY]: { h: 'c'.repeat(64), t: 't0' },
    });
    const executeQuery = vi.fn(async (cypher: string) => {
      const text = String(cypher);
      if (text.includes('MERGE (n:KnowledgeEntity')) throw new Error('write failed');
      if (text.includes('KnowledgeIndexMeta') && text.includes('RETURN m')) {
        return {
          records: [
            { get: () => ({ properties: { sourceHashesJson: storedJson, indexedAt: 't0' } }) },
          ],
          summary: {},
        };
      }
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
    // And this run's OLD entries must be invalidated BEFORE the first upsert:
    // without that, reverting the corpus after a failed run reads as "up to
    // date" over a mutated graph. The FOREIGN source's entry survives — this
    // run cannot damage data it does not touch.
    const calls = executeQuery.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    const cyphers = calls.map((c) => String(c[0]));
    const invalidation = cyphers.findIndex(
      (c) => c.includes('KnowledgeIndexMeta') && c.includes('SET m.sourceHashesJson')
    );
    const firstUpsert = cyphers.findIndex((c) => c.includes('MERGE (n:KnowledgeEntity'));
    expect(invalidation).toBeGreaterThan(-1);
    expect(invalidation).toBeLessThan(firstUpsert);
    const remaining = JSON.parse(String(calls[invalidation][1].json)) as Record<string, string>;
    expect(Object.keys(remaining)).toEqual([GATED_COVERAGE_KEY]);
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
    )?.[1] as { sourceHashesJson: string };
    // The skip gate needs the entries to come from the island's latest run —
    // mirror the real state by using the entries' own written tag.
    const learnedTag = (
      Object.values(JSON.parse(learned.sourceHashesJson)) as Array<{ t: string }>
    )[0].t;
    resetGraphStoreForTests();

    // With the flag: the write is skipped.
    const auto = driverWithMeta(learned.sourceHashesJson, learnedTag);
    expect(await runIndexCli(cliArgs(['--if-changed']))).toBe(0);
    const autoCyphers = auto.executeQuery.mock.calls.map((c) => String(c[0]));
    expect(autoCyphers.some((c) => c.includes('MERGE (n:KnowledgeEntity'))).toBe(false);
    resetGraphStoreForTests();

    // WITHOUT the flag: still a full index — this is the operator's escape
    // hatch when the graph and the fingerprint have drifted apart.
    const manual = driverWithMeta(learned.sourceHashesJson, learnedTag);
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
