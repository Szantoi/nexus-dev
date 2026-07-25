/**
 * Hybrid search tests. The contract this file defends:
 *  - a hit found by BOTH stores outranks one found by either alone — including
 *    when a single store returns the same document many times (chunking),
 *  - a vector hit is linked to its graph entity only when the path suffix is
 *    UNAMBIGUOUS (never merge two different files into one hit),
 *  - anything that did not run is LABELLED: a failed store, a failed linking
 *    step, the in-memory fallback, a sampled neighbour list.
 * Assertions pin exact numbers where a bound is the point, so removing a
 * clamp or a cap fails the test instead of merely changing a value.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver-lite';
import { queryTerms, searchHybrid } from '../../knowledgeGraph/hybridSearch';
import {
  resetGraphStoreForTests,
  setGraphDriverForTests,
} from '../../knowledgeGraph/graphStore';
import { UnknownIslandError, searchKnowledge, usingChroma } from '../../vectorStore';

vi.mock('../../vectorStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vectorStore')>()),
  searchKnowledge: vi.fn(),
  usingChroma: vi.fn(() => true),
}));

const vectorSearch = vi.mocked(searchKnowledge);

interface FakeRecord {
  get(field: string): unknown;
}

function entityRecord(field: string, id: string, type = 'Module'): FakeRecord {
  return {
    get(name: string) {
      if (name === field) return { properties: { id, type, name: id.split('/').pop() } };
      if (name === 'distance') return 1;
      return undefined;
    },
  };
}

/** A suffix-probe row: which probe matched which entity. */
function suffixRecord(probe: string, id: string, type = 'Doc'): FakeRecord {
  return {
    get(name: string) {
      if (name === 'path') return probe;
      if (name === 'n') return { properties: { id, type, name: id.split('/').pop() } };
      return undefined;
    },
  };
}

type QueryKind = 'search' | 'suffix' | 'traverse';

function kindOf(cypher: string): QueryKind {
  if (cypher.includes('ENDS WITH')) return 'suffix';
  if (cypher.includes('OPTIONAL MATCH')) return 'traverse';
  return 'search';
}

/** Fake driver answering each Cypher shape from a scripted map. */
function fakeDriver(answers: {
  search?: FakeRecord[];
  suffix?: FakeRecord[];
  traverse?: FakeRecord[];
  failOn?: QueryKind;
}) {
  const executeQuery = vi.fn(async (cypher: string) => {
    const kind = kindOf(String(cypher));
    if (answers.failOn === kind) throw new Error(`${kind} query exploded`);
    return { records: answers[kind] ?? [], summary: {} };
  });
  setGraphDriverForTests({
    executeQuery,
    getServerInfo: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined),
  } as unknown as Driver);
  return { executeQuery };
}

afterEach(() => {
  resetGraphStoreForTests();
  vi.clearAllMocks();
  vi.mocked(usingChroma).mockReturnValue(true);
});

describe('queryTerms', () => {
  it('splits prose into probes but keeps file-like tokens whole', () => {
    expect(queryTerms('Hol van a vectorStore.ts sziget-kezelése?')).toEqual([
      'hol',
      'van',
      'vectorstore.ts',
      'sziget-kezelése',
    ]);
    // Single characters are noise — a 1-char query never reaches the graph.
    expect(queryTerms('a  b')).toEqual([]);
    expect(queryTerms('one two three four five six seven eight')).toHaveLength(6); // capped
    expect(queryTerms('dup dup')).toEqual(['dup']);
  });
});

describe('searchHybrid', () => {
  it('ranks a hit found by both stores above single-store hits', async () => {
    vectorSearch.mockResolvedValue([
      { text: 'about vector store internals', metadata: { source: 'vectorStore.ts' }, score: 0.9 },
      { text: 'unrelated prose', metadata: { source: 'other.md' }, score: 0.4 },
    ]);
    fakeDriver({
      search: [
        entityRecord('n', 'knowledge-service/src/vectorStore.ts'),
        entityRecord('n', 'knowledge-service/src/graphStore.ts'),
      ],
      suffix: [suffixRecord('vectorStore.ts', 'knowledge-service/src/vectorStore.ts', 'Module')],
    });

    const result = await searchHybrid('vector store', { island: 'isle', expand: false });

    expect(result.degraded).toBe(false);
    expect(result.hits[0].id).toBe('knowledge-service/src/vectorStore.ts');
    expect(result.hits[0].sources).toEqual(['graph', 'vector']);
    expect(result.hits[0].type).toBe('Module');
    expect(result.hits[0].snippet).toContain('vector store internals');
    // Exact fused value: vector rank 1 + graph rank 1 = 2/61. A "keep the max"
    // fusion would give 1/61 and still be ordered first — this pins the rule.
    expect(result.hits[0].fusionScore).toBeCloseTo(2 / 61, 6);
    expect(result.hits[1].fusionScore).toBeCloseTo(1 / 62, 6); // single store, rank 2
    expect(result.hits.map((h) => h.id)).toContain('knowledge-service/src/graphStore.ts');
  });

  it('counts a chunked document ONCE, so it cannot outrank a both-store hit', async () => {
    // The knowledge base is chunked: one file arrives as many vector rows with
    // the SAME source. Summing them would beat any both-store hit (3/61+ > 2/61).
    vectorSearch.mockResolvedValue([
      { text: 'chunk 1', metadata: { source: 'long.md' }, score: 0.9 },
      { text: 'chunk 2', metadata: { source: 'long.md' }, score: 0.8 },
      { text: 'chunk 3', metadata: { source: 'long.md' }, score: 0.7 },
      { text: 'both stores know this', metadata: { source: 'both.md' }, score: 0.6 },
    ]);
    fakeDriver({
      search: [entityRecord('n', 'docs/both.md', 'Doc')],
      suffix: [suffixRecord('both.md', 'docs/both.md')],
    });

    const result = await searchHybrid('anything', { island: 'isle', expand: false });

    expect(result.hits[0].id).toBe('docs/both.md');
    expect(result.hits[0].sources).toEqual(['graph', 'vector']);
    const chunked = result.hits.find((h) => h.id === 'long.md');
    // Its best rank only, never the sum of its chunks.
    expect(chunked?.fusionScore).toBeCloseTo(1 / 61, 6);
  });

  it('refuses to link a vector hit when the path suffix is ambiguous', async () => {
    vectorSearch.mockResolvedValue([
      { text: 'readme text', metadata: { source: 'README.md' }, score: 0.8 },
    ]);
    fakeDriver({
      search: [],
      // Two different files end with '/README.md' — merging them would be wrong.
      suffix: [
        suffixRecord('README.md', 'docs/README.md'),
        suffixRecord('README.md', 'src/README.md'),
      ],
    });

    const result = await searchHybrid('readme', { island: 'isle', expand: false });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].id).toBe('README.md'); // the unlinked vector path
    expect(result.hits[0].sources).toEqual(['vector']);
    expect(result.hits[0].type).toBeUndefined();
  });

  it('keeps source-less vector hits apart instead of merging them into one', async () => {
    vectorSearch.mockResolvedValue([
      { text: 'first', metadata: {}, score: 0.9 },
      { text: 'second', metadata: {}, score: 0.8 },
    ]);
    fakeDriver({ search: [] });

    const result = await searchHybrid('x', { island: 'isle', expand: false });
    expect(result.hits).toHaveLength(2);
    expect(new Set(result.hits.map((h) => h.id)).size).toBe(2);
    expect(result.hits.every((h) => h.id !== '')).toBe(true);
  });

  it('still answers from the graph when the vector store fails, and says so', async () => {
    vectorSearch.mockRejectedValue(new Error('chroma unreachable'));
    fakeDriver({ search: [entityRecord('n', 'docs/plans/PLAN.md', 'Plan')] });

    const result = await searchHybrid('plan', { island: 'isle', expand: false });
    expect(result.degraded).toBe(true);
    expect(result.vector).toEqual({ available: false, count: 0, error: 'chroma unreachable' });
    expect(result.graph.available).toBe(true);
    expect(result.graph.count).toBe(1);
    expect(result.hits.map((h) => h.id)).toEqual(['docs/plans/PLAN.md']);
  });

  it('still answers from the vector store when the graph fails, and says so', async () => {
    vectorSearch.mockResolvedValue([
      { text: 'prose', metadata: { source: 'notes.md' }, score: 0.7 },
    ]);
    fakeDriver({ failOn: 'search' });

    const result = await searchHybrid('notes', { island: 'isle', expand: false });
    expect(result.degraded).toBe(true);
    expect(result.graph.available).toBe(false);
    expect(result.graph.error).toContain('unavailable');
    expect(result.vector.count).toBe(1);
    expect(result.hits.map((h) => h.id)).toEqual(['notes.md']);
  });

  it('labels a failed LINKING step without claiming the graph is down', async () => {
    vectorSearch.mockResolvedValue([
      { text: 'prose', metadata: { source: 'notes.md' }, score: 0.7 },
    ]);
    fakeDriver({ search: [entityRecord('n', 'docs/notes.md', 'Doc')], failOn: 'suffix' });

    const result = await searchHybrid('notes', { island: 'isle', expand: false });
    // The graph answered — but the vector hits could not be linked to it.
    expect(result.graph.available).toBe(true);
    expect(result.graph.error).toContain('path linking failed');
    expect(result.degraded).toBe(true);
  });

  it('flags the in-memory fallback, where "no results" does not mean "no match"', async () => {
    vectorSearch.mockResolvedValue([]);
    vi.mocked(usingChroma).mockReturnValue(false);
    fakeDriver({ search: [] });

    const result = await searchHybrid('anything', { island: 'isle', expand: false });
    // searchKnowledge did NOT throw — without the backend check this would
    // look like a complete search that found nothing.
    expect(result.vector.available).toBe(true);
    expect(result.vector.backend).toBe('memory');
    expect(result.vector.error).toContain('in-memory fallback');
    expect(result.degraded).toBe(true);
  });

  it('scopes both stores to the caller island and validates it up front', async () => {
    vectorSearch.mockResolvedValue([]);
    const { executeQuery } = fakeDriver({ search: [] });

    await searchHybrid('auth', { island: 'caller-isle', expand: false });
    expect(vectorSearch).toHaveBeenCalledWith('auth', expect.any(Number), 'caller-isle');
    const [, params] = executeQuery.mock.calls.at(-1) as unknown as [string, { island: string }];
    expect(params.island).toBe('caller-isle');

    // A malformed island is a caller error, not "both stores are down".
    await expect(searchHybrid('auth', { island: 'Bad Island!' })).rejects.toBeInstanceOf(
      UnknownIslandError
    );
  });

  it('samples neighbours with an honest total, and bounds the expansion', async () => {
    vectorSearch.mockResolvedValue([]);
    const { executeQuery } = fakeDriver({
      // Four graph hits, but only EXPAND_TOP (3) may be expanded.
      search: ['a', 'b', 'c', 'd'].map((n) => entityRecord('n', `src/${n}.ts`)),
      // Eight dependents, but only MAX_RELATED_PER_HIT (5) are listed.
      traverse: Array.from({ length: 8 }, (_, i) => entityRecord('m', `src/dep${i}.ts`)),
    });

    const result = await searchHybrid('src', { island: 'isle', limit: 4 });
    const traversals = executeQuery.mock.calls.filter(
      (call) => kindOf(String(call[0])) === 'traverse'
    );
    expect(traversals).toHaveLength(3); // EXPAND_TOP, not one per hit
    expect(String(traversals[0][0])).toContain('*1..1]'); // depth 1, not deeper
    expect(result.hits[0].related).toHaveLength(5);
    expect(result.hits[0].relatedTotal).toBe(8); // "5 shown" never reads as "5 exist"
    expect(result.hits[3].related).toBeUndefined(); // beyond EXPAND_TOP
  });

  it('survives a failed expansion but admits the answer is partial', async () => {
    vectorSearch.mockResolvedValue([]);
    fakeDriver({ search: [entityRecord('n', 'src/hub.ts')], failOn: 'traverse' });

    const result = await searchHybrid('hub', { island: 'isle' });
    expect(result.hits[0].id).toBe('src/hub.ts'); // the hit itself survives
    expect(result.hits[0].related).toBeUndefined();
    expect(result.graph.error).toContain('expansion failed');
    expect(result.degraded).toBe(true);
  });

  it('skips expansion entirely when expand:false', async () => {
    vectorSearch.mockResolvedValue([]);
    const { executeQuery } = fakeDriver({ search: [entityRecord('n', 'src/hub.ts')] });
    await searchHybrid('hub', { island: 'isle', expand: false });
    expect(executeQuery.mock.calls.filter((c) => kindOf(String(c[0])) === 'traverse')).toHaveLength(
      0
    );
  });

  it('clamps the limit and bounds the fan-out asked of each store', async () => {
    vectorSearch.mockResolvedValue([]);
    const { executeQuery } = fakeDriver({ search: [] });
    await searchHybrid('auth', { island: 'isle', limit: 9999, expand: false });
    // limit clamps to MAX_LIMIT (25), fan-out is 2x that.
    expect(vectorSearch.mock.calls[0][1]).toBe(50);
    const [, params] = executeQuery.mock.calls.at(-1) as unknown as [
      string,
      { limit: { toNumber(): number } },
    ];
    expect(params.limit.toNumber()).toBe(50);

    vectorSearch.mockClear();
    await searchHybrid('auth', { island: 'isle', limit: Number('abc'), expand: false });
    expect(vectorSearch.mock.calls[0][1]).toBe(10); // default 5, fan-out 10
  });
});
