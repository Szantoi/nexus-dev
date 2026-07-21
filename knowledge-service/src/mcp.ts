/**
 * MCP (Model Context Protocol) HTTP Transport Implementation
 *
 * TRANSPORT ONLY (TASK-QC-008): this file owns the JSON-RPC protocol surface
 * (initialize, tools/list, tools/call, notifications) plus authentication and
 * per-terminal tool permissions. It contains NO tool definitions or handlers.
 *
 * All tools live in the modular registry under interfaces/mcp/tools/
 * (ToolRegistry). tools/list, tools/call and the GET info endpoint are served
 * exclusively from that registry. The public contract (tool names + schemas)
 * is pinned by src/__tests__/integration/mcpContract.integration.test.ts.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { env } from './config/env';
import { logger } from './core/logger';
import { authenticateMcp, authenticateRest } from './auth/tokenAuth';
import { TERMINALS } from './identity';
// Registry-based tools: all definitions + handlers live under
// interfaces/mcp/tools/ and are dispatched via toolRegistry.
import { toolRegistry, registerAllTools, type ToolResult } from './interfaces/mcp/tools';

export { authenticateRest };

const router = Router();

// MCP Protocol Version
const MCP_VERSION = '2024-11-05';

// Populate the registry once at module load (idempotent).
registerAllTools();

// ─── Agent Authentication ───────────────────────────────────────────────────
// Token handling and the authenticate/authenticateRest middlewares live in
// auth/tokenAuth.ts (config/agents.yaml + MCP_AUTH_TOKEN / MCP_TOKEN_<NAME>).

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

// Auto-reload every 30 seconds. unref(): the timer must never keep the
// process (or a test runner) alive on its own.
setInterval(() => {
  loadToolPermissions();
}, RELOAD_INTERVAL_MS).unref();

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
function filterToolsForTerminal<T extends { name: string }>(tools: T[], terminal: string): T[] {
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

// ─── Tool Dispatch ──────────────────────────────────────────────────────────

/**
 * Dispatch a tools/call to the registry handler.
 *
 * Preserves the legacy result contract: handler exceptions are converted to a
 * normal MCP result whose text payload is {"error": <message>} — exactly the
 * shape the old in-file switch produced. Unknown tools are the CALLER's
 * responsibility (the route returns a standard JSON-RPC error before calling
 * this), so this function requires an existing handler.
 */
async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  callerTerminal?: string,  // auth-aware tools (2026-06-24)
  callerIsland?: string     // multi-island: knowledge scope of the caller
): Promise<ToolResult> {
  const handler = toolRegistry.getHandler(name);
  if (!handler) {
    // Defensive: the route guards this already; keep the legacy error shape.
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2) }],
    };
  }

  try {
    return await handler(args, { terminal: callerTerminal, island: callerIsland });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: msg }, null, 2) }],
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
        // Registry-only tool list, filtered by the caller's permissions.
        const callerTerminal = req.mcpTerminal || 'root';
        const visibleTools = filterToolsForTerminal(toolRegistry.getDefinitions(), callerTerminal);

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

        // Unknown tool → standard MCP error (spec: -32602 for invalid tool name)
        if (!toolRegistry.has(name)) {
          logger.warn(`[MCP] ❓ Unknown tool requested: ${name} (caller: ${callerTerminal})`);
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32602, message: `Unknown tool: ${name}` },
            id,
          });
          return;
        }

        // MCP Tool Call Logging - központi monitoring
        const startTime = Date.now();
        const targetTerminal = (args as Record<string, unknown>)?.terminal as string || 'unknown';
        logger.info(`[MCP] 📥 ${name} (caller: ${callerTerminal}, target: ${targetTerminal})`);

        try {
          const result = await dispatchToolCall(name, args || {}, callerTerminal, req.mcpIsland);
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
  const definitions = toolRegistry.getDefinitions();
  res.json({
    name: 'spaceos-knowledge-service',
    version: '1.3.0',
    protocol: MCP_VERSION,
    description: 'SpaceOS Knowledge Service MCP Server - RAG search, mailbox, identity, memory, skills, workflow, terminal setup, terminal docs',
    tools: definitions.map(t => t.name),
    toolCount: definitions.length,
    terminals: TERMINALS,
    documentation: env.MCP_DOCUMENTATION_URL,
  });
});

export default router;
