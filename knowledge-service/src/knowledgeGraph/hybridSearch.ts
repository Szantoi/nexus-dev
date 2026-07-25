/**
 * Hybrid search: semantic (vector) + structural (graph) retrieval fused into
 * ONE ranked list.
 *
 * The two stores answer different questions. The vector index knows what a
 * document is ABOUT (semantic similarity over knowledge-base chunks); the
 * graph knows how code and docs are CONNECTED (ids, types, dependencies).
 * Fusing them means a hit found by both ranks above one found by either alone,
 * and a semantic hit can carry its structural neighbourhood with it.
 *
 * Availability model differs from impact analysis ON PURPOSE. A search may
 * degrade: half an answer is still a useful answer, as long as it says so —
 * every result therefore reports which subsystem contributed, which failed,
 * and (for the vector side) whether it served from the real index or from the
 * in-memory fallback, which holds only what this process indexed.
 * (Impact analysis must NOT degrade: a partial dependent set reads as "nothing
 * breaks", which is why it fails closed instead.)
 */

import { ISLAND_ID_RX, UnknownIslandError, searchKnowledge, usingChroma } from '../vectorStore';
import { findEntitiesByPathSuffix, searchEntitiesByTerms, traverse } from './graphStore';
import type { EntityType, GraphEntity } from './types';

/** Reciprocal-rank-fusion constant; 60 is the value from the original paper. */
const RRF_K = 60;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
/** How many top hits get their graph neighbourhood attached. */
const EXPAND_TOP = 3;
const MAX_RELATED_PER_HIT = 5;
const SNIPPET_CHARS = 240;
/** Lexical probes derived from the query for the graph side. */
const MAX_QUERY_TERMS = 6;
const MIN_TERM_LENGTH = 2;

export interface HybridHit {
  /** Graph entity id when known, otherwise the vector source path. */
  id: string;
  name: string;
  /** Only set when the graph knows this entity. */
  type?: EntityType;
  /**
   * Reciprocal-rank-fusion score. Deliberately NOT named `score`: it is a
   * rank-fusion number (~0.008–0.033), not a similarity like the one
   * search_knowledge returns, and the two must never be compared.
   */
  fusionScore: number;
  /** Which subsystems produced this hit ('vector', 'graph', or both). */
  sources: Array<'vector' | 'graph'>;
  snippet?: string;
  /** Up to MAX_RELATED_PER_HIT direct dependents — a SAMPLE of relatedTotal. */
  related?: string[];
  /** How many direct dependents exist in total. */
  relatedTotal?: number;
  /** True when even relatedTotal is capped by the store's traversal limit. */
  relatedTruncated?: boolean;
}

export interface SubsystemState {
  /** False when the subsystem could not answer at all. */
  available: boolean;
  /** Raw hit count from that subsystem, before fusion. */
  count: number;
  /** Vector side only: which store actually answered. */
  backend?: 'chroma' | 'memory';
  /** Set whenever anything failed here — including a PARTIAL failure. */
  error?: string;
}

export interface HybridSearchResult {
  hits: HybridHit[];
  vector: SubsystemState;
  graph: SubsystemState;
  /** True when any part of the search did not run — the answer is partial. */
  degraded: boolean;
}

function clampLimit(value: number | undefined): number {
  const n = Math.floor(value ?? DEFAULT_LIMIT);
  if (Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** Windows-safe: the vector index stores OS-native separators. */
function toPosixPath(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).join('/');
}

/**
 * Lexical probes for the graph side. The graph matches substrings, so a whole
 * natural-language question never matches anything — it has to be split.
 * Dots/dashes/underscores stay INSIDE a term so 'vectorStore.ts' survives.
 */
export function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((term) => term.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((term) => term.length >= MIN_TERM_LENGTH);
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Accumulator {
  id: string;
  name: string;
  type?: EntityType;
  score: number;
  sources: Set<'vector' | 'graph'>;
  snippet?: string;
}

function accumulate(
  into: Map<string, Accumulator>,
  key: string,
  rank: number,
  source: 'vector' | 'graph',
  fields: { name: string; type?: EntityType; snippet?: string }
): void {
  const existing = into.get(key);
  const contribution = 1 / (RRF_K + rank);
  if (existing === undefined) {
    into.set(key, {
      id: key,
      name: fields.name,
      type: fields.type,
      score: contribution,
      sources: new Set([source]),
      snippet: fields.snippet,
    });
    return;
  }
  // ONE rank per (key, store). A document split into N chunks appears N times
  // in the SAME store's list under one key; summing those would let a chunked
  // single-store file outrank a hit that both stores found — the exact
  // opposite of what this module promises. Lists arrive best-first, so the
  // first occurrence is already that store's best rank.
  if (!existing.sources.has(source)) existing.score += contribution;
  existing.sources.add(source);
  // The graph knows the authoritative type/name; the vector side knows text.
  if (fields.type !== undefined) existing.type = fields.type;
  if (existing.snippet === undefined && fields.snippet !== undefined)
    existing.snippet = fields.snippet;
}

/**
 * Run both retrievers, link vector hits to graph entities by path, and fuse
 * the two rankings. Neither subsystem's failure hides the other's results.
 */
export async function searchHybrid(
  query: string,
  options: { island?: string; limit?: number; expand?: boolean } = {}
): Promise<HybridSearchResult> {
  // Validate the island BEFORE either call, so a bad island is a caller error
  // rather than "both subsystems happen to be unavailable".
  const island = options.island;
  if (island !== undefined && !ISLAND_ID_RX.test(island)) throw new UnknownIslandError(island);

  const limit = clampLimit(options.limit);
  const fanOut = Math.min(limit * 2, MAX_LIMIT * 2);

  const vector: SubsystemState = { available: true, count: 0 };
  const graph: SubsystemState = { available: true, count: 0 };

  const [vectorHits, graphHits] = await Promise.all([
    searchKnowledge(query, fanOut, island).catch((err) => {
      vector.available = false;
      vector.error = errorMessage(err);
      return [];
    }),
    searchEntitiesByTerms(queryTerms(query), { island, limit: fanOut }).catch((err) => {
      graph.available = false;
      graph.error = errorMessage(err);
      return [] as GraphEntity[];
    }),
  ]);
  vector.count = vectorHits.length;
  graph.count = graphHits.length;

  // An empty result from the in-memory fallback is NOT "nothing matched": the
  // real index was never reachable. searchKnowledge does not throw in that
  // case, so without this the answer would look complete.
  if (vector.available) {
    vector.backend = usingChroma() ? 'chroma' : 'memory';
    if (vector.backend === 'memory') {
      vector.error =
        'serving from the in-memory fallback (ChromaDB not connected) — semantic ' +
        'results cover only what this process indexed';
    }
  }

  // Link vector hits to graph entities by path suffix — only when the suffix
  // identifies exactly ONE entity, so an ambiguous filename never merges two
  // different files into one hit.
  const sources = vectorHits.map((hit) => toPosixPath(String(hit.metadata?.source ?? '')));
  let linked = new Map<string, GraphEntity[]>();
  if (graph.available && sources.some((s) => s !== '')) {
    linked = await findEntitiesByPathSuffix(sources, island).catch((err) => {
      // The graph ANSWERED (its own hits are in the list) — only the linking
      // step failed, so `available` stays true and the error explains the gap.
      graph.error = `path linking failed: ${errorMessage(err)}`;
      return new Map<string, GraphEntity[]>();
    });
  }

  const fused = new Map<string, Accumulator>();

  vectorHits.forEach((hit, index) => {
    const source = sources[index];
    const matches = linked.get(source) ?? [];
    const entity = matches.length === 1 ? matches[0] : undefined;
    const text = String(hit.text ?? '');
    // `||` not `??`: a source-less hit must not key on '', or every such hit
    // would merge into one phantom result whose fused score outranks the rest.
    const key = entity?.id || source || `vector-hit-${index}`;
    accumulate(fused, key, index + 1, 'vector', {
      name: entity?.name || String(hit.metadata?.name ?? '') || source || key,
      type: entity?.type,
      snippet: text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text,
    });
  });

  graphHits.forEach((entity, index) => {
    accumulate(fused, entity.id, index + 1, 'graph', { name: entity.name, type: entity.type });
  });

  const ranked = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);

  const hits: HybridHit[] = ranked.map((entry) => ({
    id: entry.id,
    name: entry.name,
    ...(entry.type === undefined ? {} : { type: entry.type }),
    fusionScore: Number(entry.score.toFixed(6)),
    sources: [...entry.sources].sort(),
    ...(entry.snippet === undefined || entry.snippet === '' ? {} : { snippet: entry.snippet }),
  }));

  // Structural context for the top hits the graph actually knows. Bounded:
  // depth 1, at most EXPAND_TOP queries, so a search never turns into a deep
  // traversal.
  if (options.expand !== false && graph.available) {
    const expandable = hits.filter((hit) => hit.type !== undefined).slice(0, EXPAND_TOP);
    await Promise.all(
      expandable.map(async (hit) => {
        try {
          const { hits: neighbours, truncated } = await traverse(hit.id, {
            island,
            direction: 'dependents',
            depth: 1,
          });
          if (neighbours.length > 0) {
            // `related` is a SAMPLE — the total says how much was left out, so
            // "5 shown" can never be read as "5 exist".
            hit.related = neighbours.slice(0, MAX_RELATED_PER_HIT).map((n) => n.entity.id);
            hit.relatedTotal = neighbours.length;
            if (truncated) hit.relatedTruncated = true;
          }
        } catch (err) {
          // Expansion is a bonus, never the answer — a failure leaves the hit
          // without `related` instead of failing the search, but the response
          // still has to admit it was partial.
          graph.error = graph.error ?? `neighbour expansion failed: ${errorMessage(err)}`;
        }
      })
    );
  }

  return {
    hits,
    vector,
    graph,
    // ANY failure — including a partial one — makes the answer partial.
    degraded:
      !vector.available ||
      !graph.available ||
      vector.error !== undefined ||
      graph.error !== undefined,
  };
}
