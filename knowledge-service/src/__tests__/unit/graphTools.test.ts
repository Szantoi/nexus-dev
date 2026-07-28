/**
 * Graph MCP tool tests — registration, island scoping (from context, never
 * args), argument validation, and honest errors when the store is disabled.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver-lite';
import { env } from '../../config/env';
import { toolRegistry } from '../../interfaces/mcp/tools/base-tool';
import { registerGraphTools } from '../../interfaces/mcp/tools/graph.tools';
import {
  resetGraphStoreForTests,
  setGraphDriverForTests,
} from '../../knowledgeGraph/graphStore';
import { searchKnowledge } from '../../vectorStore';

// Only the vector query is faked; island resolution and error types stay real.
vi.mock('../../vectorStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vectorStore')>()),
  searchKnowledge: vi.fn(async () => []),
}));

registerGraphTools();

function fakeDriver() {
  const executeQuery = vi.fn(async () => ({ records: [], summary: { counters: {} } }));
  setGraphDriverForTests({
    executeQuery,
    getServerInfo: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined),
  } as unknown as Driver);
  return { executeQuery };
}

afterEach(() => {
  resetGraphStoreForTests();
  vi.restoreAllMocks();
});

describe('graph MCP tools', () => {
  it('registers every graph tool', () => {
    expect(toolRegistry.has('search_graph')).toBe(true);
    expect(toolRegistry.has('get_dependencies')).toBe(true);
    expect(toolRegistry.has('impact_analysis')).toBe(true);
    expect(toolRegistry.has('search_hybrid')).toBe(true);
  });

  it('returns an informative error (not a crash) when the graph is disabled', async () => {
    // Force the not-configured state regardless of the developer's local .env.
    const savedUrl = env.GRAPH_URL;
    const savedPassword = process.env.GRAPH_PASSWORD;
    env.GRAPH_URL = undefined;
    delete process.env.GRAPH_PASSWORD;
    try {
      const result = await toolRegistry.call('search_graph', { query: 'x' }, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('GRAPH_URL');
    } finally {
      env.GRAPH_URL = savedUrl;
      if (savedPassword !== undefined) process.env.GRAPH_PASSWORD = savedPassword;
    }
  });

  it('scopes queries to the CALLER island, ignoring any island-like args', async () => {
    const { executeQuery } = fakeDriver();
    await toolRegistry.call(
      'search_graph',
      { query: 'foo', island: 'attacker-island' },
      { island: 'caller-island' }
    );
    const [, params] = executeQuery.mock.calls[0] as unknown as [string, { island: string }];
    expect(params.island).toBe('caller-island');
  });

  it('pins the caller island for BOTH traversal tools as well', async () => {
    const { executeQuery } = fakeDriver();
    await toolRegistry.call(
      'get_dependencies',
      { entity_id: 'src/a.ts', island: 'attacker-island' },
      { island: 'caller-island' }
    );
    let [, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { island: string; key: string },
    ];
    expect(params.island).toBe('caller-island');
    expect(params.key).toBe('caller-island|src/a.ts');

    await toolRegistry.call(
      'impact_analysis',
      { entity_id: 'src/a.ts', island: 'attacker-island' },
      { island: 'caller-island' }
    );
    [, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { island: string; key: string },
    ];
    expect(params.island).toBe('caller-island');
    expect(params.key).toBe('caller-island|src/a.ts');
  });

  it('rejects empty query / entity_id without querying', async () => {
    const { executeQuery } = fakeDriver();
    const r1 = await toolRegistry.call('search_graph', { query: '  ' }, {});
    const r2 = await toolRegistry.call('get_dependencies', { entity_id: '' }, {});
    const r3 = await toolRegistry.call('impact_analysis', {}, {});
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
    expect(r3.isError).toBe(true);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('get_dependencies defaults to dependents and forwards direction', async () => {
    const { executeQuery } = fakeDriver();
    await toolRegistry.call('get_dependencies', { entity_id: 'src/a.ts' }, { island: 'isle' });
    let [cypher] = executeQuery.mock.calls.at(-1) as unknown as [string];
    expect(cypher).toContain('<-[rels:RELATES');

    await toolRegistry.call(
      'get_dependencies',
      { entity_id: 'src/a.ts', direction: 'dependencies' },
      { island: 'isle' }
    );
    [cypher] = executeQuery.mock.calls.at(-1) as unknown as [string];
    expect(cypher).not.toContain('<-[rels:RELATES');
  });

  it('impact_analysis groups results by entity type', async () => {
    const record = (id: string, type: string, distance: number) => ({
      get(field: string) {
        if (field === 'm') return { properties: { id, type, name: id } };
        if (field === 'distance') return distance;
        return undefined;
      },
    });
    const executeQuery = vi.fn(async () => ({
      records: [record('src/a.ts', 'Module', 1), record('docs/x.md', 'Doc', 2)],
      summary: { counters: {} },
    }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    const result = await toolRegistry.call(
      'impact_analysis',
      { entity_id: 'src/b.ts' },
      { island: 'isle' }
    );
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.affected_count).toBe(2);
    expect(payload.truncated).toBe(false);
    expect(payload.affected_by_type.Module).toEqual([
      { id: 'src/a.ts', name: 'src/a.ts', distance: 1 },
    ]);
    expect(payload.affected_by_type.Doc).toEqual([
      { id: 'docs/x.md', name: 'docs/x.md', distance: 2 },
    ]);
  });

  it('surfaces truncation so a capped impact set reads as a lower bound', async () => {
    const record = (i: number) => ({
      get(field: string) {
        if (field === 'm')
          return { properties: { id: `src/m${i}.ts`, type: 'Module', name: `m${i}` } };
        if (field === 'distance') return 1;
        return undefined;
      },
    });
    const executeQuery = vi.fn(async () => ({
      records: Array.from({ length: 201 }, (_, i) => record(i)),
      summary: { counters: {} },
    }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    const result = await toolRegistry.call(
      'impact_analysis',
      { entity_id: 'src/hub.ts' },
      { island: 'isle' }
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.truncated).toBe(true);
    expect(payload.affected_count).toBe(200);
  });

  it('reports an unknown entity_id as not-found, never as "nothing breaks"', async () => {
    fakeDriver(); // zero records = the start MATCH found nothing
    for (const tool of ['impact_analysis', 'get_dependencies']) {
      const result = await toolRegistry.call(tool, { entity_id: 'src/typo.ts' }, { island: 'isle' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('search_graph');
      expect(result.content[0].text).not.toContain('affected_count');
    }
  });

  it('echoes the effective depth so a bounded answer cannot read as complete', async () => {
    const record = {
      get(field: string) {
        if (field === 'm') return { properties: { id: 'src/a.ts', type: 'Module', name: 'a' } };
        if (field === 'distance') return 1;
        return undefined;
      },
    };
    const executeQuery = vi.fn(async () => ({ records: [record], summary: { counters: {} } }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    const dflt = await toolRegistry.call('impact_analysis', { entity_id: 'src/b.ts' }, {});
    expect(JSON.parse(dflt.content[0].text).depth).toBe(3); // the tool's OWN default

    const deep = await toolRegistry.call(
      'impact_analysis',
      { entity_id: 'src/b.ts', depth: 99 },
      {}
    );
    expect(JSON.parse(deep.content[0].text).depth).toBe(5); // clamped, and visible
  });

  it('refuses non-numeric depth instead of silently answering a smaller question', async () => {
    const { executeQuery } = fakeDriver();
    const result = await toolRegistry.call(
      'impact_analysis',
      { entity_id: 'src/a.ts', depth: 'deep' },
      { island: 'isle' }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('depth must be a number');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('treats an explicit null limit as "use the default", not as zero', async () => {
    const { executeQuery } = fakeDriver();
    await toolRegistry.call('search_graph', { query: 'x', limit: null }, { island: 'isle' });
    const [, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { limit: { toNumber(): number } },
    ];
    expect(params.limit.toNumber()).toBe(10); // Number(null) would have been 0 → LIMIT 1
  });

  it('search_hybrid pins the caller island and labels a degraded answer', async () => {
    const { executeQuery } = fakeDriver();
    vi.mocked(searchKnowledge).mockRejectedValueOnce(new Error('chroma down'));

    const result = await toolRegistry.call(
      'search_hybrid',
      { query: 'auth', island: 'attacker-island' },
      { island: 'caller-island' }
    );
    const payload = JSON.parse(result.content[0].text);
    // Half the search failed — the caller must see that, not a short list.
    expect(payload.degraded).toBe(true);
    expect(payload.vector.available).toBe(false);
    expect(vi.mocked(searchKnowledge).mock.calls[0][2]).toBe('caller-island');
    const [, params] = executeQuery.mock.calls[0] as unknown as [string, { island: string }];
    expect(params.island).toBe('caller-island');
  });

  it('search_hybrid emits fusion_score (not score) and an honest neighbour total', async () => {
    const record = (field: string, id: string) => ({
      get(name: string) {
        if (name === field) return { properties: { id, type: 'Module', name: id } };
        if (name === 'distance') return 1;
        return undefined;
      },
    });
    const executeQuery = vi.fn(async (cypher: string) => ({
      records: String(cypher).includes('OPTIONAL MATCH')
        ? Array.from({ length: 7 }, (_, i) => record('m', `src/dep${i}.ts`))
        : [record('n', 'src/hub.ts')],
      summary: {},
    }));
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);

    const result = await toolRegistry.call('search_hybrid', { query: 'hub' }, { island: 'isle' });
    const payload = JSON.parse(result.content[0].text);
    const hit = payload.results[0];
    // `score` would invite comparison with search_knowledge's similarity.
    expect(hit.score).toBeUndefined();
    expect(typeof hit.fusion_score).toBe('number');
    expect(hit.related).toHaveLength(5);
    expect(hit.related_total).toBe(7); // "5 shown" must not read as "5 exist"
  });

  it('search_hybrid rejects an empty query and honours expand:false', async () => {
    const { executeQuery } = fakeDriver();
    const empty = await toolRegistry.call('search_hybrid', { query: '   ' }, { island: 'isle' });
    expect(empty.isError).toBe(true);
    expect(executeQuery).not.toHaveBeenCalled();

    await toolRegistry.call(
      'search_hybrid',
      { query: 'hub', expand: false },
      { island: 'isle' }
    );
    expect(
      executeQuery.mock.calls.some((c) => String(c[0]).includes('OPTIONAL MATCH'))
    ).toBe(false);
  });

  it('validates enum-ish args via the store (bad relation type is an error result)', async () => {
    fakeDriver();
    const result = await toolRegistry.call(
      'get_dependencies',
      { entity_id: 'src/a.ts', relation_types: 'BOGUS' },
      { island: 'isle' }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown relation type');
  });
});

describe('covers_layer freshness signal (COVERS follow-up b)', () => {
  /**
   * Fake driver: the traversal query returns one row with a null `m`
   * (existing entity, zero neighbours -> found=true), the meta query is
   * scripted per test case.
   */
  function driverWithMeta(metaProps: Record<string, unknown> | null | Error) {
    const executeQuery = vi.fn(async (cypher: string) => {
      const c = String(cypher);
      if (c.includes('KnowledgeIndexMeta')) {
        if (metaProps instanceof Error) throw metaProps;
        return {
          records: metaProps === null ? [] : [{ get: () => ({ properties: metaProps }) }],
          summary: { counters: {} },
        };
      }
      if (c.includes('OPTIONAL MATCH')) {
        return {
          records: [{ get: (f: string) => (f === 'm' ? null : null) }],
          summary: { counters: {} },
        };
      }
      return { records: [], summary: { counters: {} } };
    });
    setGraphDriverForTests({
      executeQuery,
      getServerInfo: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    } as unknown as Driver);
  }

  function parseResult(result: { content: Array<{ text?: string }> }): {
    covers_layer: { status: string; [k: string]: unknown };
  } {
    return JSON.parse(result.content[0].text ?? '{}');
  }

  it('reports FRESH when the coverage entry comes from the latest run', async () => {
    driverWithMeta({
      sourceHashesJson: JSON.stringify({
        'coverage:${NEXUS_COVERAGE_ROOT}': { h: 'abc', t: 'T1' },
        'typescript:knowledge-service/src': { h: 'def', t: 'T1' },
      }),
      indexedAt: 'T1',
    });
    const result = await toolRegistry.call('get_dependencies', { entity_id: 'src/a.ts' }, { island: 'isle' });
    expect(result.isError).not.toBe(true);
    expect(parseResult(result).covers_layer).toEqual({ status: 'fresh', indexed_at: 'T1' });
  });

  it('reports STALE with both timestamps when a later run reindexed without coverage', async () => {
    driverWithMeta({
      sourceHashesJson: JSON.stringify({
        'coverage:${NEXUS_COVERAGE_ROOT}': { h: 'abc', t: 'T0' },
      }),
      indexedAt: 'T1',
    });
    const result = await toolRegistry.call('impact_analysis', { entity_id: 'src/a.ts' }, { island: 'isle' });
    const covers = parseResult(result).covers_layer;
    expect(covers.status).toBe('stale');
    expect(covers.covers_indexed_at).toBe('T0');
    expect(covers.island_indexed_at).toBe('T1');
    expect(String(covers.note)).toContain('coverage:index');
  });

  it('reports ABSENT when the island has no coverage source entry (and when it has no meta at all)', async () => {
    driverWithMeta({
      // A key CONTAINING 'coverage' in a non-extractor position must not
      // match (mutation guard: startsWith must not degrade to includes).
      sourceHashesJson: JSON.stringify({
        'typescript:knowledge-service/src': { h: 'x', t: 'T1' },
        'markdown:docs/coverage-notes': { h: 'y', t: 'T1' },
      }),
      indexedAt: 'T1',
    });
    const withMeta = await toolRegistry.call('get_dependencies', { entity_id: 'src/a.ts' }, { island: 'isle' });
    expect(parseResult(withMeta).covers_layer.status).toBe('absent');

    driverWithMeta(null);
    const noMeta = await toolRegistry.call('get_dependencies', { entity_id: 'src/a.ts' }, { island: 'isle' });
    expect(parseResult(noMeta).covers_layer.status).toBe('absent');
  });

  it('reports UNKNOWN (distinct from absent) when the meta read fails — and the tool still answers', async () => {
    driverWithMeta(new Error('meta read exploded'));
    const result = await toolRegistry.call('impact_analysis', { entity_id: 'src/a.ts' }, { island: 'isle' });
    expect(result.isError).not.toBe(true); // the traversal answer survives
    const covers = parseResult(result).covers_layer;
    expect(covers.status).toBe('unknown');
    expect(String(covers.error)).toContain('meta read exploded');
  });
});
