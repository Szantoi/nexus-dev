/**
 * TaskMessageBox MCP tools — registry adapter.
 *
 * Definitions and business logic live in task-message-box/; this module
 * only bridges them onto the ToolRegistry.
 */

import { toolRegistry, type ToolDefinition, type ToolResult } from './base-tool';
import { TASK_MESSAGE_BOX_TOOLS, handleTaskMessageBoxTool } from '../../../task-message-box';

export function registerTaskMessageBoxTools(): void {
  for (const def of TASK_MESSAGE_BOX_TOOLS) {
    toolRegistry.register(
      def as unknown as ToolDefinition,
      async (args) => (await handleTaskMessageBoxTool(def.name, args)) as ToolResult
    );
  }
}
