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
          results: hits,
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
          affected_by_type: byType,
        });
      } catch (err) {
        return graphError(err);
      }
    }
  );
}
