/**
 * MCP Tools Index
 * Base tool infrastructure for MCP server
 */

export * from './base-tool';

// Export the global registry
export { toolRegistry, ToolRegistry } from './base-tool';

/**
 * Initialize all MCP tools
 * Tool implementations will be added as the DDD refactoring progresses
 */
export function initializeTools(): void {
  // TODO: Add tool registrations as they are implemented
  // registerTerminalTools(toolRegistry);
  // registerMailboxTools(toolRegistry);
}
