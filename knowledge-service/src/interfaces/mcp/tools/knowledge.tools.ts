/**
 * Knowledge MCP tools — full extraction example.
 *
 * Unlike the adapter modules (workflow, task-message-box) that delegate to
 * legacy handler functions, this module owns both the definition and the
 * implementation. New tools and future extractions from mcp.ts should
 * follow this shape.
 */

import { toolRegistry, success } from './base-tool';
import { searchKnowledge } from '../../../vectorStore';

export function registerKnowledgeTools(): void {
  toolRegistry.register(
    {
      name: 'search_knowledge',
      description:
        'Search the SpaceOS knowledge base using semantic search. Returns relevant documentation chunks.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query (semantic search)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 5, max: 20)',
          },
        },
        required: ['query'],
      },
    },
    async (args) => {
      const query = String(args.query || '');
      const limit = Math.min(Number(args.limit) || 5, 20);
      const results = await searchKnowledge(query, limit);
      return success({ query, limit, count: results.length, results });
    }
  );
}
