/**
 * Epic Router API Routes
 *
 * API endpoints for epic-aware task routing:
 * - GET /api/epic-router/terminals - Terminal context status
 * - GET /api/epic-router/queue - Task queue status
 * - GET /api/epic-router/queue/:terminal - Queue for specific terminal
 * - POST /api/epic-router/task/:terminal/complete - Mark task completed
 * - GET /api/epic-router/routing/:terminal - Get next task routing decision
 * - POST /api/epic-router/sync - Sync epics from EPICS.yaml
 *
 * SECURITY: Terminal endpoints require Bearer token matching terminal identity
 */

import { Router, Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const TERMINALS_DIR = process.env.TERMINALS_PATH || `${SPACEOS_ROOT}/terminals`;
const DEFAULT_EPICS_PATH = process.env.EPICS_PATH || `${SPACEOS_ROOT}/docs/projects/EPICS.yaml`;
import {
  getTerminalContext,
  getTerminalStatistics,
  getQueueStatistics,
  getQueueForTerminal,
  getQueueForEpic,
  getNextTaskForTerminal,
  handleTaskCompletion,
  dispatchTask,
  queueTask,
  syncFromEpicsYaml,
  listActiveProjects,
  listActiveEpics,
  createProject,
  createEpic,
  TerminalStatsRow,
  QueueStatsRow,
} from '../../../pipeline/epicRouter';
import { terminateColdSession } from '../../../sessionStarter';
import { getSessionMode } from '../../../config/terminals';

const router = Router();

// ─── Terminal Token Authentication ───────────────────────────────────────────

/**
 * Terminal tokens are derived from a secret + terminal name
 * Format: SHA256(secret + terminal)[:32]
 *
 * This ensures:
 * 1. Each terminal has a unique token
 * 2. Tokens cannot be guessed without the secret
 * 3. Server can verify token → terminal mapping
 */
const TERMINAL_SECRET = process.env.TERMINAL_TOKEN_SECRET || 'spaceos-terminal-secret-2026';

function generateTerminalToken(terminal: string): string {
  return crypto
    .createHash('sha256')
    .update(TERMINAL_SECRET + terminal)
    .digest('hex')
    .slice(0, 32);
}

function verifyTerminalToken(token: string, terminal: string): boolean {
  const expectedToken = generateTerminalToken(terminal);
  return crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(expectedToken)
  );
}

/**
 * Middleware to verify terminal token from Authorization header
 * Expects: Authorization: Bearer <token>
 */
function requireTerminalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'Missing or invalid Authorization header. Expected: Bearer <token>'
    });
    return;
  }

  const token = authHeader.slice(7); // Remove "Bearer "
  const terminal = req.params.terminal as string;

  if (!terminal) {
    res.status(400).json({
      success: false,
      error: 'Terminal parameter required'
    });
    return;
  }

  try {
    if (!verifyTerminalToken(token, terminal)) {
      res.status(403).json({
        success: false,
        error: `Invalid token for terminal ${terminal}`
      });
      return;
    }
  } catch {
    res.status(403).json({
      success: false,
      error: 'Token verification failed'
    });
    return;
  }

  next();
}

// ─── Admin endpoint to get terminal token (for setup) ────────────────────────

/**
 * GET /token/:terminal
 * Get the token for a terminal (admin use only)
 * Protected by admin secret
 */
router.get('/token/:terminal', (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET || 'spaceos-admin-2026';
  const providedSecret = req.headers['x-admin-secret'] as string;

  if (providedSecret !== adminSecret) {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }

  const terminal = req.params.terminal as string;
  const token = generateTerminalToken(terminal);

  res.json({
    success: true,
    terminal,
    token,
    usage: `curl -H "Authorization: Bearer ${token}" http://localhost:3456/api/epic-router/fetch/${terminal}/{messageId}`
  });
});

// ─── Terminal Status ─────────────────────────────────────────────────────────

/**
 * GET /terminals
 * Get all terminal contexts with queue sizes
 */
router.get('/terminals', (_req: Request, res: Response) => {
  try {
    const terminals: TerminalStatsRow[] = getTerminalStatistics();
    res.json({
      success: true,
      terminals,
      count: terminals.length,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error getting terminals:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /terminals/:terminal
 * Get specific terminal context
 */
router.get('/terminals/:terminal', (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const context = getTerminalContext(terminal);

    if (!context) {
      res.status(404).json({ success: false, error: `Terminal ${terminal} not found` });
      return;
    }

    res.json({
      success: true,
      terminal: context,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error getting terminal:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Queue Management ────────────────────────────────────────────────────────

/**
 * GET /queue
 * Get queue statistics (grouped by terminal and epic)
 */
router.get('/queue', (_req: Request, res: Response) => {
  try {
    const stats: QueueStatsRow[] = getQueueStatistics();
    const totalQueued = stats.reduce((sum, s) => sum + s.count, 0);

    res.json({
      success: true,
      stats,
      totalQueued,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error getting queue stats:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /queue/terminal/:terminal
 * Get queued tasks for a specific terminal
 */
router.get('/queue/terminal/:terminal', (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const tasks = getQueueForTerminal(terminal);

    res.json({
      success: true,
      terminal,
      tasks,
      count: tasks.length,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error getting terminal queue:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /queue/epic/:epicId
 * Get queued tasks for a specific epic
 */
router.get('/queue/epic/:epicId', (req: Request, res: Response) => {
  try {
    const epicId = req.params.epicId as string;
    const tasks = getQueueForEpic(epicId);

    res.json({
      success: true,
      epicId,
      tasks,
      count: tasks.length,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error getting epic queue:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * POST /queue
 * Add task to queue
 */
router.post('/queue', (req: Request, res: Response) => {
  try {
    const { messageId, terminal, epicId, projectId, priority } = req.body;

    if (!messageId || !terminal) {
      res.status(400).json({ success: false, error: 'messageId and terminal are required' });
      return;
    }

    queueTask(messageId, terminal, epicId || null, projectId || null, priority || 'medium');

    res.json({
      success: true,
      message: `Task ${messageId} queued for ${terminal}`,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error queueing task:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Task Routing ────────────────────────────────────────────────────────────

/**
 * GET /routing/:terminal
 * Get next task routing decision for a terminal
 * SECURITY: Requires valid terminal token
 */
router.get('/routing/:terminal', requireTerminalAuth, (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const decision = getNextTaskForTerminal(terminal);

    res.json({
      success: true,
      terminal,
      decision,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error getting routing decision:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * POST /task/:terminal/complete
 * Mark a task as completed and get next routing decision
 * SECURITY: Requires valid terminal token
 */
router.post('/task/:terminal/complete', requireTerminalAuth, (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const { messageId, epicId } = req.body;

    if (!messageId) {
      res.status(400).json({ success: false, error: 'messageId is required' });
      return;
    }

    const decision = handleTaskCompletion(terminal, messageId, epicId || null);

    res.json({
      success: true,
      terminal,
      messageId,
      decision,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error completing task:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * POST /dispatch/:terminal
 * Dispatch queued task to terminal
 * SECURITY: Requires valid terminal token
 */
router.post('/dispatch/:terminal', requireTerminalAuth, (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const decision = getNextTaskForTerminal(terminal);

    if (!decision.shouldDispatch || !decision.task) {
      res.json({
        success: false,
        terminal,
        reason: decision.reason,
        nextAction: decision.nextAction,
      });
      return;
    }

    // Dispatch the task
    dispatchTask(terminal, decision.task);

    res.json({
      success: true,
      terminal,
      task: decision.task,
      reason: decision.reason,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error dispatching task:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Projects & Epics ────────────────────────────────────────────────────────

/**
 * GET /projects
 * List all active projects
 */
router.get('/projects', (_req: Request, res: Response) => {
  try {
    const projects = listActiveProjects();
    res.json({
      success: true,
      projects,
      count: projects.length,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error listing projects:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * POST /projects
 * Create a new project
 */
router.post('/projects', (req: Request, res: Response) => {
  try {
    const { id, name, description, status } = req.body;

    if (!id || !name) {
      res.status(400).json({ success: false, error: 'id and name are required' });
      return;
    }

    const project = createProject({
      id,
      name,
      description,
      status: status || 'active',
    });

    res.json({
      success: true,
      project,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error creating project:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /epics
 * List all active epics
 */
router.get('/epics', (_req: Request, res: Response) => {
  try {
    const epics = listActiveEpics();
    res.json({
      success: true,
      epics,
      count: epics.length,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error listing epics:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * POST /epics
 * Create a new epic
 */
router.post('/epics', (req: Request, res: Response) => {
  try {
    const { id, project_id, name, description, status, priority, depends_on, target_date } = req.body;

    if (!id || !project_id || !name) {
      res.status(400).json({ success: false, error: 'id, project_id and name are required' });
      return;
    }

    const epic = createEpic({
      id,
      project_id,
      name,
      description,
      status: status || 'pending',
      priority: priority || 2,
      depends_on,
      target_date,
    });

    res.json({
      success: true,
      epic,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error creating epic:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Task Fetch (Terminal API) ───────────────────────────────────────────────

/**
 * GET /fetch/:terminal/:messageId
 * Fetch assigned task content for a terminal
 *
 * SECURITY:
 * 1. Requires valid terminal token (Authorization: Bearer <token>)
 * 2. Terminal can ONLY fetch tasks that are assigned to it
 * 3. Returns the task content if the task is currently assigned to this terminal
 */
router.get('/fetch/:terminal/:messageId', requireTerminalAuth, async (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const messageId = req.params.messageId as string;

    // Verify terminal context - task must be assigned to this terminal
    const ctx = getTerminalContext(terminal);

    if (!ctx) {
      res.status(404).json({
        success: false,
        error: `Terminal ${terminal} not found`
      });
      return;
    }

    // Security check: only allow fetching the currently assigned task
    if (ctx.current_task_id !== messageId) {
      res.status(403).json({
        success: false,
        error: `Task ${messageId} is not assigned to terminal ${terminal}`,
        currentTask: ctx.current_task_id || 'none'
      });
      return;
    }

    // Read the task content from inbox
    const fs = await import('fs/promises');
    const path = await import('path');
    const inboxPath = path.join(TERMINALS_DIR, terminal, 'inbox');

    // Find the message file
    const files = await fs.readdir(inboxPath);
    let taskContent: string | null = null;
    let taskFilePath: string | null = null;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(inboxPath, file);
      const content = await fs.readFile(filePath, 'utf-8');

      if (content.includes(`id: ${messageId}`)) {
        taskContent = content;
        taskFilePath = filePath;
        break;
      }
    }

    if (!taskContent) {
      res.status(404).json({
        success: false,
        error: `Task ${messageId} not found in ${terminal} inbox`
      });
      return;
    }

    // Parse frontmatter
    const yaml = await import('js-yaml');
    const frontmatterMatch = taskContent.match(/^---\n([\s\S]*?)\n---/);
    let frontmatter: any = {};
    let body = taskContent;

    if (frontmatterMatch) {
      frontmatter = yaml.load(frontmatterMatch[1]);
      body = taskContent.slice(frontmatterMatch[0].length).trim();
    }

    res.json({
      success: true,
      task: {
        id: messageId,
        terminal,
        epic_id: ctx.current_epic_id,
        project_id: ctx.current_project_id,
        frontmatter,
        content: body,
        filePath: taskFilePath,
      }
    });
  } catch (error) {
    console.error('[EpicRouter API] Error fetching task:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * POST /ack/:terminal/:messageId
 * Acknowledge task receipt - mark as READ
 * SECURITY: Requires valid terminal token
 */
router.post('/ack/:terminal/:messageId', requireTerminalAuth, async (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const messageId = req.params.messageId as string;

    // Verify terminal context
    const ctx = getTerminalContext(terminal);

    if (!ctx || ctx.current_task_id !== messageId) {
      res.status(403).json({
        success: false,
        error: `Task ${messageId} is not assigned to terminal ${terminal}`
      });
      return;
    }

    // Mark message as READ in file
    const fs = await import('fs/promises');
    const path = await import('path');
    const inboxPath = path.join(TERMINALS_DIR, terminal, 'inbox');

    const files = await fs.readdir(inboxPath);
    let updated = false;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(inboxPath, file);
      const content = await fs.readFile(filePath, 'utf-8');

      if (content.includes(`id: ${messageId}`) && content.includes('status: UNREAD')) {
        const newContent = content.replace('status: UNREAD', 'status: READ');
        await fs.writeFile(filePath, newContent, 'utf-8');
        updated = true;
        break;
      }
    }

    res.json({
      success: true,
      acknowledged: updated,
      messageId,
      terminal,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error acknowledging task:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Sync ────────────────────────────────────────────────────────────────────

/**
 * POST /sync
 * Sync projects and epics from EPICS.yaml
 */
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const epicsPath = req.body.path || DEFAULT_EPICS_PATH;

    const result = await syncFromEpicsYaml(epicsPath);

    res.json({
      success: true,
      synced: result,
      message: `Synced ${result.projects} projects and ${result.epics} epics`,
    });
  } catch (error) {
    console.error('[EpicRouter API] Error syncing:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Exported functions for MCP integration ─────────────────────────────────

export { generateTerminalToken, verifyTerminalToken };

/**
 * Fetch task content for MCP tool
 * Returns task content if the task is assigned to the terminal
 */
export async function fetchTaskForMcp(terminal: string, messageId: string): Promise<{
  success: boolean;
  error?: string;
  task?: {
    id: string;
    terminal: string;
    epic_id: string | null;
    project_id: string | null;
    frontmatter: any;
    content: string;
  };
}> {
  const ctx = getTerminalContext(terminal);

  if (!ctx) {
    return { success: false, error: `Terminal ${terminal} not found` };
  }

  if (ctx.current_task_id !== messageId) {
    return {
      success: false,
      error: `Task ${messageId} is not assigned to terminal ${terminal}. Current task: ${ctx.current_task_id || 'none'}`
    };
  }

  const fs = await import('fs/promises');
  const path = await import('path');
  const yaml = await import('js-yaml');

  const inboxPath = path.join(TERMINALS_DIR, terminal, 'inbox');
  const files = await fs.readdir(inboxPath);

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(inboxPath, file);
    const content = await fs.readFile(filePath, 'utf-8');

    if (content.includes(`id: ${messageId}`)) {
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let frontmatter: any = {};
      let body = content;

      if (frontmatterMatch) {
        frontmatter = yaml.load(frontmatterMatch[1]);
        body = content.slice(frontmatterMatch[0].length).trim();
      }

      return {
        success: true,
        task: {
          id: messageId,
          terminal,
          epic_id: ctx.current_epic_id || null,
          project_id: ctx.current_project_id || null,
          frontmatter,
          content: body,
        }
      };
    }
  }

  return { success: false, error: `Task ${messageId} not found in ${terminal} inbox` };
}

/**
 * Acknowledge task for MCP tool
 */
export async function ackTaskForMcp(terminal: string, messageId: string): Promise<{
  success: boolean;
  error?: string;
  acknowledged?: boolean;
}> {
  const ctx = getTerminalContext(terminal);

  if (!ctx || ctx.current_task_id !== messageId) {
    return {
      success: false,
      error: `Task ${messageId} is not assigned to terminal ${terminal}`
    };
  }

  const fs = await import('fs/promises');
  const path = await import('path');

  const inboxPath = path.join(TERMINALS_DIR, terminal, 'inbox');
  const files = await fs.readdir(inboxPath);

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(inboxPath, file);
    const content = await fs.readFile(filePath, 'utf-8');

    if (content.includes(`id: ${messageId}`)) {
      const updated = content.replace(/status:\s*UNREAD/g, 'status: READ');
      await fs.writeFile(filePath, updated);
      return { success: true, acknowledged: true };
    }
  }

  return { success: false, error: `Task ${messageId} not found` };
}

/**
 * Complete task for MCP tool
 * 2026-06-24: Added cold session mode support - terminates session after task completion
 */
export async function completeTaskForMcp(terminal: string, messageId: string, summary?: string): Promise<{
  success: boolean;
  error?: string;
  completed?: boolean;
  nextTask?: string | null;
  sessionTerminated?: boolean;
}> {
  const ctx = getTerminalContext(terminal);

  if (!ctx || ctx.current_task_id !== messageId) {
    return {
      success: false,
      error: `Task ${messageId} is not assigned to terminal ${terminal}`
    };
  }

  const epicId = ctx.current_epic_id || null;
  const result = handleTaskCompletion(terminal, messageId, epicId);
  const nextTask = getNextTaskForTerminal(terminal);

  // Cold session mode: terminate session after task completion
  const sessionMode = getSessionMode(terminal);
  let sessionTerminated = false;

  if (sessionMode === 'cold') {
    const taskSummary = summary || `Task ${messageId} completed`;
    const terminateResult = await terminateColdSession(terminal, messageId, taskSummary, 'done');
    sessionTerminated = terminateResult.success;
    console.log(`[EpicRouter] Cold session terminate for ${terminal}: ${terminateResult.message}`);
  }

  return {
    success: true,
    completed: true,
    nextTask: nextTask?.task?.message_id || null,
    sessionTerminated,
  };
}

export default router;
