/**
 * Knowledge-graph MCP tools (GraphRAG pilot — docs/plans/GRAPHRAG-PILOT.md).
 *
 * Follows knowledge.tools.ts: the module owns definition + implementation.
 * The island ALWAYS comes from the caller's identity (context), never from
 * tool arguments — an agent cannot read another island's graph.
 */

import {
  GraphDisabledError,
  GraphUnavailableError,
  MAX_TRAVERSAL_DEPTH,
  searchEntities,
  traverse,
} from '../../../knowledgeGraph/graphStore';
import {
  type CoversLayerStatus,
  coversLayerStatus,
} from '../../../knowledgeGraph/indexBookkeeping';
import { searchHybrid } from '../../../knowledgeGraph/hybridSearch';
import { ENTITY_TYPES, RELATION_TYPES } from '../../../knowledgeGraph/types';
import { error, success, toolRegistry, type ToolResult } from './base-tool';

/** impact_analysis looks two hops further than the raw traversal default. */
const IMPACT_DEFAULT_DEPTH = 3;

function graphError(err: unknown): ToolResult {
  if (err instanceof GraphDisabledError || err instanceof GraphUnavailableError)
    return error(err.message);
  throw err;
}

type NumericArg = { ok: true; value: number | undefined } | { ok: false };

/**
 * Numeric tool argument. Absent/null means "use the TOOL's documented default"
 * (Number(null) would be 0, i.e. the minimum), and non-numeric garbage is
 * refused loudly — silently substituting a default would answer a different,
 * smaller question than the caller asked. ±Infinity is left to the store's
 * clamp, which maps it to the bound.
 */
function numericArg(value: unknown): NumericArg {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const n = Number(value);
  return Number.isNaN(n) ? { ok: false } : { ok: true, value: n };
}

/**
 * Wire format of the COVERS-layer freshness signal. Attached to the two tools
 * whose answers a caller may read as "which tests cover this file": an answer
 * built on stale or missing COVERS edges must SAY so (the recurring failure
 * class is the confident incomplete answer), and `unknown` stays distinct
 * from `absent` — inability to read the status is not a statement about the
 * graph.
 */
function coversLayerWire(status: CoversLayerStatus): Record<string, unknown> {
  switch (status.status) {
    case 'fresh':
      return { status: 'fresh', indexed_at: status.indexedAt };
    case 'stale':
      return {
        status: 'stale',
        covers_indexed_at: status.coversIndexedAt,
        island_indexed_at: status.islandIndexedAt,
        note:
          'COVERS (test→code) edges predate the island\'s latest index run — ' +
          'test lists may be stale; refresh with `npm run coverage:index` on ' +
          'the coverage-producing machine.',
      };
    case 'absent':
      return {
        status: 'absent',
        note:
          'No test→code (COVERS) layer is indexed for this island — test ' +
          'coverage questions cannot be answered from the graph. Run ' +
          '`npm run coverage:index` on the machine that produces coverage.',
      };
    case 'unknown':
      return { status: 'unknown', error: status.error };
  }
}

/**
 * A missing start entity must never read as "nothing depends on it" — the
 * silent false negative an impact tool can least afford.
 */
function notFoundResult(entityId: string): ToolResult {
  return error(
    `Entity not found in the knowledge graph: "${entityId}". Entity ids are ` +
      'repo-relative paths — use search_graph to find the exact id, and re-index ' +
      '(npm run graph:index) if it was added after the last indexing run.'
  );
}

export function registerGraphTools(): void {
  toolRegistry.register(
    {
      name: 'search_graph',
      description:
        'Search code/doc entities in the knowledge graph by name or id ' +
        '(substring match). Returns entities with type and file path — use ' +
        'get_dependencies / impact_analysis to explore their relationships.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against entity name/id' },
          entity_type: {
            type: 'string',
            enum: [...ENTITY_TYPES],
            description: 'Optional filter to one entity type',
          },
          limit: { type: 'number', description: 'Maximum results (default: 10, max: 50)' },
        },
        required: ['query'],
      },
    },
    async (args, context) => {
      const query = String(args.query || '');
      if (query.trim().length === 0) return error('query must be a non-empty string');
      const limit = numericArg(args.limit);
      if (!limit.ok) return error('limit must be a number');
      try {
        const results = await searchEntities(query, {
          island: context?.island,
          type: args.entity_type === undefined ? undefined : String(args.entity_type),
          limit: limit.value,
        });
        return success({ query, count: results.length, results });
      } catch (err) {
        return graphError(err);
      }
    }
  );

  toolRegistry.register(
    {
      name: 'get_dependencies',
      description:
        'List what a code/doc entity depends on (outgoing edges) or what ' +
        'depends on it (incoming), up to a bounded depth. Entity ids are ' +
        'repo-relative paths — find them with search_graph first.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Entity id (repo-relative path)' },
          direction: {
            type: 'string',
            enum: ['dependencies', 'dependents'],
            description: 'dependencies = what it uses; dependents = what uses it (default)',
          },
          depth: {
            type: 'number',
            description: `Traversal depth 1..${MAX_TRAVERSAL_DEPTH} (default: 2)`,
          },
          relation_types: {
            type: 'string',
            enum: [...RELATION_TYPES],
            description: 'Optional filter to one relation type',
          },
        },
        required: ['entity_id'],
      },
    },
    async (args, context) => {
      const entityId = String(args.entity_id || '');
      if (entityId.trim().length === 0) return error('entity_id must be a non-empty string');
      const direction = args.direction === 'dependencies' ? 'dependencies' : 'dependents';
      const depthArg = numericArg(args.depth);
      if (!depthArg.ok) return error('depth must be a number');
      try {
        const { hits, truncated, found, depth } = await traverse(entityId, {
          island: context?.island,
          direction,
          depth: depthArg.value,
          relationTypes:
            args.relation_types === undefined ? undefined : [String(args.relation_types)],
        });
        if (!found) return notFoundResult(entityId);
        return success({
          entity_id: entityId,
          direction,
          depth,
          count: hits.length,
          truncated,
          // A caller reading COVERS edges out of this answer must know how
          // fresh that layer is (it only updates where coverage is produced).
          covers_layer: coversLayerWire(await coversLayerStatus(context?.island)),
          results: hits,
        });
      } catch (err) {
        return graphError(err);
      }
    }
  );

  toolRegistry.register(
    {
      name: 'search_hybrid',
      description:
        'Search knowledge semantically (vector) AND structurally (graph) in ' +
        'one call, fused into a single ranking: a hit found by both ranks ' +
        'highest, and top hits carry their direct graph dependents. Use this ' +
        'as the default "find me things about X"; use search_knowledge for ' +
        'pure prose recall and search_graph for exact id/name lookup. The ' +
        'response reports which subsystem answered — a degraded search is ' +
        'labelled, never silently halved. `fusion_score` is a rank-fusion ' +
        'number, NOT comparable with search_knowledge similarity scores.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for (free text)' },
          limit: { type: 'number', description: 'Maximum fused results (default: 5, max: 25)' },
          expand: {
            type: 'boolean',
            description: 'Attach 1-hop graph neighbours to the top hits (default: true)',
          },
        },
        required: ['query'],
      },
    },
    async (args, context) => {
      const query = String(args.query || '');
      if (query.trim().length === 0) return error('query must be a non-empty string');
      const limit = numericArg(args.limit);
      if (!limit.ok) return error('limit must be a number');
      try {
        const result = await searchHybrid(query, {
          island: context?.island,
          limit: limit.value,
          expand: args.expand !== false,
        });
        return success({
          query,
          count: result.hits.length,
          // A caller must be able to tell "nothing matched" from "half the
          // search did not run".
          degraded: result.degraded,
          vector: result.vector,
          graph: result.graph,
          results: result.hits.map((hit) => ({
            id: hit.id,
            name: hit.name,
            ...(hit.type === undefined ? {} : { type: hit.type }),
            // NOT `score`: a rank-fusion number, not search_knowledge's
            // similarity — same name would invite a meaningless comparison.
            fusion_score: hit.fusionScore,
            sources: hit.sources,
            ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
            ...(hit.related === undefined
              ? {}
              : {
                  related: hit.related,
                  // `related` is a sample; the total says what was left out.
                  related_total: hit.relatedTotal,
                  ...(hit.relatedTruncated === true ? { related_truncated: true } : {}),
                }),
          })),
        });
      } catch (err) {
        return graphError(err);
      }
    }
  );

  toolRegistry.register(
    {
      name: 'impact_analysis',
      description:
        'Find what would be affected by changing an entity: its transitive ' +
        'dependents up to `depth` hops (default 3), grouped by entity type and ' +
        'sorted by distance — "if I modify X, what breaks?". The answer is a ' +
        'LOWER BOUND: it echoes the effective depth, and `truncated` marks a ' +
        'result cut at the traversal cap.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Entity id (repo-relative path)' },
          depth: {
            type: 'number',
            description: `Traversal depth 1..${MAX_TRAVERSAL_DEPTH} (default: 3)`,
          },
        },
        required: ['entity_id'],
      },
    },
    async (args, context) => {
      const entityId = String(args.entity_id || '');
      if (entityId.trim().length === 0) return error('entity_id must be a non-empty string');
      const depthArg = numericArg(args.depth);
      if (!depthArg.ok) return error('depth must be a number');
      try {
        const { hits, truncated, found, depth } = await traverse(entityId, {
          island: context?.island,
          direction: 'dependents',
          depth: depthArg.value ?? IMPACT_DEFAULT_DEPTH,
        });
        if (!found) return notFoundResult(entityId);
        const byType: Record<string, Array<{ id: string; name: string; distance: number }>> = {};
        for (const hit of hits) {
          if (byType[hit.entity.type] === undefined) byType[hit.entity.type] = [];
          byType[hit.entity.type].push({
            id: hit.entity.id,
            name: hit.entity.name,
            distance: hit.distance,
          });
        }
        return success({
          entity_id: entityId,
          // The impact set covers `depth` hops only — deeper dependents exist
          // but are NOT counted here (raise depth up to MAX_TRAVERSAL_DEPTH).
          depth,
          affected_count: hits.length,
          // When true, affected_count is a LOWER BOUND — the impact set was
          // cut at the traversal cap and must not be read as complete.
          truncated,
          // Test-type dependents come from the COVERS layer — its freshness
          // bounds how much the "which tests are affected" part can be trusted.
          covers_layer: coversLayerWire(await coversLayerStatus(context?.island)),
          affected_by_type: byType,
        });
      } catch (err) {
        return graphError(err);
      }
    }
  );
}
