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
  it('registers all three tools', () => {
    expect(toolRegistry.has('search_graph')).toBe(true);
    expect(toolRegistry.has('get_dependencies')).toBe(true);
    expect(toolRegistry.has('impact_analysis')).toBe(true);
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
