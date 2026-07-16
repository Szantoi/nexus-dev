/**
 * MCP (Model Context Protocol) HTTP Transport Implementation
 *
 * Implements the MCP protocol for Claude Code integration.
 * Tools: 32 tools across 9 categories (knowledge, mailbox, identity, skills, terminal-docs, terminal-status, system, project-automation, memory-management)
 */

import { Router, Request, Response } from 'express';
import { searchKnowledge, getDocumentCount, usingChroma } from './vectorStore';
import { embeddingBackend } from './embeddings';
import { listInbox, listInboxMetadata, sendMessage, submitDone, getTaskStatus, readInboxMessage, completeInboxMessage, appendToMessage, createTask } from './mailbox';
// Registry-based tools (EPIC-KS-MCP-SPLIT): groups migrated out of this file
// live under interfaces/mcp/tools/ and are dispatched via toolRegistry.
import { toolRegistry, registerAllTools } from './interfaces/mcp/tools';
import {
  getIdentity,
  listTerminals,
  readMemory,
  writeMemory,
  appendMemory,
  getCapabilities,
  TERMINALS,
} from './identity';
import {
  registerWorking,
  registerIdle,
  shouldWakeUp,
  getAllStatus,
  getStatus,
  // Focus queue functions
  setFocusQueue,
  addFocusItem,
  setActiveTask,
  setTaskBlocked,
  setTaskDone,
  removeFocusItem,
  getFocusQueue,
  clearDoneTasks,
  type FocusItem,
} from './terminalStatus';
import {
  listSkills,
  getSkill,
  getWorkflow,
  getTerminalSetup,
  getProjectContext,
  listTerminalDocs,
  getTerminalDocs,
  getTerminalsIndex,
} from './skills';
import {
  handleCreateProject,
  handleGetProjectStatus,
  handleDispatchNext,
  handleListBlocked,
  handleGenerateSkeleton,
  handleGenerateEndpoint,
} from './projectTools';
import {
  saveTieredMemory,
  queryByTier,
  promoteMemory,
} from './pipeline/memoryStore';
import { buildStartContext } from './sessionHooks';
import { runRetrospective, applyRetrospective } from './retrospective';
import { generateHandoff } from './handoff';
import { generateDailyDigest } from './digest';
import {
  fetchTaskForMcp,
  ackTaskForMcp,
  completeTaskForMcp,
  verifyTerminalToken,
} from './interfaces/http/routes/epic-router.routes';
import {
  queueResponse,
  getConversation,
  findActiveConversation,
  createConversation,
  getConversationMessages,
  addMessage,
  getLastIncomingMessageId,
} from './telegram/conversationManager';
import { sendTelegramMessage, injectMessageToTerminal } from './telegram/telegramService';
import {
  startParallelWorkSession,
  spawnRawWorkers,
  collectRawResults,
} from './sessionStarter';
import {
  getActiveWorkers,
  registerWorker,
  markWorkerDone,
  markWorkerFailed,
} from './pipeline/workerRegistry';
import {
  validateDependencies,
  getParallelBatches,
} from './pipeline/dagValidator';
import {
  getCurrentHourlyCost,
  calculateMaxParallel,
  checkCostAlerts,
} from './pipeline/costLimiter';
import {
  generateApiClient,
  generateComponent,
  generateModule,
  generateHook,
  getCodegenStatus,
  type GenerateApiClientParams,
  type GenerateComponentParams,
  type GenerateModuleParams,
  type GenerateHookParams,
  // Frontend Verification Tools (MSG-NEXUS-002)
  checkApiClientStatus,
  verifyFrontendBuild,
  analyzeBundleSize,
  scaffoldFromPattern,
  listAvailablePatterns,
  type CheckApiClientStatusParams,
  type VerifyFrontendBuildParams,
  type AnalyzeBundleSizeParams,
  type ScaffoldFromPatternParams,
} from './codegen/index';
import { getTerminalStatusAggregate } from './pipeline/terminalStatusAggregator';
import { resolveDependencies } from './pipeline/dependencyResolver';
import { transferSessionContext } from './pipeline/sessionContextTransfer';
import { matchDomainPattern } from './pipeline/domainPatternMatcher';
import {
  selectBestResultWithChat,
  selectBestResultAutomatic,
  type RawResult,
} from './pipeline/bestOfN';
import {
  listAvailableMemories,
  detectDomains,
  hasKnowledgeFolder,
} from './pipeline/knowledgeLoader';
import {
  SUBSCRIPTION_TOOLS,
  handleSubscriptionTool,
} from './pipeline/subscriptionTools';
import {
  createGoal,
  listGoals,
  getGoal,
  triggerGoal,
  completeGoal,
  checkGoalCriteria,
  checkExpiredGoals,
  type CreateGoalParams,
  type GoalStatus,
  type Goal,
} from './goalStore';
import {
  readStatusMd,
  writeStatusMd,
  readSessionState,
  writeSessionState,
  readTurnCount,
  incrementTurnCount,
  resetTurnCount,
  getContextSaturation,
  readCheckpointsMd,
  appendCheckpoint,
  getContextFilesStatus,
  getAllContextFilesStatus,
  buildSessionStartContext,
} from './contextPersistence';
import {
  getMemoryHealthReport,
  compressMemory,
  extractPatterns,
  type CompressMemoryParams,
  type ExtractPatternsParams,
} from './memoryTools';
import {
  createSkill,
  listSkills as listAllSkills,
  getSkillMetadata,
  deleteSkill,
  type CreateSkillParams,
  type SkillCreationResult,
} from './pipeline/skillFactory';
import {
  getEpicProgress,
  getAllEpicsProgress,
  type EpicProgress,
} from './pipeline/epicProgressTracker';

const router = Router();

// MCP Protocol Version
const MCP_VERSION = '2024-11-05';

// ─── Agent Authentication ───────────────────────────────────────────────────
// Token handling and the authenticate/authenticateRest middlewares live in
// auth/tokenAuth.ts (config/agents.yaml + MCP_AUTH_TOKEN / MCP_TOKEN_<NAME>).

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { logger } from './core/logger';
import { authenticateMcp, authenticateRest } from './auth/tokenAuth';

export { authenticateRest };

// ─── Tool Permissions (loaded from YAML config) ────────────────────────────
//
// Config file: config/tool-permissions.yaml
// Auto-reloads every 30 seconds without restart.

type ToolPermission = 'all' | 'none' | string[];

interface ToolPermissionsConfig {
  version?: string;
  updated?: string;
  default?: ToolPermission;
  permissions: Record<string, ToolPermission>;
}

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'tool-permissions.yaml');
const RELOAD_INTERVAL_MS = 30_000; // 30 seconds

let toolPermissions: Record<string, ToolPermission> = {};
let defaultPermission: ToolPermission = 'all';
let lastConfigMtime: number = 0;

/**
 * Load tool permissions from YAML config file
 */
function loadToolPermissions(): void {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    const mtime = stat.mtimeMs;

    // Skip if file hasn't changed
    if (mtime === lastConfigMtime && Object.keys(toolPermissions).length > 0) {
      return;
    }

    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = yaml.load(content) as ToolPermissionsConfig;

    if (config && config.permissions) {
      toolPermissions = config.permissions;
      defaultPermission = config.default || 'all';
      lastConfigMtime = mtime;
      logger.info(`[MCP] 🔄 Tool permissions loaded (${Object.keys(toolPermissions).length} rules, default: ${defaultPermission})`);
    }
  } catch (err) {
    if (Object.keys(toolPermissions).length === 0) {
      // First load failed - use fallback defaults
      logger.warn(`[MCP] ⚠️ Could not load tool-permissions.yaml, using defaults:`, err);
      toolPermissions = {
        'set_focus_queue': ['root', 'conductor'],
        'add_focus_item': ['root', 'conductor'],
        'set_active_task': ['root', 'conductor'],
        'set_task_status': ['root', 'conductor'],
        'get_focus_queue': 'all',
        'create_project': ['root', 'conductor'],
        'dispatch_next': ['root', 'conductor'],
        'write_memory': ['root', 'conductor', 'librarian'],
        'append_memory': ['root', 'conductor', 'librarian'],
        'save_tiered_memory': ['root', 'conductor', 'librarian'],
        'promote_memory': ['root', 'conductor', 'librarian'],
        'send_message': ['root', 'conductor'],
      };
      defaultPermission = 'all';
    }
    // If already loaded, keep existing config on reload failure
  }
}

// Initial load
loadToolPermissions();

// Auto-reload every 30 seconds
setInterval(() => {
  loadToolPermissions();
}, RELOAD_INTERVAL_MS);

/**
 * Check if terminal can use a tool
 */
function canUseTool(terminal: string, toolName: string): boolean {
  // root can do everything
  if (terminal === 'root') return true;

  const permission = toolPermissions[toolName];

  // No specific permission = use default
  if (permission === undefined) {
    if (defaultPermission === 'all') return true;
    if (defaultPermission === 'none') return false;
    if (Array.isArray(defaultPermission)) return defaultPermission.includes(terminal);
    return true;
  }

  if (permission === 'all') return true;
  if (permission === 'none') return false;

  // Array of allowed terminals
  if (Array.isArray(permission)) {
    return permission.includes(terminal);
  }

  return true;
}

/**
 * Filter tools list based on terminal permissions
 */
function filterToolsForTerminal(tools: any[], terminal: string): any[] {
  return tools.filter(tool => canUseTool(terminal, tool.name));
}

/**
 * Authorization middleware for REST /api/mailbox endpoints (MSG-NEXUS-016)
 *
 * Rules:
 * - root/conductor: full access to all mailboxes
 * - monitor: GET operations only (read-only)
 * - other terminals: only their own mailbox
 * - POST to other inbox: check create_task permission
 * - broadcast: root/conductor only
 */
export function authorizeMailboxRest(req: Request, res: Response, next: () => void): void {
  const terminal = req.mcpTerminal;
  const targetTerminal = req.params.terminal as string | undefined;
  const method = req.method;
  const path = req.path;

  if (!terminal) {
    res.status(401).json({ error: 'Unauthorized: No terminal identity' });
    return;
  }

  // root and conductor: full access
  if (terminal === 'root' || terminal === 'conductor') {
    next();
    return;
  }

  // monitor: GET only
  if (terminal === 'monitor') {
    if (method === 'GET') {
      next();
      return;
    }
    logger.warn(`[MailboxAuth] DENY: monitor attempted ${method} ${path}`);
    res.status(403).json({ error: 'Forbidden: monitor can only perform GET operations' });
    return;
  }

  // Broadcast endpoint: root/conductor only
  if (path === '/broadcast') {
    logger.warn(`[MailboxAuth] DENY: ${terminal} attempted broadcast`);
    res.status(403).json({ error: 'Forbidden: Only root/conductor can broadcast' });
    return;
  }

  // Counter and unread outbox: allow all (read-only)
  if (path === '/counter' || path === '/outbox/unread' || path === '/tasks/status') {
    next();
    return;
  }

  // Terminal-specific operations: check if accessing own mailbox
  if (targetTerminal) {
    // Own mailbox: allow all operations
    if (targetTerminal === terminal) {
      next();
      return;
    }

    // POST to other terminal's inbox: check create_task permission
    if (method === 'POST' && path.includes('/inbox')) {
      const canCreateTask = canUseTool(terminal, 'create_task');
      if (!canCreateTask) {
        logger.warn(`[MailboxAuth] DENY: ${terminal} attempted POST to ${targetTerminal}/inbox (no create_task permission)`);
        res.status(403).json({ error: `Forbidden: ${terminal} cannot send tasks to other terminals` });
        return;
      }
      next();
      return;
    }

    // All other operations on other terminal's mailbox: deny
    logger.warn(`[MailboxAuth] DENY: ${terminal} attempted ${method} ${path}`);
    res.status(403).json({ error: `Forbidden: ${terminal} can only access their own mailbox` });
    return;
  }

  // Default: allow (shouldn't reach here normally)
  next();
}

// ─── Tool Definitions ───────────────────────────────────────────────────────
// NOTE: knowledge, task-message-box and workflow tool groups moved to
// interfaces/mcp/tools/ (registry); they no longer appear in this array.

registerAllTools();

const TOOLS = [
  // Mailbox tools
  {
    name: 'list_inbox',
    description: 'List inbox messages for a terminal. Returns metadata (frontmatter + filename) by default. Set include_content=true for full message content (10× heavier).',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        status: {
          type: 'string',
          enum: ['UNREAD', 'READ', 'all'],
          description: 'Filter by status (default: all)',
        },
        include_content: {
          type: 'boolean',
          description: 'Include full message content (default: false, metadata only for performance)',
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a structured task for a terminal. Includes title, description, acceptance criteria, and tracks sender. Generates content hash for integrity.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Sender terminal name (e.g., "root", "conductor")',
        },
        to: {
          type: 'string',
          description: `Target terminal: ${TERMINALS.slice(0, 10).join(', ')}...`,
        },
        title: {
          type: 'string',
          description: 'Short task title',
        },
        description: {
          type: 'string',
          description: 'Task description (markdown)',
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of acceptance criteria (what defines "done")',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Task priority',
        },
        model: {
          type: 'string',
          enum: ['opus', 'sonnet', 'haiku'],
          description: 'Suggested model for processing',
        },
        ref: {
          type: 'string',
          description: 'Reference to related message ID (optional)',
        },
        epic_id: {
          type: 'string',
          description: 'Epic ID (e.g., "EPIC-CUTTING-Q3")',
        },
        project_id: {
          type: 'string',
          description: 'Project ID',
        },
        context: {
          type: 'string',
          description: 'Additional context (markdown)',
        },
        queue_only: {
          type: 'boolean',
          description: 'Add to queue instead of immediate dispatch',
        },
      },
      required: ['from', 'to', 'title', 'description', 'priority'],
    },
  },
  {
    name: 'send_message',
    description: '[LEGACY - use create_task for tasks] Send a new inbox message to a terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target terminal name',
        },
        type: {
          type: 'string',
          enum: ['task', 'question', 'info', 'blocked'],
          description: 'Message type',
        },
        content: {
          type: 'string',
          description: 'Message content (markdown)',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Message priority',
        },
        model: {
          type: 'string',
          enum: ['opus', 'sonnet', 'haiku'],
          description: 'Suggested model for processing',
        },
        ref: {
          type: 'string',
          description: 'Reference to related message ID (optional)',
        },
      },
      required: ['to', 'type', 'content', 'priority'],
    },
  },
  {
    name: 'submit_done',
    description: 'Submit a DONE message to the outbox. Used when a task is completed.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Terminal name submitting the DONE',
        },
        task_id: {
          type: 'string',
          description: 'Original task message ID (e.g., MSG-KERNEL-042)',
        },
        summary: {
          type: 'string',
          description: 'Summary of what was done',
        },
        files_changed: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of files that were changed',
        },
      },
      required: ['from', 'task_id', 'summary', 'files_changed'],
    },
  },

  // Direct mailbox access tools (2026-06-24)
  {
    name: 'read_inbox_message',
    description: 'Read a specific inbox message by ID. Automatically marks as READ. Use this instead of direct file access for audit trail.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        message_id: {
          type: 'string',
          description: 'Message ID to read (e.g., MSG-BACKEND-042)',
        },
      },
      required: ['terminal', 'message_id'],
    },
  },
  {
    name: 'complete_inbox_message',
    description: 'Complete a task with DONE or BLOCKED status. Server appends completion report to original inbox AND creates outbox summary. Terminal only sends response data.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        message_id: {
          type: 'string',
          description: 'Original inbox message ID to complete (e.g., MSG-BACKEND-042)',
        },
        status: {
          type: 'string',
          enum: ['done', 'blocked'],
          description: 'Completion status',
        },
        summary: {
          type: 'string',
          description: 'Short summary of what was done or why blocked',
        },
        details: {
          type: 'string',
          description: 'Detailed implementation notes (optional)',
        },
        files_changed: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of changed files (for DONE)',
        },
        blocked_reason: {
          type: 'string',
          description: 'Why the task is blocked (for BLOCKED)',
        },
        next_steps: {
          type: 'string',
          description: 'Suggested next steps (optional)',
        },
      },
      required: ['terminal', 'message_id', 'status', 'summary'],
    },
  },
  {
    name: 'append_to_message',
    description: 'Append notes, implementation details, feedback, or progress to an existing inbox/outbox message. Makes the task file a living document.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        message_id: {
          type: 'string',
          description: 'Message ID to append to',
        },
        box: {
          type: 'string',
          enum: ['inbox', 'outbox'],
          description: 'Which box the message is in',
        },
        section: {
          type: 'string',
          enum: ['notes', 'implementation', 'feedback', 'blockers', 'progress'],
          description: 'Type of content being appended',
        },
        content: {
          type: 'string',
          description: 'Content to append (markdown)',
        },
        author: {
          type: 'string',
          description: 'Author of the note (optional, defaults to terminal name)',
        },
      },
      required: ['terminal', 'message_id', 'box', 'section', 'content'],
    },
  },

  // Task tools
  {
    name: 'get_task_status',
    description: 'Get status of tasks from docs/tasks/. Returns task metadata and status.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Specific task ID to query (optional, returns all if omitted)',
        },
      },
    },
  },

  // Epic-aware task routing tools (2026-06-24)
  {
    name: 'fetch_task',
    description: 'Fetch assigned task content. Terminal can ONLY fetch the task currently assigned to it. Token authentication via MCP config.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        message_id: {
          type: 'string',
          description: 'The task message ID (e.g., MSG-BACKEND-045)',
        },
      },
      required: ['terminal', 'message_id'],
    },
  },
  {
    name: 'ack_task',
    description: 'Acknowledge task receipt. Marks the task as READ. Terminal must be authenticated.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        message_id: {
          type: 'string',
          description: 'The task message ID to acknowledge',
        },
      },
      required: ['terminal', 'message_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark task as completed. Triggers epic-aware routing to find next task. In cold mode, terminates session after completion. Terminal must be authenticated.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        message_id: {
          type: 'string',
          description: 'The task message ID to complete',
        },
        summary: {
          type: 'string',
          description: 'Task summary for memory save (used in cold session mode to persist session context)',
        },
      },
      required: ['terminal', 'message_id'],
    },
  },

  // Identity tools
  {
    name: 'get_identity',
    description: 'Get terminal identity including CLAUDE.md instructions and memory file. Use this to understand what a terminal does and its current state.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'list_terminals',
    description: 'List all SpaceOS terminals with their paths and status (has CLAUDE.md, has memory).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Memory tools
  {
    name: 'read_memory',
    description: 'Read the memory file for a specific terminal. Memory contains session state, learned patterns, and context.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'write_memory',
    description: 'Write/replace the entire memory file for a terminal. Use with caution - this overwrites existing memory.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Terminal name',
        },
        content: {
          type: 'string',
          description: 'Full memory content (markdown format)',
        },
      },
      required: ['terminal', 'content'],
    },
  },
  {
    name: 'append_memory',
    description: 'Append new content to terminal memory. Safer than write_memory - preserves existing content.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Terminal name',
        },
        content: {
          type: 'string',
          description: 'Content to append (markdown format)',
        },
      },
      required: ['terminal', 'content'],
    },
  },

  // System tools
  {
    name: 'get_capabilities',
    description: 'List all available MCP capabilities/tools, optionally filtered by category.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['knowledge', 'mailbox', 'identity', 'tasks', 'system'],
          description: 'Filter by category (optional)',
        },
      },
    },
  },
  {
    name: 'get_service_status',
    description: 'Get the health status of the SpaceOS Knowledge Service.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Skill tools
  {
    name: 'list_skills',
    description: 'List all SpaceOS skills with their descriptions. Skills define terminal behaviors and workflows.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_skill',
    description: 'Get the full content of a specific skill including SKILL.md and reference files.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'Skill name (e.g., spaceos-terminal, spaceos-root, spaceos-conductor)',
        },
      },
      required: ['skill_name'],
    },
  },
  {
    name: 'get_workflow',
    description: 'Get the full SpaceOS WORKFLOW.md - defines the pipeline, mailbox system, and terminal architecture.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_terminal_setup',
    description: 'Get complete setup instructions for a terminal: CLAUDE.md, relevant skill, workflow excerpt, and MCP config.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'get_project_context',
    description: 'Get SpaceOS project context: vision, knowledge index, and codebase status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Terminal docs tools
  {
    name: 'list_terminal_docs',
    description: 'List all terminal documentation folders with their README status, port, and type.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_terminal_docs',
    description: 'Get terminal documentation README - quick reference for session startup, commands, and workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'get_terminals_index',
    description: 'Get the main terminals INDEX.md - architecture overview, terminal list, MCP config.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Terminal status tools (wake-on-inbox support)
  {
    name: 'register_working',
    description: 'Register terminal as working on a task. Prevents wake-up notifications while busy.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        task_id: {
          type: 'string',
          description: 'Optional task ID being worked on',
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'register_idle',
    description: 'Register terminal as idle (finished task). Allows wake-up notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'get_terminal_status',
    description: 'Get the working/idle status of a terminal or all terminals.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Terminal name (optional - omit for all terminals)',
        },
      },
    },
  },

  // Context Persistence tools (Goal Drift Prevention)
  {
    name: 'read_terminal_status_md',
    description: 'Read STATUS.md for a terminal - current state snapshot for goal re-anchoring.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'write_terminal_status_md',
    description: 'Update STATUS.md for a terminal - record current state, focus, and progress.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        system_status: {
          type: 'string',
          enum: ['operational', 'in_progress', 'paused', 'blocked'],
          description: 'Current system status',
        },
        current_focus: {
          type: 'string',
          description: 'Active task (e.g., MSG-BACKEND-045)',
        },
        recent_actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of recent actions taken',
        },
        next_steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of planned next steps',
        },
      },
      required: ['terminal', 'system_status'],
    },
  },
  {
    name: 'read_session_state',
    description: 'Read .session-state.json for a terminal - cross-session goal recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'write_session_state',
    description: 'Update .session-state.json for a terminal - persist epic, progress, and checkpoint state.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        epic_id: {
          type: 'string',
          description: 'Epic ID (e.g., EPIC-CUTTING-Q3)',
        },
        epic_name: {
          type: 'string',
          description: 'Human-readable epic name',
        },
        epic_progress: {
          type: 'number',
          description: 'Progress percentage (0-100)',
        },
        next_checkpoint_id: {
          type: 'string',
          description: 'Next checkpoint ID',
        },
        next_checkpoint_name: {
          type: 'string',
          description: 'Next checkpoint name',
        },
        completed_checkpoints: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of completed checkpoint IDs',
        },
        last_active_task: {
          type: 'string',
          description: 'Last active task ID',
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'get_context_saturation',
    description: 'Get context saturation status for a terminal. Returns turn count and warning levels (ok/warning/critical).',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'increment_turn_count',
    description: 'Increment .turn-count for a terminal. Used by Nightwatch for context saturation tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        amount: {
          type: 'number',
          description: 'Amount to increment (default: 1)',
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'reset_turn_count',
    description: 'Reset .turn-count to 0 for a terminal. Use after session restart or re-anchoring.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'read_checkpoints_md',
    description: 'Read CHECKPOINTS.md for a terminal - milestone tracking and strategic decision points.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'append_checkpoint_to_md',
    description: 'Append a new checkpoint to CHECKPOINTS.md for a terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        date: {
          type: 'string',
          description: 'Checkpoint date (YYYY-MM-DD)',
        },
        name: {
          type: 'string',
          description: 'Checkpoint name',
        },
        decision: {
          type: 'string',
          description: 'Decision type (e.g., GO/NO-GO)',
        },
        evaluation_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evaluation criteria list',
        },
        go_actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Actions if GO decision',
        },
        no_go_actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Actions if NO-GO decision',
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reference links',
        },
      },
      required: ['terminal', 'date', 'name', 'decision', 'evaluation_criteria', 'go_actions', 'no_go_actions'],
    },
  },
  {
    name: 'get_context_files_status',
    description: 'Get status of all context persistence files for a terminal (STATUS.md, .session-state.json, .turn-count, CHECKPOINTS.md).',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'get_all_context_files_status',
    description: 'Get context persistence files status for ALL terminals. Overview of goal persistence readiness.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'build_session_start_context',
    description: 'Build goal re-anchoring context for session start. Combines session state, context saturation, and STATUS.md.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
      },
      required: ['terminal'],
    },
  },

  // Domain Knowledge tools (ADR-049 Phase 3)
  {
    name: 'list_domain_memories',
    description: 'List available domain memory files for a terminal. Domain memories provide specialized context (e.g., kernel patterns, cutting workflows, datahaven UI patterns).',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.slice(0, 10).join(', ')}...`,
        },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'detect_task_domains',
    description: 'Detect which domain memories would be loaded for a given task content. Returns the list of domains that match keywords in the task.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.slice(0, 10).join(', ')}...`,
        },
        task_content: {
          type: 'string',
          description: 'Task description or content to analyze for domain detection',
        },
      },
      required: ['terminal', 'task_content'],
    },
  },

  // Work session request (ADR-049 Phase 2)
  // Chat session → request goes to Conductor → Conductor dispatches
  {
    name: 'request_work_session',
    description: 'Request a work session from your chat session. This sends a request to the Conductor, who will decide which terminal should handle the task. Use this for complex tasks that need code writing, file editing, or longer processing.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Detailed task description - what needs to be done',
        },
        suggested_terminal: {
          type: 'string',
          description: `Optional: suggest which terminal should handle it: ${TERMINALS.join(', ')}. Conductor may override.`,
        },
        priority: {
          type: 'string',
          description: 'Task priority',
          enum: ['critical', 'high', 'medium', 'low'],
        },
        context: {
          type: 'string',
          description: 'Additional context from the user conversation',
        },
      },
      required: ['task'],
    },
  },

  // Direct work session spawn (Conductor only)
  {
    name: 'spawn_work_session',
    description: 'CONDUCTOR ONLY: Directly spawn a work session for a terminal. Regular terminals should use request_work_session instead.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal to spawn work session for: ${TERMINALS.join(', ')}`,
        },
        task: {
          type: 'string',
          description: 'Task description to pass to the work session',
        },
        model: {
          type: 'string',
          description: 'Model to use (default: sonnet). Options: haiku, sonnet, opus',
          enum: ['haiku', 'sonnet', 'opus'],
        },
      },
      required: ['terminal', 'task'],
    },
  },

  // Focus Queue Tools (Conductor priority tracking)
  {
    name: 'get_focus_queue',
    description: 'Get the current focus queue - what the system is working on and what\'s next. Shows active task, queued items, and blocked items.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_active_task',
    description: 'Set the currently active task. Use this when switching focus to a new task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task/message ID (e.g., MSG-BACKEND-042)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'add_focus_item',
    description: 'Add a task to the focus queue.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task/message ID' },
        terminal: { type: 'string', description: 'Target terminal' },
        title: { type: 'string', description: 'Short description of the task' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Task priority' },
      },
      required: ['id', 'terminal', 'title', 'priority'],
    },
  },
  {
    name: 'set_task_status',
    description: 'Update task status in the focus queue (blocked or done).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task/message ID' },
        status: { type: 'string', enum: ['blocked', 'done'], description: 'New status' },
        reason: { type: 'string', description: 'Reason for blocking (required if status=blocked)' },
      },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'set_focus_queue',
    description: 'Replace the entire focus queue with a new list. Used by Conductor to set priorities.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Array of focus items',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              terminal: { type: 'string' },
              title: { type: 'string' },
              priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              status: { type: 'string', enum: ['queued', 'active', 'blocked', 'done'] },
              blockedReason: { type: 'string' },
            },
            required: ['id', 'terminal', 'title', 'priority', 'status'],
          },
        },
      },
      required: ['items'],
    },
  },

  // Project Automation Tools (6 new tools)
  {
    name: 'create_project',
    description: 'Create a new project structure with PROJECT.md, TASKS.yaml, STATUS.md',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Project slug (lowercase, no spaces)' },
        name: { type: 'string', description: 'Human-readable project name' },
        description: { type: 'string', description: 'Project description' },
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
          },
        },
      },
      required: ['slug', 'name'],
    },
  },

  {
    name: 'get_project_status',
    description: 'Get current status of a project including task completion',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project slug' },
      },
      required: ['project'],
    },
  },

  {
    name: 'dispatch_next',
    description: 'Manually dispatch the next unblocked task(s) for a project',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project slug' },
        task_id: { type: 'string', description: 'Specific task to dispatch (optional)' },
      },
      required: ['project'],
    },
  },

  {
    name: 'list_blocked',
    description: 'List all blocked tasks across all projects',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'generate_skeleton',
    description: 'Generate domain layer skeleton for a new aggregate',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module path (e.g., spaceos-modules-procurement)' },
        aggregate: { type: 'string', description: 'Aggregate name (PascalCase)' },
        states: {
          type: 'array',
          items: { type: 'string' },
          description: 'FSM states for the aggregate',
        },
        endpoints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Endpoints to generate (optional)',
        },
        properties: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              nullable: { type: 'boolean' },
            },
          },
          description: 'Additional properties (optional)',
        },
      },
      required: ['module', 'aggregate', 'states'],
    },
  },

  {
    name: 'generate_endpoint',
    description: 'Generate API endpoint with command, handler, and tests',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string' },
        aggregate: { type: 'string' },
        action: { type: 'string', description: 'Action name (e.g., Create, Submit, Resolve)' },
        http: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        route: { type: 'string', description: 'API route (e.g., /api/complaints/{id}/resolve)' },
        requestBody: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              nullable: { type: 'boolean' },
            },
          },
        },
        responseType: { type: 'string', description: 'Response type (optional)' },
      },
      required: ['module', 'aggregate', 'action', 'http', 'route'],
    },
  },

  // Memory Tier Management Tools (ADR-046 Track C)
  {
    name: 'save_tiered_memory',
    description: 'Save a memory with explicit tier assignment (hot/warm/cold/shared)',
    inputSchema: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: ['hot', 'warm', 'cold', 'shared'],
          description: 'Memory tier: hot (48h, high priority), warm (14d), cold (365d), shared (global)',
        },
        type: {
          type: 'string',
          enum: ['semantic', 'episodic', 'procedural'],
          description: 'Memory type',
        },
        source: {
          type: 'string',
          enum: ['conversation', 'document', 'skill', 'digest', 'manual'],
          description: 'Memory source',
        },
        content: {
          type: 'string',
          description: 'Memory content',
        },
        terminal: {
          type: 'string',
          description: 'Terminal name (optional for shared tier)',
        },
        context: {
          type: 'string',
          description: 'Additional context (optional)',
        },
        salience: {
          type: 'number',
          description: 'Salience score 0.0-1.0 (default: 0.5)',
        },
      },
      required: ['tier', 'type', 'source', 'content'],
    },
  },

  {
    name: 'promote_memory',
    description: 'Promote a memory to a higher tier (e.g., hot→warm, warm→cold, cold→shared)',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'number',
          description: 'Memory ID to promote',
        },
        new_tier: {
          type: 'string',
          enum: ['hot', 'warm', 'cold', 'shared'],
          description: 'Target tier',
        },
        reason: {
          type: 'string',
          description: 'Reason for promotion',
        },
      },
      required: ['memory_id', 'new_tier', 'reason'],
    },
  },

  {
    name: 'get_session_context',
    description: 'Get cold start context for a terminal (hot+warm+shared memories)',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        task_id: {
          type: 'string',
          description: 'Task ID (optional)',
        },
      },
      required: ['terminal'],
    },
  },

  {
    name: 'run_retrospective',
    description: 'Analyze session history and generate improvement proposals (skills, memory, workflow)',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        scope: {
          type: 'string',
          enum: ['session', 'last-task', 'last-hour'],
          description: 'Analysis scope',
        },
        focus: {
          type: 'string',
          enum: ['skills', 'memory', 'workflow', 'all'],
          description: 'Analysis focus',
        },
        session_id: {
          type: 'number',
          description: 'Specific session ID (required if scope=session)',
        },
      },
      required: ['terminal', 'scope', 'focus'],
    },
  },

  {
    name: 'apply_retrospective',
    description: 'Apply approved retrospective proposals (create skills, save memories, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        proposal_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of approved proposal IDs',
        },
      },
      required: ['terminal', 'proposal_ids'],
    },
  },

  {
    name: 'generate_handoff',
    description: 'Generate HANDOFF.md document for session/task transfer',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        purpose: {
          type: 'string',
          description: 'Handoff purpose',
        },
        target: {
          type: 'string',
          description: 'Target terminal or "next-session" (optional)',
        },
        output: {
          type: 'string',
          enum: ['file', 'message'],
          description: 'Output format: file (save to disk) or message (return markdown)',
        },
        goal: {
          type: 'string',
          description: 'Goal description (optional)',
        },
      },
      required: ['terminal', 'purpose', 'output'],
    },
  },

  {
    name: 'generate_daily_digest',
    description: 'Generate daily digest summary for a terminal (Track D)',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format (optional, defaults to today)',
        },
      },
      required: ['terminal'],
    },
  },

  // Telegram tools (2026-06-24, updated 2026-06-29 for multi-bot)
  {
    name: 'telegram_reply',
    description: 'Send a reply to a Telegram user. Use this to respond to messages from Telegram. The message will be queued and sent asynchronously. IMPORTANT: Include from_terminal to route via the correct bot.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'number',
          description: 'Telegram chat ID to send to',
        },
        message: {
          type: 'string',
          description: 'Message content to send',
        },
        from_terminal: {
          type: 'string',
          description: 'Terminal sending this reply (conductor, backend, frontend, architect, librarian). Required for routing to correct bot.',
        },
        conversation_id: {
          type: 'number',
          description: 'Optional conversation ID for threading context',
        },
        reply_to_message_id: {
          type: 'number',
          description: 'Optional Telegram message ID to reply to (for threading)',
        },
        parse_mode: {
          type: 'string',
          enum: ['HTML', 'Markdown'],
          description: 'Message format (default: HTML)',
        },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'telegram_broadcast',
    description: 'Broadcast a message to specific terminals via Telegram. The message will be injected into the target terminal(s) tmux session(s).',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Terminal names to send to (e.g., ["backend", "frontend"])',
        },
        message: {
          type: 'string',
          description: 'Message content to broadcast',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Message priority (default: medium)',
        },
      },
      required: ['targets', 'message'],
    },
  },
  {
    name: 'get_telegram_history',
    description: 'Get conversation history from Telegram. Returns recent messages from a specific chat or conversation for context-aware responses.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'number',
          description: 'Telegram chat ID to fetch history from',
        },
        conversation_id: {
          type: 'number',
          description: 'Optional conversation ID to filter by specific conversation thread',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default: 10, max: 50)',
        },
      },
      required: ['chat_id'],
    },
  },

  // Terminal Review Tools (ADR-053 + MSG-122)
  {
    name: 'request_review',
    description: 'Request review from architect or librarian terminal. Returns APPROVE/REJECT verdict with feedback. Replaces tmux-based review with MCP session management.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewer: {
          type: 'string',
          enum: ['architect', 'librarian'],
          description: 'Which terminal performs the review',
        },
        inbox_message_id: {
          type: 'string',
          description: 'Original inbox task message ID (e.g., MSG-BACKEND-042)',
        },
        done_message_id: {
          type: 'string',
          description: 'DONE outbox message ID to review (e.g., MSG-BACKEND-042-DONE)',
        },
      },
      required: ['reviewer', 'inbox_message_id', 'done_message_id'],
    },
  },

  // Parallel Worker Management Tools (ADR-049 Phase 3)
  {
    name: 'spawn_parallel_workers',
    description: 'Spawn multiple parallel work sessions for independent tasks with dependency management',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Terminal name to spawn workers for',
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Unique task ID',
              },
              prompt: {
                type: 'string',
                description: 'Task prompt',
              },
              model: {
                type: 'string',
                enum: ['haiku', 'sonnet', 'opus'],
                description: 'Model to use (default: sonnet)',
              },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of task IDs this task depends on',
              },
            },
            required: ['id', 'prompt'],
          },
          description: 'Array of tasks to spawn',
        },
      },
      required: ['terminal', 'tasks'],
    },
  },
  {
    name: 'spawn_raw_workers',
    description: 'Spawn multiple raw workers for quick prototyping or best-of-N selection',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Terminal name to spawn workers for',
        },
        task: {
          type: 'string',
          description: 'Task prompt to execute',
        },
        count: {
          type: 'number',
          minimum: 2,
          maximum: 5,
          description: 'Number of workers to spawn (2-5)',
        },
        model: {
          type: 'string',
          enum: ['haiku', 'sonnet'],
          description: 'Model to use (default: haiku)',
        },
        criteria: {
          type: 'string',
          description: 'Selection criteria for choosing best result',
        },
      },
      required: ['terminal', 'task', 'count', 'criteria'],
    },
  },
  {
    name: 'get_worker_status',
    description: 'Get status of all workers for a terminal, including cost and capacity information',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Terminal name to get worker status for',
        },
      },
      required: ['terminal'],
    },
  },

  // ─── Code Generation Tools (ADR-050 Phase 4) ─────────────────────────────────
  {
    name: 'generate_api_client',
    description: 'Generate API client code from OpenAPI spec. Uses Orval for Portal (React Query hooks) or NSwag for Orchestrator (TypeScript client).',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['kernel', 'orchestrator'],
          description: 'Source API to generate client for',
        },
        target: {
          type: 'string',
          enum: ['portal', 'orchestrator'],
          description: 'Target project for generated client',
        },
        outputDir: {
          type: 'string',
          description: 'Custom output directory (optional)',
        },
      },
      required: ['source', 'target'],
    },
  },
  {
    name: 'generate_component',
    description: 'Generate a React component with SpaceOS patterns. Creates component file, CSS module, index, and optionally test and Storybook files.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Component name (PascalCase, e.g., FlowEpicCard)',
        },
        category: {
          type: 'string',
          enum: ['feature', 'ui', 'layout'],
          description: 'Component category for file organization',
        },
        withTest: {
          type: 'boolean',
          description: 'Generate test file (default: false)',
        },
        withStory: {
          type: 'boolean',
          description: 'Generate Storybook story (default: false)',
        },
        props: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              required: { type: 'boolean' },
              description: { type: 'string' },
            },
          },
          description: 'Component props definition (optional)',
        },
      },
      required: ['name', 'category'],
    },
  },
  {
    name: 'generate_module',
    description: 'Generate a .NET module with DDD structure. Creates aggregate, states, events, and optionally API endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Module name (PascalCase, e.g., Pricing)',
        },
        aggregate: {
          type: 'string',
          description: 'Aggregate root name (default: same as module)',
        },
        states: {
          type: 'array',
          items: { type: 'string' },
          description: 'FSM states (e.g., ["Draft", "Submitted", "Approved"])',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain events (optional)',
        },
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
              route: { type: 'string' },
              action: { type: 'string' },
            },
          },
          description: 'API endpoints to generate (optional)',
        },
      },
      required: ['name', 'aggregate', 'states'],
    },
  },
  {
    name: 'generate_hook',
    description: 'Generate a React hook with SpaceOS patterns. Supports query, mutation, state, and effect hook types with optional TanStack Query integration.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Hook name (camelCase without "use" prefix, e.g., "Orders" generates "useOrders")',
        },
        type: {
          type: 'string',
          enum: ['query', 'mutation', 'state', 'effect'],
          description: 'Hook type: query (data fetching), mutation (data modification), state (local state management), effect (side effects)',
        },
        withTest: {
          type: 'boolean',
          description: 'Generate test file (default: false)',
        },
        withCache: {
          type: 'boolean',
          description: 'Use TanStack Query for caching (query/mutation types only, default: false)',
        },
        endpoint: {
          type: 'string',
          description: 'API endpoint path for query/mutation hooks (e.g., "/api/orders")',
        },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'get_codegen_status',
    description: 'Get the status of code generation configuration and generated files.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ─── Frontend Verification Tools (MSG-NEXUS-002) ──────────────────────────────

  {
    name: 'check_api_client_status',
    description: 'Check Orval-generated API client status for a JoineryTech module. Verifies OpenAPI spec, Orval config, generated client, and detects manual hooks.',
    inputSchema: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description: 'JoineryTech module name (e.g., "ehs", "crm", "maintenance")',
        },
      },
      required: ['module'],
    },
  },
  {
    name: 'verify_frontend_build',
    description: 'Verify frontend build status. Runs TypeScript check, estimates build time, and reports bundle size.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project path relative to SPACEOS_ROOT (e.g., "datahaven-web/client")',
        },
        run_tests: {
          type: 'boolean',
          description: 'Run tests as part of verification (default: false)',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'scaffold_from_pattern',
    description: 'Scaffold component from documented UI pattern. Available patterns: dashboard-with-kpi-strip, data-table-with-actions, form-wizard-offline-first.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Pattern name (e.g., "dashboard-with-kpi-strip")',
        },
        module: {
          type: 'string',
          description: 'JoineryTech module (e.g., "safety", "ehs")',
        },
        entity: {
          type: 'string',
          description: 'Entity name (e.g., "Audit", "Incident")',
        },
      },
      required: ['pattern', 'module', 'entity'],
    },
  },
  {
    name: 'analyze_bundle_size',
    description: 'Analyze bundle size and provide optimization recommendations. Identifies lazy loading candidates and large chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project path relative to SPACEOS_ROOT (e.g., "datahaven-web/client")',
        },
      },
      required: ['project'],
    },
  },
  // Goal tools (ADR-059 - Monitor-Driven Goal Progression)
  {
    name: 'create_goal',
    description: 'Create a goal with completion criteria. When criteria are met, Monitor triggers specified terminal. Used by Conductor for Mode #4 continuous operation.',
    inputSchema: {
      type: 'object',
      properties: {
        created_by: {
          type: 'string',
          description: 'Terminal creating the goal (e.g., "conductor")',
        },
        epic_id: {
          type: 'string',
          description: 'Related epic ID (optional, e.g., "EPIC-CUTTING-Q3")',
        },
        description: {
          type: 'string',
          description: 'Human-readable goal description',
        },
        checkpoint_id: {
          type: 'string',
          description: 'Related checkpoint ID (optional)',
        },
        completion_criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['done_outbox', 'checkpoint_status', 'message_status', 'terminal_idle', 'all_of', 'any_of'],
                description: 'Criterion type',
              },
              terminal: { type: 'string', description: 'Terminal name (for done_outbox, terminal_idle)' },
              message_pattern: { type: 'string', description: 'Glob pattern for outbox matching (for done_outbox)' },
              checkpoint_id: { type: 'string', description: 'Checkpoint ID (for checkpoint_status)' },
              expected_status: { type: 'string', description: 'Expected status (for checkpoint_status, message_status)' },
              message_id: { type: 'string', description: 'Message ID (for message_status)' },
              min_idle_minutes: { type: 'number', description: 'Minimum idle time (for terminal_idle)' },
              criteria: { type: 'array', description: 'Nested criteria (for all_of, any_of)' },
            },
            required: ['type'],
          },
          description: 'Completion criteria (all must be satisfied)',
        },
        trigger_terminal: {
          type: 'string',
          description: 'Terminal to trigger when goal completes (e.g., "conductor")',
        },
        next_goal: {
          type: 'string',
          description: 'Description of next goal (for chaining)',
        },
        prompt: {
          type: 'string',
          description: 'Prompt template for trigger message. Supports {{goal.description}}, {{completed_criteria}}, {{on_complete.next_goal}}',
        },
        expires_in_hours: {
          type: 'number',
          description: 'Goal expiration in hours (optional)',
        },
      },
      required: ['created_by', 'description', 'completion_criteria', 'trigger_terminal', 'prompt'],
    },
  },
  {
    name: 'list_goals',
    description: 'List goals by status. Returns all active goals being watched by Monitor.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['watching', 'triggered', 'completed', 'expired'],
          description: 'Filter by status (optional, returns all if omitted)',
        },
      },
    },
  },
  {
    name: 'get_goal',
    description: 'Get a specific goal by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: {
          type: 'string',
          description: 'Goal ID (e.g., "GOAL-2026-07-04-001")',
        },
      },
      required: ['goal_id'],
    },
  },
  {
    name: 'check_goal_criteria',
    description: 'Check if goal criteria are met. Used by Monitor during Nightwatch cycles.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: {
          type: 'string',
          description: 'Goal ID to check',
        },
      },
      required: ['goal_id'],
    },
  },
  {
    name: 'trigger_goal',
    description: 'Mark goal as triggered and notify target terminal. Used by Monitor when criteria are met.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: {
          type: 'string',
          description: 'Goal ID to trigger',
        },
      },
      required: ['goal_id'],
    },
  },
  {
    name: 'complete_goal',
    description: 'Mark goal as completed. Called after trigger_terminal processes the goal.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: {
          type: 'string',
          description: 'Goal ID to complete',
        },
      },
      required: ['goal_id'],
    },
  },

  // Phase 1 MCP Tools (ADR-050.Phase1)
  {
    name: 'get_terminal_status_aggregate',
    description: 'Get aggregated status from all 7 terminals. Shows working/idle/stuck states, context saturation, health scores, and alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['summary', 'detailed', 'alerts_only'],
          description: 'Output format (default: summary)',
        },
      },
    },
  },
  {
    name: 'resolve_epic_dependencies',
    description: 'Resolve epic dependencies from EPICS.yaml. Identifies blockers, ready tasks, and validates dependency graph.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: {
          type: 'string',
          description: 'Epic ID (e.g., "EPIC-CUTTING-Q3")',
        },
        check_blockers: {
          type: 'boolean',
          description: 'Validate blocker resolution (default: true)',
        },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'transfer_session_context',
    description: 'Transfer context between terminals via inbox messages.',
    inputSchema: {
      type: 'object',
      properties: {
        from_terminal: {
          type: 'string',
          description: 'Source terminal (root, conductor, architect, librarian, explorer, backend, frontend, designer)',
        },
        to_terminal: {
          type: 'string',
          description: 'Target terminal',
        },
        context_type: {
          type: 'string',
          enum: ['research_summary', 'code_audit', 'knowledge_synthesis'],
          description: 'Context transfer type',
        },
        summary: {
          type: 'string',
          description: 'Context summary (optional)',
        },
        include_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to reference (max 20)',
        },
      },
      required: ['from_terminal', 'to_terminal', 'context_type'],
    },
  },
  {
    name: 'match_domain_pattern',
    description: 'Match description to known domain patterns with confidence scores and recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Problem/feature description (max 500 chars)',
        },
        domain: {
          type: 'string',
          enum: ['crm', 'controlling', 'procurement', 'ehs', 'cutting', 'joinery', 'kernel', 'general'],
          description: 'Filter by domain (optional)',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'scaffold_react_hook',
    description: 'Generate React hook scaffold with tests and optional caching.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Hook name (e.g., useCostBudget, useQuoteRequest)',
        },
        type: {
          type: 'string',
          enum: ['query', 'mutation', 'state', 'effect'],
          description: 'Hook type',
        },
        with_test: {
          type: 'boolean',
          description: 'Generate tests (default: true)',
        },
        with_cache: {
          type: 'boolean',
          description: 'Add caching logic (default: false)',
        },
        endpoint: {
          type: 'string',
          description: 'API endpoint for query hooks (optional)',
        },
      },
      required: ['name', 'type'],
    },
  },

  // Memory Management tools (MSG-BACKEND-192)
  {
    name: 'memory_health_report',
    description: 'Get fleet-wide memory health status in one call. Returns size, staleness, duplicate ratio, and suggested actions for all terminals.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'compress_memory',
    description: 'Automatic memory compression with pattern detection. Supports dry_run mode for safe preview.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name: ${TERMINALS.join(', ')}`,
        },
        strategy: {
          type: 'string',
          enum: ['aggressive', 'moderate', 'conservative'],
          description: 'Compression level: aggressive (remove most), moderate (balanced), conservative (minimal)',
        },
        preserve_sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Section headers to preserve (optional)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview compression without writing (default: true)',
        },
      },
      required: ['terminal', 'strategy'],
    },
  },
  {
    name: 'extract_patterns',
    description: 'Cross-terminal pattern mining for knowledge extraction. Finds repeating workflows, decisions, and error resolutions.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: `Terminal name or 'all' for fleet-wide: ${TERMINALS.join(', ')}, all`,
        },
        min_frequency: {
          type: 'number',
          description: 'Minimum pattern frequency (default: 3)',
        },
        pattern_types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['workflow', 'decision', 'error_resolution'],
          },
          description: 'Pattern types to extract',
        },
      },
      required: ['terminal', 'pattern_types'],
    },
  },

  // Skill Factory (MSG-NEXUS-005)
  {
    name: 'create_skill',
    description: 'Create a new skill from workflow template. Skill is saved to .claude/skills/ and becomes available immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name (kebab-case, alphanumeric + hyphens only)',
        },
        description: {
          type: 'string',
          description: 'Short skill description',
        },
        trigger_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional trigger patterns (e.g., ["git conflict", "merge issue"])',
        },
        template: {
          type: 'string',
          description: 'Skill content (markdown)',
        },
      },
      required: ['name', 'template'],
    },
  },
  {
    name: 'list_all_skills',
    description: 'List all installed skills in .claude/skills/',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_skill_metadata',
    description: 'Get skill metadata (name, description, triggers)',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'Skill name (kebab-case)',
        },
      },
      required: ['skill_name'],
    },
  },
  {
    name: 'delete_skill',
    description: 'Delete a skill from .claude/skills/',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'Skill name to delete',
        },
      },
      required: ['skill_name'],
    },
  },

  // Epic Progress Tracker (MSG-NEXUS-005)
  {
    name: 'get_epic_progress',
    description: 'Get real-time epic progress with task completion, blockers, and estimated completion date.',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: {
          type: 'string',
          description: 'Epic ID (e.g., EPIC-CUTTING-Q3, EPIC-JOINERY-V2)',
        },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'get_all_epics_progress',
    description: 'Get progress for all epics in EPICS.yaml',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Subscription tools (ADR-052)
  ...SUBSCRIPTION_TOOLS,
];

// ─── Tool Handlers ──────────────────────────────────────────────────────────

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  callerTerminal?: string,  // Added for auth-aware tools (2026-06-24)
  callerIsland?: string     // Multi-island: knowledge scope of the caller
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    // Registry-based tools first (migrated groups); errors propagate to the
    // shared catch below so the {error} JSON shape stays identical.
    const registered = toolRegistry.getHandler(name);
    if (registered) {
      return await registered(args, { terminal: callerTerminal, island: callerIsland });
    }

    switch (name) {
      // Mailbox tools
      case 'list_inbox': {
        const terminal = String(args.terminal || '');
        const status = (args.status as 'UNREAD' | 'READ' | 'all') || 'all';
        const includeContent = args.include_content === true; // Default: false (metadata only)

        if (includeContent) {
          // Full content (expensive, use only when needed)
          const messages = await listInbox(terminal, status);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ terminal, status, count: messages.length, messages }, null, 2),
              },
            ],
          };
        } else {
          // Metadata only (10× lighter, default for MCP)
          const messages = await listInboxMetadata(terminal, status);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ terminal, status, count: messages.length, messages }, null, 2),
              },
            ],
          };
        }
      }

      case 'create_task': {
        const fromTerminal = args.from ? String(args.from) : (callerTerminal || 'unknown');

        // Verify caller can create tasks for target terminal
        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Root and conductor can create tasks for anyone
        // Others can only create tasks for their own terminal or question/info types
        if (callerTerminal !== 'root' && callerTerminal !== 'conductor') {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot create tasks. Only root and conductor can dispatch tasks.`
            }, null, 2) }],
          };
        }

        const result = await createTask({
          from: fromTerminal,
          to: String(args.to),
          title: String(args.title),
          description: String(args.description),
          acceptance_criteria: args.acceptance_criteria as string[] | undefined,
          priority: String(args.priority) as 'critical' | 'high' | 'medium' | 'low',
          model: args.model ? String(args.model) as 'haiku' | 'sonnet' | 'opus' : undefined,
          ref: args.ref ? String(args.ref) : undefined,
          epic_id: args.epic_id ? String(args.epic_id) : undefined,
          project_id: args.project_id ? String(args.project_id) : undefined,
          context: args.context ? String(args.context) : undefined,
          queue_only: args.queue_only === true,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'send_message': {
        const result = await sendMessage({
          to: String(args.to),
          type: String(args.type) as 'task' | 'question' | 'done' | 'blocked',
          content: String(args.content),
          priority: String(args.priority) as 'critical' | 'high' | 'medium' | 'low',
          model: args.model ? String(args.model) as 'haiku' | 'sonnet' | 'opus' : undefined,
          ref: args.ref ? String(args.ref) : undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      }

      case 'submit_done': {
        const result = await submitDone({
          from: String(args.from),
          task_id: String(args.task_id),
          summary: String(args.summary),
          files_changed: args.files_changed as string[],
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      }

      // Direct mailbox access tools (2026-06-24)
      case 'read_inbox_message': {
        const terminal = String(args.terminal || '');
        const messageId = String(args.message_id || '');

        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Verify caller can access this terminal's inbox
        if (callerTerminal !== 'root' && callerTerminal !== terminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot read inbox for terminal ${terminal}`
            }, null, 2) }],
          };
        }

        const result = await readInboxMessage(terminal, messageId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'complete_inbox_message': {
        const terminal = String(args.terminal || '');

        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Verify caller can complete this terminal's tasks
        if (callerTerminal !== 'root' && callerTerminal !== terminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot complete tasks for terminal ${terminal}`
            }, null, 2) }],
          };
        }

        const result = await completeInboxMessage({
          terminal,
          message_id: String(args.message_id || ''),
          status: args.status as 'done' | 'blocked',
          summary: String(args.summary || ''),
          details: args.details ? String(args.details) : undefined,
          files_changed: args.files_changed as string[] | undefined,
          blocked_reason: args.blocked_reason ? String(args.blocked_reason) : undefined,
          next_steps: args.next_steps ? String(args.next_steps) : undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'append_to_message': {
        const terminal = String(args.terminal || '');

        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Verify caller can append to this terminal's messages
        if (callerTerminal !== 'root' && callerTerminal !== terminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot append to messages for terminal ${terminal}`
            }, null, 2) }],
          };
        }

        const result = await appendToMessage({
          terminal,
          messageId: String(args.message_id || ''),
          box: args.box as 'inbox' | 'outbox',
          section: args.section as 'notes' | 'implementation' | 'feedback' | 'blockers' | 'progress',
          content: String(args.content || ''),
          author: args.author ? String(args.author) : callerTerminal,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // Task tools
      case 'get_task_status': {
        const taskId = args.task_id ? String(args.task_id) : undefined;
        const tasks = await getTaskStatus(taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: tasks.length, tasks }, null, 2),
            },
          ],
        };
      }

      // Epic-aware task routing tools (2026-06-24)
      case 'fetch_task': {
        const terminal = String(args.terminal || '');
        const messageId = String(args.message_id || '');

        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Verify caller can access this terminal's tasks
        // root/master can access any, others only their own
        if (callerTerminal !== 'root' && callerTerminal !== terminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot fetch tasks for terminal ${terminal}`
            }, null, 2) }],
          };
        }

        const result = await fetchTaskForMcp(terminal, messageId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'ack_task': {
        const terminal = String(args.terminal || '');
        const messageId = String(args.message_id || '');

        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Verify caller can access this terminal's tasks
        if (callerTerminal !== 'root' && callerTerminal !== terminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot acknowledge tasks for terminal ${terminal}`
            }, null, 2) }],
          };
        }

        const result = await ackTaskForMcp(terminal, messageId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'complete_task': {
        const terminal = String(args.terminal || '');
        const messageId = String(args.message_id || '');
        const summary = args.summary ? String(args.summary) : undefined;

        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Verify caller can access this terminal's tasks
        if (callerTerminal !== 'root' && callerTerminal !== terminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot complete tasks for terminal ${terminal}`
            }, null, 2) }],
          };
        }

        // 2026-06-24: Added summary parameter for cold session memory save
        const result = await completeTaskForMcp(terminal, messageId, summary);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // Identity tools
      case 'get_identity': {
        const terminal = String(args.terminal || '');
        const identity = await getIdentity(terminal);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(identity, null, 2),
            },
          ],
        };
      }

      case 'list_terminals': {
        const terminals = await listTerminals();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: terminals.length, terminals }, null, 2),
            },
          ],
        };
      }

      // Memory tools
      case 'read_memory': {
        const terminal = String(args.terminal || '');
        const memory = await readMemory(terminal);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ terminal, hasMemory: memory !== null, memory }, null, 2),
            },
          ],
        };
      }

      case 'write_memory': {
        const terminal = String(args.terminal || '');
        const content = String(args.content || '');
        const result = await writeMemory(terminal, content);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ terminal, ...result }, null, 2),
            },
          ],
        };
      }

      case 'append_memory': {
        const terminal = String(args.terminal || '');
        const content = String(args.content || '');
        const result = await appendMemory(terminal, content);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ terminal, ...result }, null, 2),
            },
          ],
        };
      }

      // System tools
      case 'get_capabilities': {
        const category = args.category ? String(args.category) : undefined;
        const capabilities = getCapabilities(category);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                count: capabilities.length,
                filter: category || 'all',
                capabilities,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_service_status': {
        const count = await getDocumentCount();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                vectorBackend: usingChroma() ? 'chromadb' : 'memory',
                embeddingBackend: embeddingBackend(),
                documents: count,
                terminals: TERMINALS.length,
                tools: TOOLS.length,
              }, null, 2),
            },
          ],
        };
      }

      // Skill tools
      case 'list_skills': {
        const skills = await listSkills();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: skills.length, skills }, null, 2),
            },
          ],
        };
      }

      case 'get_skill': {
        const skillName = String(args.skill_name || '');
        const skill = await getSkill(skillName);
        if (!skill) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Skill not found: ${skillName}` }, null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(skill, null, 2),
            },
          ],
        };
      }

      case 'get_workflow': {
        const workflow = await getWorkflow();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ hasWorkflow: workflow !== null, workflow }, null, 2),
            },
          ],
        };
      }

      case 'get_terminal_setup': {
        const terminal = String(args.terminal || '');
        const setup = await getTerminalSetup(terminal);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                terminal,
                hasClaudeMd: setup.claudeMd !== null,
                hasSkill: setup.skill !== null,
                ...setup,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_project_context': {
        const context = await getProjectContext();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                hasVision: context.vision !== null,
                hasKnowledgeIndex: context.knowledgeIndex !== null,
                hasCodebaseStatus: context.codebaseStatus !== null,
                ...context,
              }, null, 2),
            },
          ],
        };
      }

      // Terminal docs tools
      case 'list_terminal_docs': {
        const docs = await listTerminalDocs();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: docs.length, terminals: docs }, null, 2),
            },
          ],
        };
      }

      case 'get_terminal_docs': {
        const terminal = String(args.terminal || '');
        const docs = await getTerminalDocs(terminal);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                terminal: docs.name,
                hasReadme: docs.readme !== null,
                ...docs,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_terminals_index': {
        const index = await getTerminalsIndex();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ hasIndex: index !== null, index }, null, 2),
            },
          ],
        };
      }

      // Terminal status tools
      case 'register_working': {
        const terminal = String(args.terminal || '');
        const taskId = args.task_id ? String(args.task_id) : undefined;
        registerWorking(terminal, taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                terminal,
                state: 'working',
                taskId,
                message: `Terminal ${terminal} registered as WORKING`,
              }, null, 2),
            },
          ],
        };
      }

      case 'register_idle': {
        const terminal = String(args.terminal || '');
        registerIdle(terminal);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                terminal,
                state: 'idle',
                message: `Terminal ${terminal} registered as IDLE`,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_terminal_status': {
        const terminal = args.terminal ? String(args.terminal) : undefined;
        if (terminal) {
          const status = getStatus(terminal);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  terminal,
                  status: status || { state: 'idle', lastActivity: null },
                  shouldWakeUp: shouldWakeUp(terminal),
                }, null, 2),
              },
            ],
          };
        } else {
          const allStatus = getAllStatus();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ terminals: allStatus }, null, 2),
              },
            ],
          };
        }
      }

      // Context Persistence tools (Goal Drift Prevention)
      case 'read_terminal_status_md': {
        const terminal = String(args.terminal || '');
        try {
          const status = await readStatusMd(terminal);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  exists: status !== null,
                  ...(status || { terminal, note: 'STATUS.md not found for this terminal' }),
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'write_terminal_status_md': {
        const terminal = String(args.terminal || '');
        const systemStatus = args.system_status as 'operational' | 'in_progress' | 'paused' | 'blocked';
        const currentFocus = args.current_focus ? String(args.current_focus) : undefined;
        const recentActions = args.recent_actions as string[] | undefined;
        const nextSteps = args.next_steps as string[] | undefined;

        try {
          const result = await writeStatusMd(terminal, {
            systemStatus,
            currentFocus,
            recentActions,
            nextSteps,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  terminal,
                  path: result.path,
                  message: `STATUS.md updated for ${terminal}`,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'read_session_state': {
        const terminal = String(args.terminal || '');
        try {
          const state = await readSessionState(terminal);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  terminal,
                  exists: state !== null,
                  sessionState: state,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'write_session_state': {
        const terminal = String(args.terminal || '');
        try {
          const result = await writeSessionState(terminal, {
            epicId: args.epic_id ? String(args.epic_id) : undefined,
            epicName: args.epic_name ? String(args.epic_name) : undefined,
            epicProgress: args.epic_progress !== undefined ? Number(args.epic_progress) : undefined,
            nextCheckpointId: args.next_checkpoint_id ? String(args.next_checkpoint_id) : undefined,
            nextCheckpointName: args.next_checkpoint_name ? String(args.next_checkpoint_name) : undefined,
            completedCheckpoints: args.completed_checkpoints as string[] | undefined,
            lastActiveTask: args.last_active_task ? String(args.last_active_task) : undefined,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  terminal,
                  path: result.path,
                  message: `.session-state.json updated for ${terminal}`,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'get_context_saturation': {
        const terminal = String(args.terminal || '');
        try {
          const saturation = await getContextSaturation(terminal);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  ...saturation,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'increment_turn_count': {
        const terminal = String(args.terminal || '');
        const amount = args.amount !== undefined ? Number(args.amount) : 1;
        try {
          const result = await incrementTurnCount(terminal, amount);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  terminal,
                  count: result.count,
                  warning: result.warning,
                  critical: result.critical,
                  needsReanchor: result.needsReanchor,
                  message: result.critical
                    ? `CRITICAL: Turn count ${result.count} exceeds 50. Consider re-anchoring.`
                    : result.warning
                      ? `WARNING: Turn count ${result.count} exceeds 30. Context saturation approaching.`
                      : `Turn count incremented to ${result.count}.`,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'reset_turn_count': {
        const terminal = String(args.terminal || '');
        try {
          const result = await resetTurnCount(terminal);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  terminal,
                  path: result.path,
                  message: `Turn count reset to 0 for ${terminal}.`,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'read_checkpoints_md': {
        const terminal = String(args.terminal || '');
        try {
          const checkpoints = await readCheckpointsMd(terminal);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  exists: checkpoints !== null,
                  ...(checkpoints || { terminal, note: 'CHECKPOINTS.md not found for this terminal' }),
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'append_checkpoint_to_md': {
        const terminal = String(args.terminal || '');
        try {
          const result = await appendCheckpoint(terminal, {
            date: String(args.date || ''),
            name: String(args.name || ''),
            decision: String(args.decision || ''),
            evaluationCriteria: args.evaluation_criteria as string[],
            goActions: args.go_actions as string[],
            noGoActions: args.no_go_actions as string[],
            refs: args.refs as string[] | undefined,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  terminal,
                  path: result.path,
                  message: `Checkpoint added to CHECKPOINTS.md for ${terminal}.`,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'get_context_files_status': {
        const terminal = String(args.terminal || '');
        try {
          const status = await getContextFilesStatus(terminal);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  ...status,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'get_all_context_files_status': {
        try {
          const statuses = await getAllContextFilesStatus();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  terminals: statuses,
                  count: statuses.length,
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      case 'build_session_start_context': {
        const terminal = String(args.terminal || '');
        try {
          const context = await buildSessionStartContext(terminal);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  terminal,
                  context,
                  note: 'Use this context for goal re-anchoring at session start.',
                }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: String(err) }, null, 2) }],
          };
        }
      }

      // Domain Knowledge tools (ADR-049 Phase 3)
      case 'list_domain_memories': {
        const terminal = String(args.terminal || '');
        const hasFolder = hasKnowledgeFolder(terminal);
        const memories = listAvailableMemories(terminal);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                terminal,
                hasKnowledgeFolder: hasFolder,
                availableMemories: memories,
                count: memories.length,
              }, null, 2),
            },
          ],
        };
      }

      case 'detect_task_domains': {
        const terminal = String(args.terminal || '');
        const taskContent = String(args.task_content || '');
        const detectedDomains = detectDomains(taskContent, terminal);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                terminal,
                taskContentLength: taskContent.length,
                detectedDomains,
                count: detectedDomains.length,
                note: detectedDomains.length > 0
                  ? `Task matches ${detectedDomains.length} domain(s): ${detectedDomains.join(', ')}`
                  : 'No specific domain detected - shared memory will be loaded',
              }, null, 2),
            },
          ],
        };
      }

      // Work session tools (ADR-049 Phase 2)
      case 'request_work_session': {
        const task = String(args.task || '');
        const suggestedTerminal = args.suggested_terminal ? String(args.suggested_terminal) : undefined;
        const priority = (args.priority as 'critical' | 'high' | 'medium' | 'low') || 'medium';
        const context = args.context ? String(args.context) : '';

        if (!task) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task description is required' }, null, 2) }],
          };
        }

        // Import logging
        const { logWorkSessionRequest, hashTask } = await import('./pipeline/workSessionLog');
        const taskHash = await hashTask(task);

        // Create inbox message for Conductor
        const timestamp = new Date().toISOString();
        const messageId = `WORK-REQ-${Date.now()}`;

        const requestContent = `---
id: ${messageId}
from: ${callerTerminal || 'chat-session'}
to: conductor
type: work-request
priority: ${priority}
status: UNREAD
created: ${timestamp.split('T')[0]}
---

# Work Session Request

## Task
${task}

## Context
${context || 'No additional context provided.'}

## Suggested Terminal
${suggestedTerminal || 'Let Conductor decide based on task type.'}

## Source
Requested by ${callerTerminal || 'unknown'} chat session.
`;

        // Write to Conductor inbox
        const fs = require('fs').promises;
        const path = require('path');
        const TERMINALS_ROOT = process.env.TERMINALS_PATH || `${process.env.SPACEOS_ROOT || '/opt/spaceos'}/terminals`;
        const inboxPath = path.join(TERMINALS_ROOT, 'conductor', 'inbox');
        const filename = `${timestamp.split('T')[0]}_${messageId.toLowerCase()}.md`;

        try {
          await fs.writeFile(path.join(inboxPath, filename), requestContent, 'utf-8');

          // Log to audit trail
          const logEntry = await logWorkSessionRequest({
            from_terminal: callerTerminal || 'unknown',
            task_summary: task.slice(0, 200),
            task_hash: taskHash,
            priority,
            suggested_terminal: suggestedTerminal,
            conductor_inbox_file: filename,
            success: true,
          });

          logger.info(`[MCP] Work session request created: ${logEntry.request_id} (inbox: ${messageId})`);

          // Also inject directly to Conductor chat session if running
          try {
            const { injectToChatSession } = await import('./chatSessionStarter');
            await injectToChatSession('conductor', `[WORK REQUEST] ${callerTerminal} kér work session-t: ${task.slice(0, 100)}...`);
          } catch {
            // Chat session not running, inbox will be picked up
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                request_id: logEntry.request_id,
                messageId,
                message: 'Work session request sent to Conductor',
                task: task.slice(0, 100) + '...',
                suggestedTerminal,
                priority,
              }, null, 2),
            }],
          };
        } catch (err) {
          // Log failure
          await logWorkSessionRequest({
            from_terminal: callerTerminal || 'unknown',
            task_summary: task.slice(0, 200),
            task_hash: taskHash,
            priority,
            suggested_terminal: suggestedTerminal,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `Failed to create work request: ${err instanceof Error ? err.message : String(err)}`,
              }, null, 2),
            }],
          };
        }
      }

      case 'spawn_work_session': {
        // Import logging
        const { logWorkSessionSpawn, hashTask: hashTaskForSpawn } = await import('./pipeline/workSessionLog');

        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Caller terminal not identified. Check MCP token configuration.'
              }, null, 2)
            }]
          };
        }

        // Only Conductor and Root can spawn directly
        if (callerTerminal !== 'root' && callerTerminal !== 'conductor') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `Only Conductor and Root can spawn work sessions directly. Use request_work_session instead.`,
              }, null, 2),
            }],
          };
        }

        const terminal = String(args.terminal || '');
        const task = String(args.task || '');
        const model = args.model ? String(args.model) : 'sonnet';
        const requestId = args.request_id ? String(args.request_id) : undefined;

        if (!terminal || !task) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: false, error: 'Terminal and task are required' }, null, 2),
            }],
          };
        }

        const taskHash = await hashTaskForSpawn(task);
        const { startWorkSession } = await import('./sessionStarter');
        const result = await startWorkSession(terminal, task, model);

        // Log to audit trail
        const logEntry = await logWorkSessionSpawn({
          terminal,
          session_name: result.sessionName || `spaceos-${terminal}`,
          model,
          task_summary: task.slice(0, 200),
          task_hash: taskHash,
          spawned_by: callerTerminal || 'unknown',
          request_id: requestId,
          success: result.success,
          error: result.success ? undefined : result.message,
        });

        logger.info(`[MCP] Work session spawn logged: ${logEntry.spawn_id} for ${terminal}`);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...result,
              spawn_id: logEntry.spawn_id,
            }, null, 2),
          }],
        };
      }

      // Project Automation Tools
      case 'create_project': {
        const result = await handleCreateProject(args as any);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_project_status': {
        const result = await handleGetProjectStatus(args as any);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'dispatch_next': {
        const result = await handleDispatchNext(args as any);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'list_blocked': {
        const result = await handleListBlocked();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'generate_skeleton': {
        const result = await handleGenerateSkeleton(args as any);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'generate_endpoint': {
        const result = await handleGenerateEndpoint(args as any);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // Memory Tier Management Tools (ADR-046 Track C)
      case 'save_tiered_memory': {
        const tier = args.tier as 'hot' | 'warm' | 'cold' | 'shared';
        const type = args.type as 'semantic' | 'episodic' | 'procedural';
        const source = args.source as 'conversation' | 'document' | 'skill' | 'digest' | 'manual';
        const content = String(args.content || '');
        const terminal = args.terminal ? String(args.terminal) : undefined;
        const context = args.context ? String(args.context) : undefined;
        const salience = args.salience ? Number(args.salience) : undefined;

        const memory = await saveTieredMemory({
          tier,
          type,
          source,
          content,
          terminal,
          context,
          salience,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                memory: {
                  id: memory.id,
                  tier: memory.tier,
                  type: memory.type,
                  content: memory.content.substring(0, 100) + (memory.content.length > 100 ? '...' : ''),
                  salience: memory.salience,
                },
              }, null, 2),
            },
          ],
        };
      }

      case 'promote_memory': {
        const memoryId = Number(args.memory_id || 0);
        const newTier = args.new_tier as 'hot' | 'warm' | 'cold' | 'shared';
        const reason = String(args.reason || '');

        await promoteMemory(memoryId, newTier, reason);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                memoryId,
                newTier,
                reason,
                message: `Memory #${memoryId} promoted to ${newTier}`,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_session_context': {
        const terminal = String(args.terminal || '');
        const taskId = args.task_id ? String(args.task_id) : undefined;

        const context = await buildStartContext({
          terminal,
          taskId,
          inboxMessageId: taskId,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                terminal,
                taskId,
                memoriesLoaded: context.memoriesLoaded,
                hotMemories: context.hotMemories.length,
                warmMemories: context.warmMemories.length,
                sharedMemories: context.sharedMemories.length,
                contextTokens: context.contextTokens,
                contextMarkdown: context.contextMarkdown,
              }, null, 2),
            },
          ],
        };
      }

      case 'run_retrospective': {
        const terminal = String(args.terminal || '');
        const scope = args.scope as 'session' | 'last-task' | 'last-hour';
        const focus = args.focus as 'skills' | 'memory' | 'workflow' | 'all';
        const sessionId = args.session_id ? Number(args.session_id) : undefined;

        const result = await runRetrospective({
          terminal,
          scope,
          focus,
          sessionId,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                sessionSummary: result.sessionSummary,
                proposalsCount: result.proposals.length,
                proposals: result.proposals.map((p) => ({
                  id: p.id,
                  type: p.type,
                  action: p.action,
                  target: p.target,
                  reason: p.reason,
                  priority: p.priority,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'apply_retrospective': {
        const terminal = String(args.terminal || '');
        const proposalIds = (args.proposal_ids as number[]) || [];

        const result = await applyRetrospective({
          terminal,
          approvedProposals: proposalIds,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                executedCount: result.executedCount,
                skillsCreated: result.skillsCreated,
                memoriesSaved: result.memoriesSaved,
                workflowsUpdated: result.workflowsUpdated,
                errors: result.errors,
              }, null, 2),
            },
          ],
        };
      }

      case 'generate_handoff': {
        const terminal = String(args.terminal || '');
        const purpose = String(args.purpose || '');
        const target = args.target ? String(args.target) : undefined;
        const output = args.output as 'file' | 'message';
        const goal = args.goal ? String(args.goal) : undefined;

        const result = await generateHandoff({
          terminal,
          purpose,
          target,
          output,
          goal,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: result.success,
                filePath: result.filePath,
                document: {
                  purpose: result.document.purpose,
                  from: result.document.from,
                  to: result.document.to,
                  goal: result.document.goal,
                  currentProgress: result.document.currentProgress.length,
                  nextSteps: result.document.nextSteps.length,
                },
                markdown: output === 'message' ? result.markdown : undefined,
              }, null, 2),
            },
          ],
        };
      }

      case 'generate_daily_digest': {
        const terminal = String(args.terminal || '');
        const date = args.date ? String(args.date) : new Date().toISOString().split('T')[0];

        const result = await generateDailyDigest({ terminal, date });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                terminal: result.terminal,
                date: result.date,
                sessionCount: result.sessionCount,
                memoriesCreated: result.memoriesCreated,
                toolCallsTotal: result.toolCallsTotal,
                tasksCompleted: result.tasksCompleted,
                tasksBlocked: result.tasksBlocked,
                summary: result.summary,
                savedAsMemory: result.savedAsMemory,
                digestMarkdown: result.digestMarkdown,
              }, null, 2),
            },
          ],
        };
      }

      // Focus Queue Tools (Conductor priority tracking)
      case 'get_focus_queue': {
        const focus = getFocusQueue();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                summary: focus.summary,
                activeTask: focus.activeTask ? {
                  id: focus.activeTask.id,
                  terminal: focus.activeTask.terminal,
                  title: focus.activeTask.title,
                  priority: focus.activeTask.priority,
                  startedAt: focus.activeTask.startedAt,
                } : null,
                queue: focus.queue.map(item => ({
                  id: item.id,
                  terminal: item.terminal,
                  title: item.title,
                  priority: item.priority,
                  status: item.status,
                  blockedReason: item.blockedReason,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'set_active_task': {
        const taskId = String(args.task_id || '');
        if (!taskId) {
          throw new Error('task_id is required');
        }
        setActiveTask(taskId);
        const focus = getFocusQueue();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                activeTask: taskId,
                summary: focus.summary,
              }, null, 2),
            },
          ],
        };
      }

      case 'add_focus_item': {
        const id = String(args.id || '');
        const terminal = String(args.terminal || '');
        const title = String(args.title || '');
        const priority = args.priority as 'critical' | 'high' | 'medium' | 'low';

        if (!id || !terminal || !title || !priority) {
          throw new Error('id, terminal, title, and priority are required');
        }

        addFocusItem({ id, terminal, title, priority });
        const focus = getFocusQueue();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                added: { id, terminal, title, priority },
                queueLength: focus.queue.length,
                summary: focus.summary,
              }, null, 2),
            },
          ],
        };
      }

      case 'set_task_status': {
        const taskId = String(args.task_id || '');
        const status = args.status as 'blocked' | 'done';
        const reason = args.reason ? String(args.reason) : undefined;

        if (!taskId || !status) {
          throw new Error('task_id and status are required');
        }

        if (status === 'blocked') {
          if (!reason) {
            throw new Error('reason is required when status is blocked');
          }
          setTaskBlocked(taskId, reason);
        } else if (status === 'done') {
          setTaskDone(taskId);
        }

        const focus = getFocusQueue();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                taskId,
                newStatus: status,
                reason: reason || undefined,
                summary: focus.summary,
              }, null, 2),
            },
          ],
        };
      }

      case 'set_focus_queue': {
        const items = args.items as Array<{
          id: string;
          terminal: string;
          title: string;
          priority: 'critical' | 'high' | 'medium' | 'low';
          status: 'queued' | 'active' | 'blocked' | 'done';
          blockedReason?: string;
        }>;

        if (!items || !Array.isArray(items)) {
          throw new Error('items array is required');
        }

        setFocusQueue(items);
        const focus = getFocusQueue();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                itemCount: items.length,
                activeTask: focus.activeTask?.id || null,
                summary: focus.summary,
              }, null, 2),
            },
          ],
        };
      }

      // Telegram tools (2026-06-24, updated 2026-06-29 for multi-bot, 2026-07-04 ADR-060)
      case 'telegram_reply': {
        const chatId = Number(args.chat_id);
        const message = String(args.message || '');
        // Prefer explicit from_terminal param, fall back to callerTerminal
        const fromTerminal = args.from_terminal ? String(args.from_terminal) : (callerTerminal || 'unknown');
        let conversationId = args.conversation_id ? Number(args.conversation_id) : undefined;
        const replyToMessageId = args.reply_to_message_id ? Number(args.reply_to_message_id) : undefined;
        const parseMode = (args.parse_mode as 'HTML' | 'Markdown') || 'HTML';

        if (!chatId || !message) {
          throw new Error('chat_id and message are required');
        }

        // ADR-060: Always record outgoing messages in DB
        // Find or create conversation for this chat
        if (!conversationId) {
          try {
            const existingConv = findActiveConversation(chatId);
            if (existingConv) {
              conversationId = existingConv.id;
            } else {
              // Create a new conversation for tracking
              const newConv = createConversation({
                chatId,
                userId: 0, // Unknown user ID for outgoing-only conversations
                username: undefined,
                contextTerminal: fromTerminal,
              });
              conversationId = newConv.id;
            }
          } catch (err) {
            logger.warn('[MCP] telegram_reply: Failed to get/create conversation:', err);
          }
        }

        // Queue the response for async sending
        const queueItem = queueResponse({
          chatId,
          conversationId,
          message,
          replyToMessageId,
          fromTerminal,
          parseMode,
        });

        // ADR-060: Always record in conversation_messages for context
        if (conversationId) {
          try {
            const lastMsgId = getLastIncomingMessageId(conversationId);
            addMessage({
              conversationId,
              telegramMessageId: 0, // Will be updated when actually sent
              direction: 'out',
              content: message,
              fromTerminal,
              replyToMessageId: replyToMessageId || lastMsgId || undefined,
            });
            logger.info(`[MCP] telegram_reply: Saved outgoing message to conversation ${conversationId}`);
          } catch (err) {
            logger.warn('[MCP] telegram_reply: Failed to save message to conversation:', err);
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                queueId: queueItem.id,
                chatId,
                conversationId,
                fromTerminal,
                status: 'queued',
                messageRecorded: !!conversationId,
              }, null, 2),
            },
          ],
        };
      }

      case 'telegram_broadcast': {
        const targets = args.targets as string[];
        const message = String(args.message || '');
        const priority = (args.priority as string) || 'medium';

        if (!targets || targets.length === 0 || !message) {
          throw new Error('targets array and message are required');
        }

        const results: Array<{ terminal: string; success: boolean; error?: string }> = [];

        for (const target of targets) {
          try {
            const injected = await injectMessageToTerminal(
              target,
              message,
              callerTerminal || 'unknown',
              priority
            );
            results.push({ terminal: target, success: injected });
          } catch (err) {
            results.push({
              terminal: target,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const successCount = results.filter(r => r.success).length;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: successCount > 0,
                totalTargets: targets.length,
                successCount,
                failedCount: targets.length - successCount,
                results,
                fromTerminal: callerTerminal,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_telegram_history': {
        const chatId = Number(args.chat_id);
        const conversationId = args.conversation_id ? Number(args.conversation_id) : undefined;
        const limit = args.limit ? Math.min(Number(args.limit), 50) : 10;

        if (!chatId) {
          throw new Error('chat_id is required');
        }

        // Find conversation
        let conversation: ReturnType<typeof getConversation> | ReturnType<typeof findActiveConversation>;
        if (conversationId) {
          conversation = getConversation(conversationId);
        } else {
          conversation = findActiveConversation(chatId);
        }

        if (!conversation) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'No conversation found for this chat_id',
                  chatId,
                }, null, 2),
              },
            ],
          };
        }

        // Get messages
        const messages = getConversationMessages(conversation.id, limit);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                chatId: conversation.chatId,
                conversationId: conversation.id,
                username: conversation.username,
                contextTerminal: conversation.contextTerminal,
                totalMessages: messages.length,
                messages: messages.map(msg => ({
                  id: msg.id,
                  direction: msg.direction,
                  content: msg.content,
                  fromTerminal: msg.fromTerminal,
                  timestamp: msg.createdAt,
                })),
              }, null, 2),
            },
          ],
        };
      }

      // Terminal Review Tools (ADR-053 + MSG-122)
      case 'request_review': {
        const reviewer = String(args.reviewer || '');
        const inboxMessageId = String(args.inbox_message_id || '');
        const doneMessageId = String(args.done_message_id || '');

        if (!['architect', 'librarian'].includes(reviewer)) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: `Invalid reviewer: ${reviewer}. Must be 'architect' or 'librarian'.`
              }, null, 2)
            }]
          };
        }

        if (!inboxMessageId || !doneMessageId) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'inbox_message_id and done_message_id are required'
              }, null, 2)
            }]
          };
        }

        // Import requestReview from terminalReviewer
        const { requestReview } = await import('./pipeline/terminalReviewer');

        const result = await requestReview(
          reviewer as 'architect' | 'librarian',
          inboxMessageId,
          doneMessageId
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: result.verdict !== 'PENDING_MANUAL',
              ...result
            }, null, 2)
          }]
        };
      }

      // Parallel Worker Management Tools (ADR-049 Phase 3)
      case 'spawn_parallel_workers': {
        const terminal = String(args.terminal);
        const tasks = args.tasks as Array<{
          id: string;
          prompt: string;
          model?: 'haiku' | 'sonnet' | 'opus';
          depends_on?: string[];
        }>;

        if (!terminal || !tasks || !Array.isArray(tasks)) {
          throw new Error('terminal and tasks array are required');
        }

        // Validate DAG
        const workTasks = tasks.map(t => ({
          id: t.id,
          depends_on: t.depends_on || [],
        }));
        const validation = validateDependencies(workTasks);

        if (!validation.valid) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: validation.error,
                }, null, 2),
              },
            ],
          };
        }

        // Get parallel batches
        const batches = getParallelBatches(workTasks);

        // Start first batch
        const firstBatch = batches[0] || [];
        const results = await Promise.all(
          firstBatch.map(async (taskId) => {
            const task = tasks.find(t => t.id === taskId);
            if (!task) {
              return {
                taskId,
                success: false,
                message: 'Task not found',
              };
            }

            const result = await startParallelWorkSession({
              terminal,
              taskId: task.id,
              prompt: task.prompt,
              model: task.model || 'sonnet',
              depends_on: task.depends_on,
            });

            return {
              taskId: task.id,
              success: result.success,
              workerId: result.workerId,
              message: result.message,
            };
          })
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                started: results,
                queued: batches.slice(1).flat(),
                totalBatches: batches.length,
                executionOrder: validation.executionOrder,
              }, null, 2),
            },
          ],
        };
      }

      case 'spawn_raw_workers': {
        const terminal = String(args.terminal);
        const task = String(args.task);
        const count = Number(args.count);
        const model = (args.model as 'haiku' | 'sonnet') || 'haiku';
        const criteria = String(args.criteria);

        if (!terminal || !task || !count || !criteria) {
          throw new Error('terminal, task, count, and criteria are required');
        }

        if (count < 2 || count > 5) {
          throw new Error('count must be between 2 and 5');
        }

        // Spawn workers
        const spawnResult = await spawnRawWorkers({
          terminal,
          task,
          count,
          model,
        });

        if (!spawnResult.success || !spawnResult.workerIds) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: spawnResult.message,
                }, null, 2),
              },
            ],
          };
        }

        // Wait for workers to complete (polling with timeout)
        const timeout = 5 * 60 * 1000; // 5 minutes
        const startTime = Date.now();
        let allDone = false;
        let results: Array<{ workerId: string; output: string; status: 'done' | 'running' | 'failed' }> = [];

        while (!allDone && (Date.now() - startTime) < timeout) {
          results = await collectRawResults(terminal, spawnResult.workerIds);
          allDone = results.every(r => r.status === 'done' || r.status === 'failed');

          if (!allDone) {
            // Wait 2 seconds before next poll
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // Filter completed results
        const completedResults = results.filter(r => r.status === 'done');

        if (completedResults.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: 'No workers completed successfully within timeout',
                  results,
                }, null, 2),
              },
            ],
          };
        }

        // Select best result using automatic selection
        const rawResults: RawResult[] = completedResults.map(r => ({
          workerId: r.workerId,
          output: r.output,
          status: r.status, // 'done' for completed results
        }));

        const selection = selectBestResultAutomatic(rawResults, criteria);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                bestResult: selection,
                totalWorkers: count,
                completedWorkers: completedResults.length,
                criteria,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_worker_status': {
        const terminal = String(args.terminal);

        if (!terminal) {
          throw new Error('terminal is required');
        }

        const workers = getActiveWorkers(terminal);
        const currentHourlyCost = getCurrentHourlyCost(terminal);
        const maxParallel = calculateMaxParallel(terminal);
        const costAlert = checkCostAlerts(terminal);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                terminal,
                workers: workers.map(w => ({
                  id: w.id,
                  taskId: w.taskId,
                  status: w.status,
                  model: w.model,
                  startedAt: w.startedAt,
                  depends_on: w.depends_on,
                  sessionName: w.sessionName,
                })),
                activeCount: workers.filter(w => w.status === 'running').length,
                queuedCount: workers.filter(w => w.status === 'queued').length,
                currentHourlyCost,
                maxParallel,
                alertLevel: costAlert, // Dashboard uses alertLevel
                capacity: {
                  current: workers.filter(w => w.status === 'running').length,
                  max: maxParallel,
                  available: Math.max(0, maxParallel - workers.filter(w => w.status === 'running').length),
                },
              }, null, 2),
            },
          ],
        };
      }

      // ─── Code Generation Tools (ADR-050 Phase 4) ─────────────────────────────

      case 'generate_api_client': {
        try {
          const params: GenerateApiClientParams = {
            source: String(args.source) as 'kernel' | 'orchestrator',
            target: String(args.target) as 'portal' | 'orchestrator',
            outputDir: args.outputDir ? String(args.outputDir) : undefined,
          };

          const result = await generateApiClient(params);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: result.success,
                  target: result.target,
                  filesGenerated: result.filesGenerated,
                  duration: `${result.duration}ms`,
                  error: result.error,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('[MCP] generate_api_client error:', error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'generate_component': {
        try {
          const params: GenerateComponentParams = {
            name: String(args.name),
            category: String(args.category) as 'feature' | 'ui' | 'layout',
            withTest: Boolean(args.withTest),
            withStory: Boolean(args.withStory),
            props: args.props as GenerateComponentParams['props'],
          };

          const result = await generateComponent(params);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: result.success,
                  componentPath: result.componentPath,
                  filesCreated: result.filesCreated,
                  error: result.error,
                  usage: result.success
                    ? `import { ${params.name} } from '@/components/${params.category === 'feature' ? 'features' : params.category}/${params.name}';`
                    : undefined,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('[MCP] generate_component error:', error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'generate_module': {
        try {
          const params: GenerateModuleParams = {
            name: String(args.name),
            aggregate: String(args.aggregate || args.name),
            states: (args.states as string[]) || [],
            events: args.events as string[] | undefined,
            endpoints: args.endpoints as GenerateModuleParams['endpoints'],
          };

          const result = await generateModule(params);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: result.success,
                  modulePath: result.modulePath,
                  filesCreated: result.filesCreated,
                  error: result.error,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('[MCP] generate_module error:', error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'generate_hook': {
        try {
          const params: GenerateHookParams = {
            name: String(args.name),
            type: String(args.type) as 'query' | 'mutation' | 'state' | 'effect',
            withTest: Boolean(args.withTest),
            withCache: Boolean(args.withCache),
            endpoint: args.endpoint ? String(args.endpoint) : undefined,
          };

          const result = await generateHook(params);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: result.success,
                  hookPath: result.hookPath,
                  filesCreated: result.filesCreated,
                  error: result.error,
                  usage: result.success
                    ? `import { use${params.name.charAt(0).toUpperCase() + params.name.slice(1)} } from '@/hooks/use${params.name.charAt(0).toUpperCase() + params.name.slice(1)}';`
                    : undefined,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('[MCP] generate_hook error:', error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                }, null, 2),
              },
            ],
          };
        }
      }

      case 'get_codegen_status': {
        const status = await getCodegenStatus();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                configuration: {
                  orvalConfig: status.orvalConfigExists ? 'Found' : 'Missing',
                  nswagConfig: status.nswagConfigExists ? 'Found' : 'Missing',
                },
                generated: {
                  portalApi: status.portalApiGenerated ? `${status.generatedFiles.portal} files` : 'Not generated',
                  orchestratorApi: status.orchestratorApiGenerated ? 'Generated' : 'Not generated',
                },
                commands: {
                  generateAll: 'spaceos generate api-client',
                  generatePortal: 'spaceos generate api-client portal',
                  generateOrchestrator: 'spaceos generate api-client orchestrator',
                },
              }, null, 2),
            },
          ],
        };
      }

      // ─── Frontend Verification Tools (MSG-NEXUS-002) ────────────────────────

      case 'check_api_client_status': {
        try {
          const params: CheckApiClientStatusParams = {
            module: String(args.module),
          };
          const result = await checkApiClientStatus(params);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('[MCP] check_api_client_status error:', error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: false, error: String(error) }),
              },
            ],
          };
        }
      }

      case 'verify_frontend_build': {
        try {
          const params: VerifyFrontendBuildParams = {
            project: String(args.project),
            run_tests: Boolean(args.run_tests || false),
          };
          const result = await verifyFrontendBuild(params);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('[MCP] verify_frontend_build error:', error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  typescript_errors: 999,
                  build_time_estimate: 'unknown',
                  bundle_size_mb: 0,
                  chunk_warnings: [String(error)],
                  buildable: false,
                }),
              },
            ],
          };
        }
      }

      case 'scaffold_from_pattern': {
        try {
          const params: ScaffoldFromPatternParams = {
            pattern: String(args.pattern),
            module: String(args.module),
            entity: String(args.entity),
          };
          const result = await scaffoldFromPattern(params);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('[MCP] scaffold_from_pattern error:', error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  filesCreated: [],
                  componentPath: '',
                  error: String(error),
                }),
              },
            ],
          };
        }
      }

      case 'analyze_bundle_size': {
        try {
          const params: AnalyzeBundleSizeParams = {
            project: String(args.project),
          };
          const result = await analyzeBundleSize(params);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('[MCP] analyze_bundle_size error:', error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  total_size_mb: 0,
                  gzip_size_mb: 0,
                  top_chunks: [],
                  lazy_loading_candidates: [],
                  recommendations: [String(error)],
                }),
              },
            ],
          };
        }
      }

      // Goal tools (ADR-059 - Monitor-Driven Goal Progression)
      case 'create_goal': {
        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Only root and conductor can create goals
        if (callerTerminal !== 'root' && callerTerminal !== 'conductor') {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot create goals. Only root and conductor can create goals.`
            }, null, 2) }],
          };
        }

        const params: CreateGoalParams = {
          created_by: String(args.created_by || callerTerminal || 'unknown'),
          epic_id: args.epic_id ? String(args.epic_id) : undefined,
          description: String(args.description || ''),
          checkpoint_id: args.checkpoint_id ? String(args.checkpoint_id) : undefined,
          completion_criteria: (args.completion_criteria as CreateGoalParams['completion_criteria']) || [],
          trigger_terminal: String(args.trigger_terminal || 'conductor'),
          next_goal: args.next_goal ? String(args.next_goal) : undefined,
          prompt: String(args.prompt || ''),
          expires_in_hours: args.expires_in_hours ? Number(args.expires_in_hours) : undefined,
        };

        const goal = await createGoal(params);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            goal_id: goal.id,
            status: goal.status,
            message: `Goal created: ${goal.id}`,
            goal,
          }, null, 2) }],
        };
      }

      case 'list_goals': {
        const status = args.status ? String(args.status) as GoalStatus : undefined;
        const goals = await listGoals(status);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            count: goals.length,
            status: status || 'all',
            goals,
          }, null, 2) }],
        };
      }

      case 'get_goal': {
        const goalId = String(args.goal_id || '');
        const goal = await getGoal(goalId);
        if (!goal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Goal not found: ${goalId}`,
            }, null, 2) }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            goal,
          }, null, 2) }],
        };
      }

      case 'check_goal_criteria': {
        const goalId = String(args.goal_id || '');
        const goal = await getGoal(goalId);
        if (!goal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Goal not found: ${goalId}`,
            }, null, 2) }],
          };
        }

        const { allMet, results } = await checkGoalCriteria(goal);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            goal_id: goalId,
            all_criteria_met: allMet,
            results,
          }, null, 2) }],
        };
      }

      case 'trigger_goal': {
        // Check if caller terminal is identified
        if (!callerTerminal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Caller terminal not identified. Check MCP token configuration.'
            }, null, 2) }],
          };
        }

        // Only monitor can trigger goals
        if (callerTerminal !== 'root' && callerTerminal !== 'monitor') {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Terminal ${callerTerminal} cannot trigger goals. Only root and monitor can trigger goals.`
            }, null, 2) }],
          };
        }

        const goalId = String(args.goal_id || '');
        const goal = await getGoal(goalId);
        if (!goal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Goal not found: ${goalId}`,
            }, null, 2) }],
          };
        }

        // Check criteria before triggering
        const { allMet, results } = await checkGoalCriteria(goal);
        if (!allMet) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: 'Not all criteria are met',
              results,
            }, null, 2) }],
          };
        }

        // Create trigger message for target terminal
        const triggerResult = await createTask({
          from: 'monitor',
          to: goal.on_complete.trigger_terminal,
          title: `Goal Completed: ${goal.goal.description}`,
          description: goal.on_complete.prompt
            .replace(/\{\{goal\.description\}\}/g, goal.goal.description)
            .replace(/\{\{on_complete\.next_goal\}\}/g, goal.on_complete.next_goal || '')
            .replace(/\{\{completed_criteria\}\}/g, results.map(r => `- ${r.met ? '✓' : '✗'} ${r.criterion.type}: ${r.details}`).join('\n')),
          priority: 'high',
          model: 'sonnet',
          ref: goalId,
        });

        // Mark goal as triggered
        const triggerId = triggerResult.id || 'unknown';
        await triggerGoal(goalId, triggerId, results);

        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            goal_id: goalId,
            trigger_message_id: triggerId,
            target_terminal: goal.on_complete.trigger_terminal,
            message: `Goal triggered, notification sent to ${goal.on_complete.trigger_terminal}`,
          }, null, 2) }],
        };
      }

      case 'complete_goal': {
        const goalId = String(args.goal_id || '');
        const goal = await completeGoal(goalId);
        if (!goal) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: false,
              error: `Goal not found: ${goalId}`,
            }, null, 2) }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            goal_id: goalId,
            status: goal.status,
            completed_at: goal.completed_at,
            message: `Goal completed: ${goalId}`,
          }, null, 2) }],
        };
      }

      // Memory Management tools (MSG-BACKEND-192)
      case 'memory_health_report': {
        const report = await getMemoryHealthReport();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      }

      case 'compress_memory': {
        const params: CompressMemoryParams = {
          terminal: String(args.terminal || ''),
          strategy: (args.strategy as 'aggressive' | 'moderate' | 'conservative') || 'moderate',
          preserve_sections: (args.preserve_sections as string[]) || undefined,
          dry_run: args.dry_run !== false, // Default: true
        };
        const result = await compressMemory(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'extract_patterns': {
        const params: ExtractPatternsParams = {
          terminal: String(args.terminal || 'all'),
          min_frequency: Number(args.min_frequency) || 3,
          pattern_types: (args.pattern_types as Array<'workflow' | 'decision' | 'error_resolution'>) || [],
        };
        const result = await extractPatterns(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // Subscription tools (ADR-052)
      case 'subscribe_to_task':
      case 'subscribe_to_terminal':
      case 'unsubscribe':
      case 'get_subscriptions':
      case 'get_checkpoint_status':
      case 'refresh_checkpoint_subscriptions': {
        const result = handleSubscriptionTool(name, args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // Phase 1 MCP Tools (MSG-BACKEND-173)
      case 'get_terminal_status_aggregate': {
        const format = (args.format as 'summary' | 'detailed' | 'alerts_only') || 'summary';
        const result = await getTerminalStatusAggregate(format);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'resolve_epic_dependencies': {
        const epicId = String(args.epic_id || '');
        const checkBlockers = (args.check_blockers as boolean) !== false;
        if (!epicId) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'epic_id is required' }),
              },
            ],
          };
        }
        const result = await resolveDependencies(epicId, checkBlockers);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'transfer_session_context': {
        const fromTerminal = String(args.from_terminal || '');
        const toTerminal = String(args.to_terminal || '');
        const contextType = args.context_type as 'research_summary' | 'code_audit' | 'knowledge_synthesis';
        const summary = String(args.summary || '');
        const includeFiles = (args.include_files as string[]) || [];
        const result = await transferSessionContext({
          fromTerminal,
          toTerminal,
          contextType,
          summary: summary || undefined,
          includeFiles: includeFiles.length > 0 ? includeFiles : undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'match_domain_pattern': {
        const description = String(args.description || '');
        const domain = args.domain as string | undefined;
        if (!description) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'description is required' }),
              },
            ],
          };
        }
        const result = await matchDomainPattern(description, domain);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'scaffold_react_hook': {
        const name = String(args.name || '');
        const type = args.type as 'query' | 'mutation' | 'state' | 'effect';
        if (!name || !type) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'name and type are required' }),
              },
            ],
          };
        }
        const params: GenerateHookParams = {
          name,
          type,
          withTest: (args.with_test as boolean) !== false,
          withCache: (args.with_cache as boolean) === true,
          endpoint: args.endpoint as string | undefined,
        };
        const result = await generateHook(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // Skill Factory (MSG-NEXUS-005)
      case 'create_skill': {
        const params: CreateSkillParams = {
          name: String(args.name || ''),
          template: String(args.template || ''),
          description: args.description as string | undefined,
          trigger_patterns: args.trigger_patterns as string[] | undefined,
        };
        const result = await createSkill(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'list_all_skills': {
        const skills = await listAllSkills();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ skills }, null, 2),
            },
          ],
        };
      }

      case 'get_skill_metadata': {
        const skillName = String(args.skill_name || '');
        if (!skillName) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'skill_name is required' }),
              },
            ],
          };
        }
        const metadata = await getSkillMetadata(skillName);
        if (!metadata) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Skill not found: ${skillName}` }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(metadata, null, 2),
            },
          ],
        };
      }

      case 'delete_skill': {
        const skillName = String(args.skill_name || '');
        if (!skillName) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'skill_name is required' }),
              },
            ],
          };
        }
        const result = await deleteSkill(skillName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // Epic Progress Tracker (MSG-NEXUS-005)
      case 'get_epic_progress': {
        const epicId = String(args.epic_id || '');
        if (!epicId) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'epic_id is required' }),
              },
            ],
          };
        }
        const progress = await getEpicProgress(epicId);
        if (!progress) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Epic not found: ${epicId}` }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(progress, null, 2),
            },
          ],
        };
      }

      case 'get_all_epics_progress': {
        const allProgress = await getAllEpicsProgress();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ epics: allProgress }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: msg }, null, 2),
        },
      ],
    };
  }
}

// ─── MCP JSON-RPC Handler ───────────────────────────────────────────────────

router.post('/', authenticateMcp, async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body;

  if (jsonrpc !== '2.0') {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      id: id || null,
    });
    return;
  }

  try {
    switch (method) {
      case 'initialize': {
        res.json({
          jsonrpc: '2.0',
          result: {
            protocolVersion: MCP_VERSION,
            serverInfo: {
              name: 'spaceos-knowledge-service',
              version: '1.4.0',
            },
            capabilities: {
              tools: {},
            },
          },
          id,
        });
        break;
      }

      case 'tools/list': {
        // Legacy TOOLS array + registry-based tools, filtered by permissions
        const callerTerminal = req.mcpTerminal || 'root';
        const allTools = [...TOOLS, ...toolRegistry.getDefinitions()];
        const visibleTools = filterToolsForTerminal(allTools, callerTerminal);

        res.json({
          jsonrpc: '2.0',
          result: {
            tools: visibleTools,
          },
          id,
        });
        break;
      }

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (!name) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32602, message: 'Invalid params: name is required' },
            id,
          });
          return;
        }

        // Check tool permission
        const callerTerminal = req.mcpTerminal || 'root';
        if (!canUseTool(callerTerminal, name)) {
          logger.info(`[MCP] 🚫 ${name} DENIED for terminal: ${callerTerminal}`);
          res.status(403).json({
            jsonrpc: '2.0',
            error: {
              code: -32003,
              message: `Permission denied: terminal '${callerTerminal}' cannot use tool '${name}'`,
            },
            id,
          });
          return;
        }

        // MCP Tool Call Logging - központi monitoring
        const startTime = Date.now();
        const targetTerminal = (args as Record<string, unknown>)?.terminal as string || 'unknown';
        logger.info(`[MCP] 📥 ${name} (caller: ${callerTerminal}, target: ${targetTerminal})`);

        try {
          const result = await handleToolCall(name, args || {}, callerTerminal, req.mcpIsland);
          const duration = Date.now() - startTime;
          logger.info(`[MCP] ✅ ${name} (${duration}ms)`);

          res.json({
            jsonrpc: '2.0',
            result,
            id,
          });
        } catch (toolErr) {
          const duration = Date.now() - startTime;
          logger.error(`[MCP] ❌ ${name} FAILED (${duration}ms):`, toolErr);
          throw toolErr;
        }
        break;
      }

      case 'notifications/initialized': {
        // Client notification, no response needed
        res.status(204).send();
        break;
      }

      default: {

        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method}` },
          id,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: msg },
      id,
    });
  }
});

// ─── MCP Info Endpoint (GET) ────────────────────────────────────────────────

router.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'spaceos-knowledge-service',
    version: '1.3.0',
    protocol: MCP_VERSION,
    description: 'SpaceOS Knowledge Service MCP Server - RAG search, mailbox, identity, memory, skills, workflow, terminal setup, terminal docs',
    tools: TOOLS.map(t => t.name),
    toolCount: TOOLS.length,
    terminals: TERMINALS,
    documentation: process.env.MCP_DOCUMENTATION_URL || 'https://nexus.joinerytech.hu',
  });
});

export default router;
