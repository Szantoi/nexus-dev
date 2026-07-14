/**
 * MCP tool registry tests (EPIC-KS-MCP-SPLIT)
 *
 * Verifies the registry seam that mcp.ts dispatches through:
 * - registerAllTools() registers the migrated groups
 * - definitions are exposed for tools/list
 * - handlers execute with the same result shape the legacy switch produced
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock the heavy backends before importing the registry modules.
vi.mock('../../vectorStore', () => ({
  searchKnowledge: vi.fn(async (query: string, limit: number) => [
    { text: `result for ${query}`, metadata: { source: 'test.md' }, score: 0.9 },
  ]),
}));

import { toolRegistry, registerAllTools } from '../../interfaces/mcp/tools';
import { searchKnowledge } from '../../vectorStore';

beforeAll(() => {
  registerAllTools();
});

describe('MCP tool registry', () => {
  it('registers the migrated tool groups', () => {
    // knowledge group
    expect(toolRegistry.has('search_knowledge')).toBe(true);
    // task-message-box group
    expect(toolRegistry.has('tmb_create_task')).toBe(true);
    expect(toolRegistry.has('tmb_get_inbox')).toBe(true);
    // workflow group (renamed tool included)
    expect(toolRegistry.has('list_workflows')).toBe(true);
    expect(toolRegistry.has('get_workflow_details')).toBe(true);
    // the legacy WORKFLOW.md tool must NOT be in the registry (still in mcp.ts)
    expect(toolRegistry.has('get_workflow')).toBe(false);
  });

  it('is idempotent — double registration does not duplicate definitions', () => {
    const before = toolRegistry.getDefinitions().length;
    registerAllTools();
    expect(toolRegistry.getDefinitions().length).toBe(before);
  });

  it('exposes definitions with name/description/inputSchema for tools/list', () => {
    const defs = toolRegistry.getDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
    }
  });

  it('search_knowledge handler returns the legacy result shape', async () => {
    const handler = toolRegistry.getHandler('search_knowledge');
    expect(handler).toBeDefined();

    const result = await handler!({ query: 'EF Core migration', limit: 3 }, {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ query: 'EF Core migration', limit: 3, count: 1 });
    expect(payload.results[0].text).toContain('EF Core migration');
    expect(searchKnowledge).toHaveBeenCalledWith('EF Core migration', 3);
  });

  it('search_knowledge clamps limit to 20 and defaults to 5', async () => {
    const handler = toolRegistry.getHandler('search_knowledge')!;

    await handler({ query: 'q', limit: 100 }, {});
    expect(searchKnowledge).toHaveBeenLastCalledWith('q', 20);

    await handler({ query: 'q' }, {});
    expect(searchKnowledge).toHaveBeenLastCalledWith('q', 5);
  });

  it('unknown tools are not claimed by the registry (legacy switch fallback)', () => {
    expect(toolRegistry.getHandler('telegram_reply')).toBeUndefined();
    expect(toolRegistry.getHandler('list_inbox')).toBeUndefined();
  });
});
