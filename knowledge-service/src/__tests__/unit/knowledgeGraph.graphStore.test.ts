/**
 * graphStore unit tests — fake driver via the test seam; no live Neo4j.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver-lite';
import {
  GraphDisabledError,
  GraphUnavailableError,
  MAX_TRAVERSAL_DEPTH,
  clearIsland,
  findEntitiesByPathSuffix,
  graphHealth,
  graphStats,
  resetGraphStoreForTests,
  searchEntities,
  searchEntitiesByTerms,
  setGraphDriverForTests,
  sweepStale,
  traverse,
  upsertEntities,
  upsertRelations,
} from '../../knowledgeGraph/graphStore';
import { env } from '../../config/env';
import { UnknownIslandError } from '../../core/island';

interface FakeRecord {
  get(field: string): unknown;
}

function fakeDriver(records: FakeRecord[] = []) {
  const executeQuery = vi.fn(async () => ({ records, summary: { counters: {} } }));
  const driver = {
    executeQuery,
    getServerInfo: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined),
  };
  setGraphDriverForTests(driver as unknown as Driver);
  return { executeQuery };
}

function nodeRecord(field: string, properties: Record<string, unknown>): FakeRecord {
  return {
    get(name: string) {
      if (name === field) return { properties };
      if (name === 'distance') return 1;
      if (name === 'nodes') return 2;
      if (name === 'relations') return 3;
      return undefined;
    },
  };
}

afterEach(() => {
  resetGraphStoreForTests();
  vi.restoreAllMocks();
});

/** Force the not-configured state regardless of the developer's local .env. */
function withGraphUnconfigured(): () => void {
  const savedUrl = env.GRAPH_URL;
  const savedPassword = process.env.GRAPH_PASSWORD;
  env.GRAPH_URL = undefined;
  delete process.env.GRAPH_PASSWORD;
  return () => {
    env.GRAPH_URL = savedUrl;
    if (savedPassword !== undefined) process.env.GRAPH_PASSWORD = savedPassword;
  };
}

describe('knowledgeGraph module boundary', () => {
  it('never imports the vector stack outside hybrid search', () => {
    // Importing vectorStore drags in the ChromaDB client and the embedding
    // stack (native `sharp`) — which on the VPS crashes the process outright,
    // and the graph indexer has to run THERE. Only hybridSearch, whose whole
    // job is fusing the two stores, may reach across.
    const moduleDir = path.join(__dirname, '..', '..', 'knowledgeGraph');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(moduleDir);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      if (path.basename(file) === 'hybridSearch.ts' || path.basename(file) === 'index.ts') continue;
      expect(fs.readFileSync(file, 'utf8'), file).not.toContain("from '../vectorStore'");
    }
  });
});

describe('knowledgeGraph/graphStore', () => {
  it('throws GraphDisabledError when GRAPH_URL/GRAPH_PASSWORD are not configured', async () => {
    const restore = withGraphUnconfigured();
    try {
      // Unconfigured store must fail closed, not fall back.
      await expect(searchEntities('x')).rejects.toBeInstanceOf(GraphDisabledError);
    } finally {
      restore();
    }
  });

  it('reports disabled health without touching a driver', async () => {
    const restore = withGraphUnconfigured();
    try {
      await expect(graphHealth()).resolves.toEqual({ enabled: false, connected: false });
    } finally {
      restore();
    }
  });

  it('rejects malformed island ids before any query runs', async () => {
    const { executeQuery } = fakeDriver();
    await expect(searchEntities('x', { island: 'Bad Island!' })).rejects.toBeInstanceOf(
      UnknownIslandError
    );
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('upserts entities with island-scoped keys', async () => {
    const { executeQuery } = fakeDriver();
    const count = await upsertEntities(
      [{ id: 'docs/a.md', type: 'Doc', name: 'a' }],
      'my-island'
    );
    expect(count).toBe(1);
    const [, params] = executeQuery.mock.calls[0] as unknown as [
      string,
      { rows: Array<Record<string, unknown>> },
    ];
    expect(params.rows[0].key).toBe('my-island|docs/a.md');
    expect(params.rows[0].island).toBe('my-island');
  });

  it('rejects unknown entity and relation types', async () => {
    fakeDriver();
    await expect(
      upsertEntities([{ id: 'x', type: 'Weird' as never, name: 'x' }], 'isle')
    ).rejects.toThrow(/Unknown entity type/);
    await expect(
      upsertRelations([{ from: 'a', to: 'b', type: 'EATS' as never }], 'isle')
    ).rejects.toThrow(/Unknown relation type/);
  });

  it('returns 0 without querying for empty upserts', async () => {
    const { executeQuery } = fakeDriver();
    expect(await upsertEntities([], 'isle')).toBe(0);
    expect(await upsertRelations([], 'isle')).toBe(0);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('clamps traversal depth into 1..MAX and inlines it into the pattern', async () => {
    const { executeQuery } = fakeDriver();
    await traverse('docs/a.md', { island: 'isle', direction: 'dependents', depth: 99 });
    const [cypher] = executeQuery.mock.calls.at(-1) as unknown as [string];
    expect(cypher).toContain(`*1..${MAX_TRAVERSAL_DEPTH}]`);
    expect(cypher).toContain('<-[rels:RELATES');

    await traverse('docs/a.md', { island: 'isle', direction: 'dependencies', depth: 0 });
    const [cypher2] = executeQuery.mock.calls.at(-1) as unknown as [string];
    expect(cypher2).toContain('*1..1]');
    expect(cypher2).toContain('-[rels:RELATES*1..1]->');
  });

  it('maps non-finite depth/limit (NaN from unvalidated args) to the defaults', async () => {
    const { executeQuery } = fakeDriver();
    await traverse('docs/a.md', {
      island: 'isle',
      direction: 'dependents',
      depth: Number('abc'),
    });
    const [cypher] = executeQuery.mock.calls.at(-1) as unknown as [string];
    expect(cypher).toContain('*1..2]'); // default depth, never "*1..NaN"
    expect(cypher).not.toContain('NaN');

    await searchEntities('x', { island: 'isle', limit: Number('ten') });
    const [, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { limit: { toNumber(): number } },
    ];
    expect(params.limit.toNumber()).toBe(10); // default, never int(NaN) === 0
  });

  it('scopes traversal to the island and the exact start key', async () => {
    const { executeQuery } = fakeDriver();
    await traverse('docs/a.md', { island: 'isle', direction: 'dependents' });
    const [cypher, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { key: string; island: string },
    ];
    expect(params.key).toBe('isle|docs/a.md');
    expect(params.island).toBe('isle');
    expect(cypher).toContain('WHERE all(x IN nodes(p) WHERE x.island = $island)');
  });

  it('reports truncation only when the cap overflows', async () => {
    const record = (i: number) =>
      nodeRecord('m', { id: `src/m${String(i).padStart(3, '0')}.ts`, type: 'Module', name: `m${i}` });
    fakeDriver(Array.from({ length: 201 }, (_, i) => record(i)));
    const { hits, truncated } = await traverse('src/hub.ts', {
      island: 'isle',
      direction: 'dependents',
    });
    expect(truncated).toBe(true);
    expect(hits).toHaveLength(200);

    fakeDriver(Array.from({ length: 200 }, (_, i) => record(i)));
    const exact = await traverse('src/hub.ts', { island: 'isle', direction: 'dependents' });
    expect(exact.truncated).toBe(false);
    expect(exact.hits).toHaveLength(200);
  });

  it('builds island-scoped from/to keys for relation upserts', async () => {
    const { executeQuery } = fakeDriver();
    await upsertRelations([{ from: 'docs/a.md', to: 'docs/b.md', type: 'REFERENCES' }], 'isle');
    const [cypher, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { rows: Array<{ fromKey: string; toKey: string; type: string }> },
    ];
    expect(params.rows[0]).toEqual({
      fromKey: 'isle|docs/a.md',
      toKey: 'isle|docs/b.md',
      type: 'REFERENCES',
    });
    expect(cypher).toContain('MERGE (a)-[r:RELATES {type: row.type}]->(b)');
  });

  it('stamps sync tags on upserts and sweeps only untagged elements', async () => {
    const { executeQuery } = fakeDriver();
    await upsertEntities([{ id: 'docs/a.md', type: 'Doc', name: 'a' }], 'isle', 'tag-1');
    let [cypher, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { syncTag?: string },
    ];
    expect(cypher).toContain('n.syncedAt = $syncTag');
    expect(params.syncTag).toBe('tag-1');

    await upsertRelations(
      [{ from: 'docs/a.md', to: 'docs/b.md', type: 'REFERENCES' }],
      'isle',
      'tag-1'
    );
    [cypher, params] = executeQuery.mock.calls.at(-1) as unknown as [string, { syncTag?: string }];
    expect(cypher).toContain('r.syncedAt = $syncTag');

    await sweepStale('tag-1', 'isle');
    const sweeps = executeQuery.mock.calls.slice(-2) as unknown as Array<
      [string, Record<string, unknown>]
    >;
    // `<` (not `<>`): two overlapping index runs converge on the newer graph
    // instead of sweeping away each other's freshly written nodes.
    expect(sweeps[0][0]).toContain("coalesce(r.syncedAt, '') < $syncTag DELETE r");
    expect(sweeps[1][0]).toContain("coalesce(n.syncedAt, '') < $syncTag DETACH DELETE n");
    // Both sweep statements MUST stay island-scoped — without this assertion a
    // dropped island filter would turn a re-index into a cross-island wipe.
    for (const [cypher, params] of sweeps) {
      expect(cypher).toContain('{island: $island}');
      expect(params.island).toBe('isle');
      expect(params.syncTag).toBe('tag-1');
    }
  });

  it('refuses to sweep with an empty sync tag', async () => {
    const { executeQuery } = fakeDriver();
    await expect(sweepStale('  ', 'isle')).rejects.toThrow(/non-empty sync tag/);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('wraps driver failures as GraphUnavailableError', async () => {
    const executeQuery = vi.fn().mockRejectedValue(new Error('connection refused'));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);
    await expect(searchEntities('x', { island: 'isle' })).rejects.toBeInstanceOf(
      GraphUnavailableError
    );
  });

  it('bootstraps the schema once and retries after a failed bootstrap', async () => {
    const executeQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error('neo4j still starting')) // constraint attempt 1
      .mockResolvedValue({ records: [], summary: { counters: {} } });
    setGraphDriverForTests(
      {
        executeQuery,
        getServerInfo: vi.fn(async () => ({})),
        close: vi.fn(async () => undefined),
      } as unknown as Driver,
      { needsBootstrap: true }
    );

    // First call fails during bootstrap and must surface as unavailable...
    await expect(searchEntities('x', { island: 'isle' })).rejects.toBeInstanceOf(
      GraphUnavailableError
    );
    // ...the retry re-runs the schema statements, then the real query.
    await searchEntities('x', { island: 'isle' });
    const cyphers = executeQuery.mock.calls.map((c) => String(c[0]));
    expect(cyphers[0]).toContain('CREATE CONSTRAINT');
    expect(cyphers[1]).toContain('CREATE CONSTRAINT');
    // The island index is what keeps island-scoped queries off a full label
    // scan of every other island's nodes.
    expect(cyphers[2]).toContain('CREATE INDEX knowledge_entity_island');
    expect(cyphers[3]).toContain('MATCH (n:KnowledgeEntity');
    // A successful bootstrap is not repeated on subsequent queries.
    await searchEntities('y', { island: 'isle' });
    expect(
      executeQuery.mock.calls.filter((c) => String(c[0]).includes('CREATE '))
    ).toHaveLength(3);
  });

  it('sends a server-side timeout with every query', async () => {
    const { executeQuery } = fakeDriver();
    await searchEntities('x', { island: 'isle' });
    const [, , config] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      unknown,
      { database: string; transactionConfig: { timeout: number } },
    ];
    expect(config.transactionConfig.timeout).toBeGreaterThan(0);
  });

  it('filters traversal by validated relation types only', async () => {
    fakeDriver();
    await expect(
      traverse('a', { island: 'isle', direction: 'dependents', relationTypes: ['BOGUS'] })
    ).rejects.toThrow(/Unknown relation type/);
  });

  it('maps traversal records to entities with distance', async () => {
    fakeDriver([
      nodeRecord('m', { id: 'src/b.ts', type: 'Module', name: 'b', language: 'typescript' }),
    ]);
    const { hits, truncated, found, depth } = await traverse('src/a.ts', {
      island: 'isle',
      direction: 'dependents',
    });
    expect(truncated).toBe(false);
    expect(found).toBe(true);
    expect(depth).toBe(2); // effective (clamped) depth is reported back
    expect(hits).toEqual([
      {
        entity: { id: 'src/b.ts', type: 'Module', name: 'b', language: 'typescript' },
        distance: 1,
      },
    ]);
  });

  it('separates "entity not in the graph" from "entity has no dependents"', async () => {
    // No rows at all: the start MATCH found nothing — a typo'd or unindexed id.
    fakeDriver([]);
    const missing = await traverse('src/typo.ts', { island: 'isle', direction: 'dependents' });
    expect(missing.found).toBe(false);
    expect(missing.hits).toEqual([]);

    // One row with a null `m`: the OPTIONAL MATCH found no neighbours, but the
    // entity itself exists — a genuine "nothing depends on this".
    fakeDriver([{ get: () => null }]);
    const lonely = await traverse('src/leaf.ts', { island: 'isle', direction: 'dependents' });
    expect(lonely.found).toBe(true);
    expect(lonely.hits).toEqual([]);
    expect(lonely.truncated).toBe(false);
  });

  it('clamps ±Infinity to the bounds instead of falling back to the default', async () => {
    const { executeQuery } = fakeDriver();
    // JSON.parse('1e999') === Infinity — reachable from an MCP argument.
    await traverse('a', { island: 'isle', direction: 'dependents', depth: Number.POSITIVE_INFINITY });
    const [cypher] = executeQuery.mock.calls.at(-1) as unknown as [string];
    expect(cypher).toContain(`*1..${MAX_TRAVERSAL_DEPTH}]`);

    await searchEntities('x', { island: 'isle', limit: Number.POSITIVE_INFINITY });
    const [, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { limit: { toNumber(): number } },
    ];
    expect(params.limit.toNumber()).toBe(50); // MAX_SEARCH_RESULTS, not the default 10
  });

  it('search clamps the limit and forwards a lowercase query', async () => {
    const { executeQuery } = fakeDriver();
    await searchEntities('AbC', { island: 'isle', limit: 9999 });
    const [, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { q: string; limit: { toNumber(): number } },
    ];
    expect(params.q).toBe('abc');
    expect(params.limit.toNumber()).toBe(50);
  });

  it('search validates the optional entity type', async () => {
    fakeDriver();
    await expect(searchEntities('x', { island: 'isle', type: 'Nope' })).rejects.toThrow(
      /Unknown entity type/
    );
  });

  it('probes path suffixes with a PER-PROBE budget, island-scoped', async () => {
    const { executeQuery } = fakeDriver([]);
    await findEntitiesByPathSuffix(['a.md', 'b.md', 'a.md', '  '], 'isle');
    const [cypher, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { island: string; rows: Array<{ path: string; needle: string }>; perProbe: unknown },
    ];
    expect(params.island).toBe('isle');
    expect(cypher).toContain('{island: $island}');
    // A shared top-level LIMIT would let one probe eat another's budget and
    // make an ambiguous probe look unambiguous — the LIMIT must be inside.
    expect(cypher).toContain('CALL { WITH row');
    expect(cypher).toContain('LIMIT $perProbe }');
    // Blanks dropped, duplicates collapsed, needle anchored on a separator.
    expect(params.rows).toEqual([
      { path: 'a.md', needle: '/a.md' },
      { path: 'b.md', needle: '/b.md' },
    ]);
  });

  it('groups suffix matches by probe and caps the probe count', async () => {
    const row = (probe: string, id: string) => ({
      get(name: string) {
        if (name === 'path') return probe;
        if (name === 'n') return { properties: { id, type: 'Doc', name: id } };
        return undefined;
      },
    });
    const { executeQuery } = fakeDriver([
      row('x.md', 'docs/x.md'),
      row('x.md', 'other/x.md'),
      row('y.md', 'docs/y.md'),
    ]);
    const found = await findEntitiesByPathSuffix(['x.md', 'y.md'], 'isle');
    expect(found.get('x.md')?.map((e) => e.id)).toEqual(['docs/x.md', 'other/x.md']);
    expect(found.get('y.md')).toHaveLength(1);

    // 40 probes must not become 40 unbounded scans.
    await findEntitiesByPathSuffix(
      Array.from({ length: 40 }, (_, i) => `f${i}.md`),
      'isle'
    );
    const [, params] = executeQuery.mock.calls.at(-1) as unknown as [string, { rows: unknown[] }];
    expect(params.rows).toHaveLength(25);

    expect(await findEntitiesByPathSuffix([], 'isle')).toEqual(new Map());
  });

  it('ranks multi-term search by how many terms an entity matches', async () => {
    const { executeQuery } = fakeDriver([]);
    await searchEntitiesByTerms(['Vps', 'vps', 'tailscale', ''], { island: 'isle', limit: 7 });
    const [cypher, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { island: string; terms: string[]; limit: { toNumber(): number } },
    ];
    expect(params.island).toBe('isle');
    expect(params.terms).toEqual(['vps', 'tailscale']); // lowercased, deduped, blanks dropped
    expect(cypher).toContain('ORDER BY matches DESC');
    expect(params.limit.toNumber()).toBe(7);

    // No usable term must not turn into "match everything".
    executeQuery.mockClear();
    expect(await searchEntitiesByTerms([' '], { island: 'isle' })).toEqual([]);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('graphStats maps counts and clearIsland scopes to the island', async () => {
    const { executeQuery } = fakeDriver([nodeRecord('n', {})]);
    await expect(graphStats('isle')).resolves.toEqual({ nodes: 2, relations: 3 });
    await clearIsland('isle');
    const [cypher, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { island: string },
    ];
    expect(cypher).toContain('DETACH DELETE');
    expect(params.island).toBe('isle');
  });
});
