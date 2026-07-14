/**
 * MCP tool registry — composition point.
 *
 * registerAllTools() is called once by mcp.ts at startup. Tools registered
 * here are automatically served by mcp.ts (tools/list + dispatch); the giant
 * switch in mcp.ts is only consulted for tools NOT yet migrated to the
 * registry. See README.md in this folder for the migration recipe.
 */

export * from './base-tool';

import { registerKnowledgeTools } from './knowledge.tools';
import { registerTaskMessageBoxTools } from './task-message-box.tools';
import { registerWorkflowTools } from './workflow.tools';

let registered = false;

export function registerAllTools(): void {
  if (registered) return;
  registered = true;

  registerKnowledgeTools();
  registerTaskMessageBoxTools();
  registerWorkflowTools();
}
