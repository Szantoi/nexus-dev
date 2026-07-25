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
import { registerGraphTools } from './graph.tools';
import { registerTaskMessageBoxTools } from './task-message-box.tools';
import { registerWorkflowTools } from './workflow.tools';
import { registerIdentityTools } from './identity.tools';
import { registerSkillsTools } from './skills.tools';
import { registerTerminalStatusTools } from './terminal-status.tools';
import { registerMailboxTools } from './mailbox.tools';
import { registerFocusQueueTools } from './focus-queue.tools';
import { registerSessionTools } from './session.tools';
import { registerProjectTools } from './project.tools';
import { registerTelegramTools } from './telegram.tools';
import { registerCodegenTools } from './codegen.tools';
import { registerGoalTools } from './goal.tools';
import { registerWorkerTools } from './worker.tools';

let registered = false;

export function registerAllTools(): void {
  if (registered) return;
  registered = true;

  registerKnowledgeTools();
  registerGraphTools();
  registerTaskMessageBoxTools();
  registerWorkflowTools();
  registerIdentityTools();
  registerSkillsTools();
  registerTerminalStatusTools();
  registerMailboxTools();
  registerFocusQueueTools();
  registerSessionTools();
  registerProjectTools();
  registerTelegramTools();
  registerCodegenTools();
  registerGoalTools();
  registerWorkerTools();
}
