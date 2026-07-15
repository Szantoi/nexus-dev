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
    // workflow group
    expect(toolRegistry.has('list_workflows')).toBe(true);
    expect(toolRegistry.has('get_workflow_details')).toBe(true);
    // skills group (migrated from mcp.ts)
    expect(toolRegistry.has('get_workflow')).toBe(true);
    // identity group
    expect(toolRegistry.has('get_identity')).toBe(true);
    expect(toolRegistry.has('list_terminals')).toBe(true);
    // mailbox group
    expect(toolRegistry.has('list_inbox')).toBe(true);
    expect(toolRegistry.has('create_task')).toBe(true);
    // telegram group
    expect(toolRegistry.has('telegram_reply')).toBe(true);
    // goal/memory group
    expect(toolRegistry.has('create_goal')).toBe(true);
    // worker group
    expect(toolRegistry.has('spawn_parallel_workers')).toBe(true);
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

  it('now-migrated tools are claimed by the registry', () => {
    // These were previously in mcp.ts switch, now migrated to registry
    expect(toolRegistry.getHandler('telegram_reply')).toBeDefined();
    expect(toolRegistry.getHandler('list_inbox')).toBeDefined();
    expect(toolRegistry.getHandler('create_goal')).toBeDefined();
    expect(toolRegistry.getHandler('spawn_parallel_workers')).toBeDefined();
  });

  it('unknown/nonexistent tools are not in the registry', () => {
    expect(toolRegistry.getHandler('nonexistent_tool_xyz')).toBeUndefined();
    expect(toolRegistry.getHandler('fake_tool_123')).toBeUndefined();
  });
});
