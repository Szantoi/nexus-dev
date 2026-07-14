/**
 * Workflow Management MCP tools — registry adapter.
 *
 * Definitions and business logic live in workflowManager.ts; this module
 * only bridges them onto the ToolRegistry so mcp.ts no longer needs the
 * spread-into-TOOLS + case-list pattern.
 */

import { toolRegistry, type ToolDefinition, type ToolResult } from './base-tool';
import { WORKFLOW_TOOLS, handleWorkflowTool } from '../../../workflowManager';

export function registerWorkflowTools(): void {
  for (const def of WORKFLOW_TOOLS) {
    // Legacy inputSchema literals are structurally compatible but not typed
    // as ToolParameter; keep the cast local to this adapter.
    toolRegistry.register(
      def as unknown as ToolDefinition,
      async (args) => handleWorkflowTool(def.name, args) as ToolResult
    );
  }
}
