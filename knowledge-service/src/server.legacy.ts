/**
 * SpaceOS Knowledge Service — Express server
 *
 * Endpoints:
 *   GET  /health
 *   GET  /api/knowledge/search?q=...&topK=5
 *   POST /api/knowledge/search   { q: string, topK?: number }
 *   POST /api/knowledge/index    (re-index docs/knowledge/)
 *   GET  /api/mailbox/:terminal/inbox?status=UNREAD|READ|all
 *   POST /api/mailbox/:terminal/inbox (send_message)
 *   POST /api/mailbox/:terminal/outbox (submit_done)
 *   GET  /api/tasks/status?task_id=...
 *   GET  /api/mailbox/:terminal/subscribe (SSE live notifications)
 *
 * Session Management (MCP):
 *   POST /api/session/start        - Start terminal session with Claude
 *   POST /api/session/inject       - Inject prompt to running session
 *   POST /api/session/wake         - Wake up terminal (start + inbox prompt)
 *   GET  /api/session/:terminal    - Get session status
 *   GET  /api/session/all          - Get all sessions status
 *   GET  /api/session/logs         - Get session audit logs
 *
 * Memory Tier Management (ADR-046 Track D):
 *   GET  /api/memories/tiered      - Query memories by tier
 *   POST /api/memories/save        - Save tiered memory
 *   POST /api/memories/:id/promote - Promote memory to higher tier
 *
 * Session Lifecycle (ADR-046 Track D):
 *   POST /api/session/start-context - Get cold start context
 *   POST /api/session/end          - Handle session end
 *   GET  /api/session/history      - Get session history
 *
 * Daily Digest (ADR-046 Track D):
 *   POST /api/digest/generate      - Generate daily digest
 *   GET  /api/digest/:terminal/:date - Get daily digest
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'events';
import path from 'path';

// Hybrid API immediate trigger (ADR-046)
import { triggerImmediatePipelineAsync } from './pipeline/immediatePipeline';

// ─── Constants ────────────────────────────────────────────────────────────────

const projectRoot = process.env.SPACEOS_ROOT || '/opt/spaceos';

// ─── Rate Limiting (P1 Security) ─────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 500; // 500 requests per minute per IP (increased for dashboard)

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting for health checks and static assets
  if (
    req.path === '/health' ||
    req.path === '/ready' ||
    req.path.startsWith('/assets/') ||
    req.path === '/favicon.svg' ||
    req.path === '/icons.svg'
  ) {
    next();
    return;
  }

  // Get real IP from proxy headers (nginx sets X-Real-IP)
  const ip = (req.headers['x-real-ip'] as string) ||
              (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
              req.ip ||
              req.socket.remoteAddress ||
              'unknown';

  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    next();
    return;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    });
    return;
  }

  entry.count++;
  next();
}

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(ip);
    }
  }
}, 60000);
import {
  initVectorStore,
  searchKnowledge,
  getDocumentCount,
  usingChroma,
} from './vectorStore';
import { embeddingBackend } from './embeddings';
import { buildIndex } from './indexer';
import {
  listInbox,
  listOutbox,
  listAllUnreadOutbox,
  getInboxMessageCounter,
  markAsRead,
  sendMessage,
  submitDone,
  getTaskStatus,
} from './mailbox';
import mcpRouter from './mcp';
import graphRoutes from './api/graphRoutes';
import { createPlanningRouter } from './api/planningRoutes';
import { startInboxWatcher, inboxEvents, InboxEvent, scanExistingUnread, initializeRegistry } from './inboxWatcher';
import {
  queryMessages,
  getUnreadMessages,
  getMessage,
  getMessageStats as registryGetMessageStats,
  verifyMessageHash,
  verifyAllMessages,
  getStatusHistory,
  markAsRead as registryMarkAsRead,
  markAsProcessed,
  type MessageQuery,
} from './messageRegistry';
import {
  registerWorking,
  registerIdle,
  heartbeat,
  shouldWakeUp,
  getAllStatus,
  getStatus,
  getFullTerminalStatus,
} from './terminalStatus';
import { startTerminalSession } from './sessionStarter';
import {
  startSession,
  injectPrompt,
  wakeUpTerminal,
  getSessionStatus,
  getAllSessionsStatus,
  getSessionLogs,
} from './sessionManager';
import {
  validate,
  SearchBodySchema,
  SearchQuerySchema,
  TerminalParamSchema,
  InboxQuerySchema,
  TerminalSchema,
} from './validation';
import {
  startNightwatchScheduler,
  stopNightwatchScheduler,
  startHeartbeatScheduler,
  stopHeartbeatScheduler,
  startAutoRestartScheduler,
  stopAutoRestartScheduler,
  getHeartbeatConfig,
  getDefaultConfig as getAutoRestartConfig,
  // Inter-agent messaging
  initMessageDb,
  closeMessageDb,
  startMessageRouter,
  stopMessageRouter,
  createAgentMessage,
  getPendingMessages,
  getRecentMessages,
  getMessageStats,
  // Channel coordinator
  startChannelCoordinator,
  stopChannelCoordinator,
  getCoordinatorState,
  // Multi-channel provider
  initMultiChannel,
  getMultiChannelStatus,
  notifyAllChannels,
  notifyChannel,
  validateAllTokens,
  getProvider,
  type ChannelProviderType,
  // Telegram Bot
  createTelegramRouter,
  setWebhook as setTelegramWebhook,
  getWebhookInfo,
  // System metrics
  createMetricsRouter,
  startMetricsScheduler,
  stopMetricsScheduler,
  recordRateLimitEvent,
  // Autonomous development (Marveen-inspired continuous dev)
  startAutonomousDevScheduler,
  stopAutonomousDevScheduler,
  createAutonomousDevRouter,
  getAutonomousDevStatus,
  // Root monitoring (hourly quality checks)
  startRootMonitorScheduler,
  stopRootMonitorScheduler,
  createRootMonitorRouter,
  getRootMonitorStatus,
  // Idea scanning (UI prototype to planning ideas)
  startIdeaScanScheduler,
  stopIdeaScanScheduler,
  createIdeaScanRouter,
  getIdeaScanStatus,
  // Hourly digest (autonomous dev summary)
  startHourlyDigestScheduler,
  stopHourlyDigestScheduler,
  getHourlyDigestStatus,
  // Phase coordination (project status -> conductor notification)
  startPhaseCoordinator,
  stopPhaseCoordinator,
  createPhaseCoordinatorRouter,
  getPhaseCoordinatorStatus,
  // Event bus for real-time streaming
  pipelineEvents,
  type PipelineEvent,
} from './pipeline';

const app = express();
const PORT = parseInt(process.env.PORT || '3456', 10);

// ─── Event Emitter for SSE ───────────────────────────────────────────────────

export const mailboxEvents = new EventEmitter();
mailboxEvents.setMaxListeners(100); // Support many subscribers

interface MailboxEventData {
  terminal: string;
  type: 'new_message' | 'message_sent' | 'done_submitted';
  messageId: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

// SSE clients per terminal
const sseClients: Map<string, Set<Response>> = new Map();

// CORS for browser clients
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());
app.use(rateLimit);

// ─── MCP Protocol ─────────────────────────────────────────────────────────────

app.use('/mcp', mcpRouter);

// ─── Telegram Bot Webhook ─────────────────────────────────────────────────────

app.use('/api/telegram', createTelegramRouter());

// ─── System Metrics API ─────────────────────────────────────────────────────

app.use('/api/metrics', createMetricsRouter());

// ─── Autonomous Development API (Marveen-inspired) ──────────────────────────

app.use('/api/autonomous', createAutonomousDevRouter());

// ─── Root Monitor API (hourly quality checks) ───────────────────────────────

app.use('/api/monitor', createRootMonitorRouter());

// ─── Idea Scan API (UI prototype to planning ideas) ─────────────────────────

app.use('/api/ideas', createIdeaScanRouter());

// ─── Graph API (ADR-041 Phase 1) ────────────────────────────────────────────

app.use('/api/graph', graphRoutes);

// ─── Planning Focus API ──────────────────────────────────────────────────────

app.use('/api/planning', createPlanningRouter());

// --- Phase Coordinator API (project status -> conductor notification) --------

app.use('/api/phase', createPhaseCoordinatorRouter());

// ─── Task Audit API (Phase 2 - Task Creation) ───────────────────────────────

import { createTask, queryCreationLog, getDailySummary } from './task-audit/taskCreation';
import { verifyToken } from './task-audit/auth';
import { generateAndPublishDailyReport } from './task-audit/dailyReport';

// Dispatch Control imports
import {
  initDispatchDb,
  closeDispatchDb,
  getDispatchMode,
  setDispatchMode,
  recordTokenUsage,
  getTerminalBudgetStatus,
  getDailyBudgetSummary,
  canDispatch,
  setTerminalBudget,
  getAllBudgetConfigs,
  queueDispatch,
  getDispatchQueue,
  markDispatchExecuting,
  markDispatchCompleted,
  getUsageStats,
  // Proposal system
  setProposalDb,
  createProposal,
  getPendingProposals,
  getProposal,
  decideProposal,
  approveAllPending,
  expireOldProposals,
  getProposalStats,
  notifyNewProposal,
  // Scheduled windows
  setWindowsDb,
  addWindow,
  removeWindow,
  getWindows,
  setDefaultMode,
  getDefaultMode,
  getCurrentWindow,
  checkWindowForTerminal,
  registerWindowSession,
  endWindowSession,
  getAllActiveSessions,
  loadDefaultWindows,
  getWindowStats,
} from './dispatch-control';

// POST /api/task/create - Create a new task
app.post('/api/task/create', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer '

  try {
    const result = await createTask(token, req.body);
    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('[Task API] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/task/audit - Query creation audit log
app.get('/api/task/audit', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const entries = await queryCreationLog({
      created_by: req.query.created_by as string | undefined,
      assigned_to: req.query.assigned_to as string | undefined,
      date: req.query.date as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    });
    res.json({ entries, total: entries.length });
  } catch (error) {
    console.error('[Task API] Audit query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/task/daily-summary - Get daily task summary
app.get('/api/task/daily-summary', async (req: Request, res: Response) => {
  // No auth required for summary (read-only aggregate data)
  try {
    const date = req.query.date as string | undefined;
    const summary = await getDailySummary(date);
    res.json(summary);
  } catch (error) {
    console.error('[Task API] Summary error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/task/daily-report - Generate and publish daily report
app.post('/api/task/daily-report', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const date = req.body.date as string | undefined;
    const { report, markdownPath } = await generateAndPublishDailyReport(date);
    res.json({
      success: true,
      report,
      markdownPath,
    });
  } catch (error) {
    console.error('[Task API] Daily report error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Dispatch Control API (Phase 2 - Token Budget) ───────────────────────────

// GET /api/control/mode - Get current dispatch mode
app.get('/api/control/mode', (_req: Request, res: Response) => {
  try {
    const mode = getDispatchMode();
    res.json({ mode });
  } catch (error) {
    console.error('[Control API] Mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/mode - Set dispatch mode
app.post('/api/control/mode', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const { mode } = req.body;
    if (!['auto', 'manual', 'scheduled'].includes(mode)) {
      res.status(400).json({ error: 'Invalid mode. Must be: auto, manual, or scheduled' });
      return;
    }

    const previousMode = getDispatchMode();
    setDispatchMode(mode, authResult.holder || 'api');

    res.json({
      success: true,
      mode,
      previousMode,
      updatedBy: authResult.holder,
    });
  } catch (error) {
    console.error('[Control API] Set mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/control/budget - Get daily budget summary
app.get('/api/control/budget', (_req: Request, res: Response) => {
  try {
    const summary = getDailyBudgetSummary();
    res.json(summary);
  } catch (error) {
    console.error('[Control API] Budget error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/control/budget/:terminal - Get terminal budget status
app.get('/api/control/budget/:terminal', (req: Request, res: Response) => {
  try {
    const terminal = String(req.params.terminal);
    const status = getTerminalBudgetStatus(terminal);
    res.json(status);
  } catch (error) {
    console.error('[Control API] Terminal budget error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/budget/:terminal - Set terminal budget
app.post('/api/control/budget/:terminal', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const terminal = String(req.params.terminal);
    const { dailyLimit, priorityReserve } = req.body;

    if (typeof dailyLimit !== 'number' || dailyLimit < 0) {
      res.status(400).json({ error: 'dailyLimit must be a positive number' });
      return;
    }

    setTerminalBudget(terminal, dailyLimit, priorityReserve || 0);
    const status = getTerminalBudgetStatus(terminal);

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error('[Control API] Set budget error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/usage - Record token usage
app.post('/api/control/usage', express.json(), async (req: Request, res: Response) => {
  try {
    const { terminal, sessionId, taskId, tokensUsed, model } = req.body;

    if (!terminal || typeof tokensUsed !== 'number') {
      res.status(400).json({ error: 'terminal and tokensUsed are required' });
      return;
    }

    recordTokenUsage({ terminal, sessionId, taskId, tokensUsed, model });
    const status = getTerminalBudgetStatus(terminal);

    res.json({
      success: true,
      recorded: tokensUsed,
      budgetStatus: status,
    });
  } catch (error) {
    console.error('[Control API] Usage error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/control/usage - Get usage statistics
app.get('/api/control/usage', (req: Request, res: Response) => {
  try {
    const terminal = req.query.terminal as string | undefined;
    const stats = getUsageStats(terminal);
    res.json(stats);
  } catch (error) {
    console.error('[Control API] Usage stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/control/can-dispatch - Check if dispatch is allowed
app.get('/api/control/can-dispatch', (req: Request, res: Response) => {
  try {
    const terminal = req.query.terminal as string;
    const estimatedTokens = parseInt(req.query.estimatedTokens as string) || 5000;
    const priority = (req.query.priority as string) || 'medium';

    if (!terminal) {
      res.status(400).json({ error: 'terminal query param required' });
      return;
    }

    const check = canDispatch(terminal, estimatedTokens, priority);
    res.json(check);
  } catch (error) {
    console.error('[Control API] Can dispatch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/control/queue - Get dispatch queue
app.get('/api/control/queue', (_req: Request, res: Response) => {
  try {
    const queue = getDispatchQueue();
    res.json({
      count: queue.length,
      queue,
    });
  } catch (error) {
    console.error('[Control API] Queue error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/queue - Add to dispatch queue
app.post('/api/control/queue', express.json(), async (req: Request, res: Response) => {
  try {
    const { messageId, terminal, priority, estimatedTokens } = req.body;

    if (!messageId || !terminal) {
      res.status(400).json({ error: 'messageId and terminal are required' });
      return;
    }

    queueDispatch(messageId, terminal, priority || 'medium', estimatedTokens || 5000);

    res.json({
      success: true,
      queued: messageId,
      terminal,
      priority: priority || 'medium',
    });
  } catch (error) {
    console.error('[Control API] Queue add error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/dispatch - Manual dispatch (start session)
app.post('/api/control/dispatch', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const { terminal, messageId, estimatedTokens, priority } = req.body;

    if (!terminal) {
      res.status(400).json({ error: 'terminal is required' });
      return;
    }

    // Check budget (even in manual mode, we track)
    const check = canDispatch(terminal, estimatedTokens || 5000, priority || 'medium');

    // In manual mode, we allow dispatch but warn about budget
    const mode = getDispatchMode();
    const budgetWarning = !check.allowed && mode === 'manual'
      ? `Warning: ${check.reason}`
      : undefined;

    // Queue the dispatch
    if (messageId) {
      queueDispatch(messageId, terminal, priority || 'medium', estimatedTokens || 5000);
      markDispatchExecuting(messageId, `manual-${Date.now()}`);
    }

    // Start session via existing session manager
    const sessionResult = await startSession({
      terminal,
      model: 'sonnet',
      prompt: messageId ? `Process inbox message: ${messageId}` : undefined,
      fromTerminal: authResult.holder || 'api',
    });

    if (messageId && sessionResult.success) {
      markDispatchCompleted(messageId, estimatedTokens);
    }

    const budgetStatus = getTerminalBudgetStatus(terminal);

    res.json({
      success: sessionResult.success,
      terminal,
      messageId,
      sessionResult,
      budgetStatus,
      budgetWarning,
    });
  } catch (error) {
    console.error('[Control API] Dispatch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/emergency-stop - Stop all autonomous processes
app.post('/api/control/emergency-stop', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    // Set mode to manual
    const previousMode = getDispatchMode();
    setDispatchMode('manual', authResult.holder || 'emergency');

    // Stop all schedulers
    stopNightwatchScheduler();
    stopHeartbeatScheduler();
    stopAutoRestartScheduler();
    stopAutonomousDevScheduler();
    stopRootMonitorScheduler();
    stopIdeaScanScheduler();
    stopPhaseCoordinator();
    stopMessageRouter();
    stopChannelCoordinator();

    res.json({
      success: true,
      message: 'Emergency stop executed',
      previousMode,
      currentMode: 'manual',
      stoppedSchedulers: [
        'nightwatch',
        'heartbeat',
        'autoRestart',
        'autonomousDev',
        'rootMonitor',
        'ideaScan',
        'phaseCoordinator',
        'messageRouter',
        'channelCoordinator',
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Control API] Emergency stop error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Dispatch Proposals API (Conductor Orchestration) ────────────────────────

// GET /api/control/proposals - Get pending proposals
app.get('/api/control/proposals', (_req: Request, res: Response) => {
  try {
    const proposals = getPendingProposals();
    const stats = getProposalStats();
    res.json({
      proposals,
      stats,
    });
  } catch (error) {
    console.error('[Control API] Proposals error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/control/proposals/:id - Get specific proposal
app.get('/api/control/proposals/:id', (req: Request, res: Response) => {
  try {
    const proposalId = String(req.params.id);
    const proposal = getProposal(proposalId);
    if (!proposal) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }
    res.json(proposal);
  } catch (error) {
    console.error('[Control API] Proposal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/proposals - Create new proposal (Conductor)
app.post('/api/control/proposals', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const { terminal, taskId, reason, estimatedTokens } = req.body;

    if (!terminal || !taskId) {
      res.status(400).json({ error: 'terminal and taskId are required' });
      return;
    }

    const proposal = createProposal({
      terminal,
      taskId,
      reason: reason || 'UNREAD inbox detected',
      estimatedTokens: estimatedTokens || 5000,
      proposedBy: authResult.holder || 'api',
    });

    // Notify via Telegram
    await notifyNewProposal(proposal);

    res.status(201).json({
      success: true,
      proposal,
    });
  } catch (error) {
    console.error('[Control API] Create proposal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/proposals/:id/approve - Approve proposal (Root)
app.post('/api/control/proposals/:id/approve', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const proposalId = String(req.params.id);
    const result = await decideProposal({
      proposalId,
      approved: true,
      decidedBy: authResult.holder || 'api',
    });

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json(result);
  } catch (error) {
    console.error('[Control API] Approve proposal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/proposals/:id/reject - Reject proposal (Root)
app.post('/api/control/proposals/:id/reject', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const proposalId = String(req.params.id);
    const result = await decideProposal({
      proposalId,
      approved: false,
      decidedBy: authResult.holder || 'api',
      reason: req.body.reason,
    });

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json(result);
  } catch (error) {
    console.error('[Control API] Reject proposal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/proposals/approve-all - Bulk approve all pending (Root)
app.post('/api/control/proposals/approve-all', express.json(), async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return;
  }

  try {
    const result = approveAllPending(authResult.holder || 'api');
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[Control API] Approve all error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/proposals/expire - Expire old proposals
app.post('/api/control/proposals/expire', express.json(), async (req: Request, res: Response) => {
  try {
    const maxAgeHours = req.body.maxAgeHours || 24;
    const expired = expireOldProposals(maxAgeHours);
    res.json({
      success: true,
      expired,
    });
  } catch (error) {
    console.error('[Control API] Expire proposals error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Scheduled Windows API ───────────────────────────────────────────────────

// GET /api/control/windows - Get all configured windows
app.get('/api/control/windows', (_req: Request, res: Response) => {
  try {
    const windows = getWindows();
    const stats = getWindowStats();
    const currentWindow = getCurrentWindow();
    const defaultMode = getDefaultMode();

    res.json({
      windows,
      stats,
      currentWindow: currentWindow?.name || null,
      defaultMode,
    });
  } catch (error) {
    console.error('[Control API] Windows error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/windows - Add a new window
app.post('/api/control/windows', express.json(), (req: Request, res: Response) => {
  try {
    const { name, days, startTime, endTime, allowedTerminals, maxSessions } = req.body;

    if (!name || !days || !startTime || !endTime || !allowedTerminals) {
      res.status(400).json({ error: 'Missing required fields: name, days, startTime, endTime, allowedTerminals' });
      return;
    }

    addWindow({
      name,
      days,
      startTime,
      endTime,
      allowedTerminals,
      maxSessions: maxSessions || 3,
    });

    res.json({ success: true, message: `Window "${name}" added` });
  } catch (error) {
    console.error('[Control API] Add window error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/control/windows/:name - Remove a window
app.delete('/api/control/windows/:name', (req: Request, res: Response) => {
  try {
    const name = String(req.params.name);
    const removed = removeWindow(name);

    if (!removed) {
      res.status(404).json({ error: 'Window not found' });
      return;
    }

    res.json({ success: true, message: `Window "${name}" removed` });
  } catch (error) {
    console.error('[Control API] Remove window error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/control/windows/check/:terminal - Check if terminal can dispatch now
app.get('/api/control/windows/check/:terminal', (req: Request, res: Response) => {
  try {
    const terminal = String(req.params.terminal);
    const check = checkWindowForTerminal(terminal);

    res.json(check);
  } catch (error) {
    console.error('[Control API] Window check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/windows/session/start - Register session in window
app.post('/api/control/windows/session/start', express.json(), (req: Request, res: Response) => {
  try {
    const { terminal, windowName, sessionId } = req.body;

    if (!terminal || !windowName) {
      res.status(400).json({ error: 'Missing required fields: terminal, windowName' });
      return;
    }

    registerWindowSession(terminal, windowName, sessionId);
    res.json({ success: true, message: `Session registered for ${terminal} in window "${windowName}"` });
  } catch (error) {
    console.error('[Control API] Register session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/windows/session/end - End session in window
app.post('/api/control/windows/session/end', express.json(), (req: Request, res: Response) => {
  try {
    const { terminal } = req.body;

    if (!terminal) {
      res.status(400).json({ error: 'Missing required field: terminal' });
      return;
    }

    endWindowSession(terminal);
    res.json({ success: true, message: `Session ended for ${terminal}` });
  } catch (error) {
    console.error('[Control API] End session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/control/windows/sessions - Get all active window sessions
app.get('/api/control/windows/sessions', (_req: Request, res: Response) => {
  try {
    const sessions = getAllActiveSessions();
    res.json({ sessions });
  } catch (error) {
    console.error('[Control API] Get sessions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/windows/default-mode - Set default mode outside windows
app.post('/api/control/windows/default-mode', express.json(), (req: Request, res: Response) => {
  try {
    const { mode } = req.body;

    if (!mode || !['auto', 'manual'].includes(mode)) {
      res.status(400).json({ error: 'Invalid mode. Must be "auto" or "manual"' });
      return;
    }

    setDefaultMode(mode);
    res.json({ success: true, defaultMode: mode });
  } catch (error) {
    console.error('[Control API] Set default mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/control/windows/load-defaults - Load default window configuration
app.post('/api/control/windows/load-defaults', (_req: Request, res: Response) => {
  try {
    loadDefaultWindows();
    const windows = getWindows();
    res.json({ success: true, windowsLoaded: windows.length, windows });
  } catch (error) {
    console.error('[Control API] Load defaults error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────

// Service readiness state
let isReady = false;
let isShuttingDown = false;

app.get('/health', async (_req: Request, res: Response) => {
  const count = await getDocumentCount();
  res.json({
    status: isShuttingDown ? 'shutting_down' : 'ok',
    vectorBackend: usingChroma() ? 'chromadb' : 'memory',
    embeddingBackend: embeddingBackend(),
    documents: count,
    knowledgePath: process.env.KNOWLEDGE_BASE_PATH || '(default)',
    port: PORT,
  });
});

// Kubernetes readiness probe
app.get('/ready', async (_req: Request, res: Response) => {
  if (isShuttingDown) {
    res.status(503).json({ ready: false, reason: 'shutting_down' });
    return;
  }

  if (!isReady) {
    res.status(503).json({ ready: false, reason: 'initializing' });
    return;
  }

  try {
    const count = await getDocumentCount();
    if (count === 0) {
      res.status(503).json({ ready: false, reason: 'no_documents' });
      return;
    }
    res.json({ ready: true, documents: count });
  } catch (err) {
    res.status(503).json({ ready: false, reason: 'vector_store_error' });
  }
});

// ─── Search (GET) ─────────────────────────────────────────────────────────────

app.get('/api/knowledge/search', async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const topK = parseInt(String(req.query.topK || '5'), 10);

  if (!q) {
    res.status(400).json({ error: 'q query param required' });
    return;
  }

  try {
    const results = await searchKnowledge(q, topK);
    res.json({ query: q, topK, count: results.length, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Search (POST) ────────────────────────────────────────────────────────────

app.post('/api/knowledge/search', validate(SearchBodySchema), async (req: Request, res: Response) => {
  const { q, topK } = req.body as { q: string; topK: number };

  try {
    const results = await searchKnowledge(q, topK);
    res.json({ query: q, topK, count: results.length, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Re-index ─────────────────────────────────────────────────────────────────

app.post('/api/knowledge/index', async (_req: Request, res: Response) => {
  try {
    const result = await buildIndex();
    const count = await getDocumentCount();
    res.json({ success: true, totalInStore: count, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mailbox: List Inbox ──────────────────────────────────────────────────────

app.get('/api/mailbox/:terminal/inbox', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const statusParam = req.query.status as string | undefined;
  const status = statusParam && ['UNREAD', 'READ', 'all'].includes(statusParam)
    ? statusParam as 'UNREAD' | 'READ' | 'all'
    : undefined;

  try {
    const messages = await listInbox(terminal, status);
    res.json({ terminal, status: status || 'all', count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mailbox: Send Message ────────────────────────────────────────────────────

app.post('/api/mailbox/:terminal/inbox', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const { type, content, priority, ref, model } = req.body;

  if (!type || !content || !priority) {
    res.status(400).json({ error: 'type, content, and priority are required' });
    return;
  }

  try {
    const result = await sendMessage({
      to: terminal,
      type,
      content,
      priority,
      ref,
      model,
    });

    // Emit SSE event to subscribers
    const eventData: MailboxEventData = {
      terminal,
      type: 'new_message',
      messageId: result.id,
      timestamp: new Date().toISOString(),
      details: { type, priority, ref },
    };
    broadcastToTerminal(terminal, 'new_message', eventData);
    mailboxEvents.emit('new_message', eventData);

    res.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mailbox: Submit DONE ─────────────────────────────────────────────────────

app.post('/api/mailbox/:terminal/outbox', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const { task_id, summary, files_changed } = req.body;

  if (!task_id || !summary || !files_changed) {
    res.status(400).json({ error: 'task_id, summary, and files_changed are required' });
    return;
  }

  try {
    const result = await submitDone({
      from: terminal,
      task_id,
      summary,
      files_changed,
    });

    // Emit SSE event to 'root' (DONE messages go to root for review)
    const eventData: MailboxEventData = {
      terminal: 'root',
      type: 'done_submitted',
      messageId: result.id,
      timestamp: new Date().toISOString(),
      details: { from: terminal, task_id, summary },
    };
    broadcastToTerminal('root', 'done_submitted', eventData);
    mailboxEvents.emit('done_submitted', eventData);

    // ADR-046: Hybrid API immediate trigger
    // Fire-and-forget: runs review + pipeline in background
    // File artifact already written, this just triggers immediate processing
    triggerImmediatePipelineAsync(result.path, {
      from: terminal,
      taskId: task_id,
      summary,
    });

    res.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Tasks: Get Status ────────────────────────────────────────────────────────

app.get('/api/tasks/status', async (req: Request, res: Response) => {
  const task_id = req.query.task_id as string | undefined;

  try {
    const tasks = await getTaskStatus(task_id);
    res.json({ count: tasks.length, tasks });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mailbox: List Outbox ────────────────────────────────────────────────────

app.get('/api/mailbox/:terminal/outbox', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const statusParam = req.query.status as string | undefined;
  const status = statusParam && ['UNREAD', 'READ', 'all'].includes(statusParam)
    ? statusParam as 'UNREAD' | 'READ' | 'all'
    : undefined;

  try {
    const messages = await listOutbox(terminal, status);
    res.json({ terminal, status: status || 'all', count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mailbox: List All UNREAD Outbox (Conductor HIGH priority #1) ─────────────

app.get('/api/mailbox/outbox/unread', async (_req: Request, res: Response) => {
  try {
    const results = await listAllUnreadOutbox();
    const totalCount = results.reduce((sum, r) => sum + r.messages.length, 0);
    res.json({
      totalCount,
      terminals: results.length,
      results,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mailbox: Inbox Message Counter (Conductor MEDIUM priority #3) ────────────

app.get('/api/mailbox/counter', async (_req: Request, res: Response) => {
  try {
    const counts = await getInboxMessageCounter();
    const totalUnread = Object.values(counts).reduce((sum, c) => sum + c.unread, 0);
    const totalMessages = Object.values(counts).reduce((sum, c) => sum + c.total, 0);
    res.json({
      totalUnread,
      totalMessages,
      terminals: counts,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mailbox: Mark as READ (Conductor MEDIUM priority #4) ─────────────────────

app.post('/api/mailbox/:terminal/:box/:messageId/read', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const box = String(req.params.box) as 'inbox' | 'outbox';
  const messageId = String(req.params.messageId);

  if (!['inbox', 'outbox'].includes(box)) {
    res.status(400).json({ error: 'box must be "inbox" or "outbox"' });
    return;
  }

  try {
    const success = await markAsRead(terminal, messageId, box);
    if (success) {
      res.json({ success: true, message: `Marked ${messageId} as READ` });
    } else {
      res.status(404).json({ success: false, error: 'Message not found or already READ' });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Terminal: Full Status (Conductor HIGH priority #2) ──────────────────────

app.get('/api/terminal/:terminal/full-status', async (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);

  try {
    const status = await getFullTerminalStatus(terminal);
    res.json(status);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── SSE: Subscribe to Inbox ─────────────────────────────────────────────────

app.get('/api/mailbox/:terminal/subscribe', (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);

  // Validate terminal
  const parsed = TerminalSchema.safeParse(terminal);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid terminal name' });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ terminal, timestamp: new Date().toISOString() })}\n\n`);

  // Add client to subscribers
  if (!sseClients.has(terminal)) {
    sseClients.set(terminal, new Set());
  }
  sseClients.get(terminal)!.add(res);

  // Also subscribe to 'all' for broadcast messages
  if (!sseClients.has('all')) {
    sseClients.set('all', new Set());
  }
  sseClients.get('all')!.add(res);

  console.log(`[SSE] Client subscribed to terminal: ${terminal} (total: ${sseClients.get(terminal)?.size || 0})`);

  // Keep connection alive with heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 30000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(terminal)?.delete(res);
    sseClients.get('all')?.delete(res);
    console.log(`[SSE] Client disconnected from terminal: ${terminal}`);
  });
});

// ─── Broadcast helper ────────────────────────────────────────────────────────

function broadcastToTerminal(terminal: string, event: string, data: MailboxEventData): void {
  const clients = sseClients.get(terminal);
  if (clients) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => {
      try {
        client.write(message);
      } catch {
        // Client disconnected, will be cleaned up
      }
    });
  }
}

// ─── Pipeline Events SSE (Event-driven real-time streaming) ─────────────────

// SSE clients for pipeline events
const pipelineSSEClients = new Set<Response>();

/**
 * SSE endpoint for pipeline events (nightwatch, reviews, alerts, etc.)
 * GET /api/pipeline/events
 *
 * Events:
 * - nightwatch:cycle - Nightwatch completed a cycle
 * - inbox:new - New UNREAD message
 * - outbox:done - DONE message submitted
 * - session:started/ended/stuck/nudged
 * - review:started/approved/rejected
 * - alert:critical/warning
 */
app.get('/api/pipeline/events', (req: Request, res: Response) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

  // Send recent events if client wants to catch up
  const since = req.query.since as string | undefined;
  if (since) {
    const recentEvents = pipelineEvents.getRecentEvents(since, 20);
    for (const event of recentEvents) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  // Add client to subscribers
  pipelineSSEClients.add(res);

  console.log(`[Pipeline SSE] Client connected (total: ${pipelineSSEClients.size})`);

  // Subscribe to all pipeline events
  const eventHandler = (event: PipelineEvent) => {
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Client disconnected
      pipelineSSEClients.delete(res);
    }
  };

  pipelineEvents.onAny(eventHandler);

  // Keep connection alive with heartbeat every 30s
  const heartbeat = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch {
      // Client disconnected
      pipelineSSEClients.delete(res);
      clearInterval(heartbeat);
    }
  }, 30000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    pipelineSSEClients.delete(res);
    pipelineEvents.removeListener('*', eventHandler);
    console.log(`[Pipeline SSE] Client disconnected (remaining: ${pipelineSSEClients.size})`);
  });
});

/**
 * Get pipeline event statistics
 * GET /api/pipeline/stats
 */
app.get('/api/pipeline/stats', (_req: Request, res: Response) => {
  const stats = pipelineEvents.getStats();
  const recentEvents = pipelineEvents.getRecentEvents(undefined, 10);
  res.json({
    eventCounts: stats,
    recentEvents,
    connectedClients: pipelineSSEClients.size,
  });
});

// ─── Broadcast endpoint ──────────────────────────────────────────────────────

app.post('/api/mailbox/broadcast', (req: Request, res: Response) => {
  const { message, priority = 'info' } = req.body;

  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const eventData: MailboxEventData = {
    terminal: 'all',
    type: 'new_message',
    messageId: `BROADCAST-${Date.now()}`,
    timestamp: new Date().toISOString(),
    details: { message, priority },
  };

  broadcastToTerminal('all', 'broadcast', eventData);

  res.json({ success: true, sentTo: sseClients.get('all')?.size || 0 });
});

// ─── Error handler ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

// ─── Terminal Status API ─────────────────────────────────────────────────────

app.post('/api/terminal/:terminal/status', (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const { state, taskId } = req.body as { state?: 'working' | 'idle'; taskId?: string };

  if (state === 'working') {
    registerWorking(terminal, taskId);
    res.json({ success: true, terminal, state: 'working', taskId });
  } else if (state === 'idle') {
    registerIdle(terminal);
    res.json({ success: true, terminal, state: 'idle' });
  } else {
    // Heartbeat if no state specified
    heartbeat(terminal);
    res.json({ success: true, terminal, action: 'heartbeat' });
  }
});

app.get('/api/terminal/:terminal/status', (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const status = getStatus(terminal);
  res.json({ terminal, status: status || { state: 'idle', lastActivity: null } });
});

app.get('/api/terminals/status', (_req: Request, res: Response) => {
  res.json({ terminals: getAllStatus() });
});

// ─── Session Management API (MCP) ───────────────────────────────────────────

/**
 * POST /api/session/start
 * Start a terminal session with Claude
 * Body: { terminal: string, model?: 'haiku'|'sonnet'|'opus', prompt?: string, fromTerminal?: string }
 */
app.post('/api/session/start', express.json(), async (req: Request, res: Response) => {
  try {
    const { terminal, model, prompt, fromTerminal } = req.body;

    if (!terminal || typeof terminal !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "terminal" field' });
    }

    const result = await startSession({ terminal, model, prompt, fromTerminal });
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: `Failed to start session: ${error}` });
  }
});

/**
 * POST /api/session/inject
 * Inject prompt into running Claude session
 * Body: { terminal: string, prompt: string, fromTerminal?: string }
 */
app.post('/api/session/inject', express.json(), async (req: Request, res: Response) => {
  try {
    const { terminal, prompt, fromTerminal } = req.body;

    if (!terminal || typeof terminal !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "terminal" field' });
    }
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "prompt" field' });
    }

    const result = await injectPrompt({ terminal, prompt, fromTerminal });
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: `Failed to inject prompt: ${error}` });
  }
});

/**
 * POST /api/session/wake
 * Wake up a terminal - start session if needed and inject inbox read prompt
 * Body: { terminal: string, fromTerminal?: string }
 */
app.post('/api/session/wake', express.json(), async (req: Request, res: Response) => {
  try {
    const { terminal, fromTerminal } = req.body;

    if (!terminal || typeof terminal !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "terminal" field' });
    }

    const result = await wakeUpTerminal(terminal, fromTerminal);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: `Failed to wake terminal: ${error}` });
  }
});

/**
 * GET /api/session/:terminal
 * Get session status for a terminal
 */
app.get('/api/session/:terminal', (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const status = getSessionStatus(terminal);
  res.json(status);
});

/**
 * GET /api/session/all
 * Get all sessions status
 */
app.get('/api/sessions/all', (_req: Request, res: Response) => {
  const sessions = getAllSessionsStatus();
  res.json({ sessions });
});

/**
 * GET /api/session/logs
 * Get session audit logs (last N days)
 */
app.get('/api/sessions/logs', (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 1;
  const logs = getSessionLogs(days);
  res.json({ count: logs.length, logs });
});

// ─── Memory Tier Management API (ADR-046 Track D) ────────────────────────────

/**
 * GET /api/memories/tiered?terminal=<terminal>&tiers=hot,warm&limit=10
 * Query memories by tier
 */
app.get('/api/memories/tiered', async (req: Request, res: Response) => {
  try {
    const terminal = String(req.query.terminal || '');
    const tiersParam = String(req.query.tiers || 'hot,warm');
    const limit = parseInt(req.query.limit as string) || 20;

    if (!terminal) {
      return res.status(400).json({ error: 'Missing "terminal" parameter' });
    }

    const { queryByTier } = await import('./pipeline/memoryStore');
    const tiers = tiersParam.split(',').map(t => t.trim()) as Array<'hot' | 'warm' | 'cold' | 'shared'>;
    const memories = queryByTier(terminal, tiers, limit);

    res.json({
      terminal,
      tiers,
      count: memories.length,
      memories: memories.map(m => ({
        id: m.id,
        tier: m.tier,
        type: m.type,
        content: m.content.substring(0, 200) + (m.content.length > 200 ? '...' : ''),
        salience: m.salience,
        createdAt: m.createdAt,
        accessedAt: m.accessedAt,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/memories/save
 * Save a tiered memory
 * Body: { tier, type, source, content, terminal?, context?, salience? }
 */
app.post('/api/memories/save', express.json(), async (req: Request, res: Response) => {
  try {
    const { tier, type, source, content, terminal, context, salience } = req.body;

    if (!tier || !type || !source || !content) {
      return res.status(400).json({
        error: 'Missing required fields: tier, type, source, content',
      });
    }

    const { saveTieredMemory } = await import('./pipeline/memoryStore');
    const memory = await saveTieredMemory({
      tier,
      type,
      source,
      content,
      terminal,
      context,
      salience,
    });

    res.json({
      success: true,
      memory: {
        id: memory.id,
        tier: memory.tier,
        type: memory.type,
        salience: memory.salience,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/memories/:id/promote
 * Promote a memory to higher tier
 * Body: { newTier, reason }
 */
app.post('/api/memories/:id/promote', express.json(), async (req: Request, res: Response) => {
  try {
    const memoryId = parseInt(String(req.params.id));
    const { newTier, reason } = req.body;

    if (!newTier || !reason) {
      return res.status(400).json({
        error: 'Missing required fields: newTier, reason',
      });
    }

    const { promoteMemory } = await import('./pipeline/memoryStore');
    await promoteMemory(memoryId, newTier, reason);

    res.json({
      success: true,
      memoryId,
      newTier,
      reason,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Session Lifecycle API (ADR-046 Track D) ────────────────────────────────

/**
 * POST /api/session/start-context
 * Get cold start context for a terminal
 * Body: { terminal, taskId? }
 */
app.post('/api/session/start-context', express.json(), async (req: Request, res: Response) => {
  try {
    const { terminal, taskId } = req.body;

    if (!terminal) {
      return res.status(400).json({ error: 'Missing "terminal" field' });
    }

    const { buildStartContext } = await import('./sessionHooks');
    const context = await buildStartContext({
      terminal,
      taskId,
      inboxMessageId: taskId,
    });

    res.json({
      terminal,
      taskId,
      memoriesLoaded: context.memoriesLoaded,
      hotMemories: context.hotMemories.length,
      warmMemories: context.warmMemories.length,
      sharedMemories: context.sharedMemories.length,
      contextTokens: context.contextTokens,
      contextMarkdown: context.contextMarkdown,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/session/end
 * Handle session end and save session history
 * Body: { terminal, endReason, taskId?, summary?, hadCorrections?, toolCallCount? }
 */
app.post('/api/session/end', express.json(), async (req: Request, res: Response) => {
  try {
    const { terminal, endReason, taskId, summary, hadCorrections, toolCallCount } = req.body;

    if (!terminal || !endReason) {
      return res.status(400).json({
        error: 'Missing required fields: terminal, endReason',
      });
    }

    const { handleSessionEnd } = await import('./sessionHooks');
    const result = await handleSessionEnd({
      terminal,
      endReason,
      taskId,
      summary,
      hadCorrections,
      toolCallCount,
    });

    res.json({
      success: true,
      sessionId: result.sessionId,
      memoriesSaved: result.memoriesSaved,
      retrospectiveTriggered: result.retrospectiveTriggered,
      handoffGenerated: result.handoffGenerated,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /api/session/history?terminal=<terminal>&limit=10
 * Get session history for a terminal
 */
app.get('/api/session/history', async (req: Request, res: Response) => {
  try {
    const terminal = req.query.terminal as string | undefined;
    const limit = parseInt(req.query.limit as string) || 10;

    const Database = (await import('better-sqlite3')).default;
    const dbPath = process.env.MEMORY_DATA_DIR || path.join(projectRoot, 'spaceos-nexus/knowledge-service/data');
    const db = new Database(path.join(dbPath, 'memory.db'));
    db.pragma('journal_mode = WAL');

    let sessions;
    if (terminal) {
      const stmt = db.prepare(`
        SELECT * FROM session_history
        WHERE terminal = ?
        ORDER BY started_at DESC
        LIMIT ?
      `);
      sessions = stmt.all(terminal, limit);
    } else {
      const stmt = db.prepare(`
        SELECT * FROM session_history
        ORDER BY started_at DESC
        LIMIT ?
      `);
      sessions = stmt.all(limit);
    }

    db.close();

    res.json({
      terminal: terminal || 'all',
      count: sessions.length,
      sessions,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Daily Digest API (ADR-046 Track D) ─────────────────────────────────────

/**
 * POST /api/digest/generate
 * Generate daily digest for a terminal
 * Body: { terminal, date? }
 */
app.post('/api/digest/generate', express.json(), async (req: Request, res: Response) => {
  try {
    const { terminal, date } = req.body;

    if (!terminal) {
      return res.status(400).json({ error: 'Missing "terminal" field' });
    }

    const digestDate = date || new Date().toISOString().split('T')[0];
    const { generateDailyDigest } = await import('./digest');
    const result = await generateDailyDigest({ terminal, date: digestDate });

    res.json({
      success: true,
      digest: {
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
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /api/digest/:terminal/:date
 * Get daily digest for a terminal and date (YYYY-MM-DD)
 */
app.get('/api/digest/:terminal/:date', async (req: Request, res: Response) => {
  try {
    const terminal = String(req.params.terminal);
    const date = String(req.params.date);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        error: 'Invalid date format - must be YYYY-MM-DD',
      });
    }

    const { generateDailyDigest } = await import('./digest');
    const result = await generateDailyDigest({ terminal, date });

    res.json({
      terminal: result.terminal,
      date: result.date,
      sessionCount: result.sessionCount,
      memoriesCreated: result.memoriesCreated,
      toolCallsTotal: result.toolCallsTotal,
      tasksCompleted: result.tasksCompleted,
      tasksBlocked: result.tasksBlocked,
      summary: result.summary,
      digestMarkdown: result.digestMarkdown,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Auth API (for React Dashboard) ──────────────────────────────────────────

// Simple auth token (no database, just static token from env)
const DASHBOARD_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || 'dev-token-spaceos-dashboard-2026';

// Support both GET and POST for auth verification
const verifyAuthToken = (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (token === DASHBOARD_TOKEN) {
    res.json({ valid: true, message: 'Token is valid' });
  } else {
    res.status(401).json({ valid: false, message: 'Invalid token' });
  }
};

app.get('/api/auth/verify', verifyAuthToken);
app.post('/api/auth/verify', verifyAuthToken);

// ─── Terminal Status API ─────────────────────────────────────────────────────

app.post('/api/terminal/status', express.json(), async (req: Request, res: Response) => {
  try {
    const { terminal, status, currentTask } = req.body;

    if (!terminal || typeof terminal !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "terminal" field' });
    }

    if (!status || (status !== 'working' && status !== 'idle')) {
      return res.status(400).json({ error: 'Invalid "status" field - must be "working" or "idle"' });
    }

    if (status === 'working') {
      registerWorking(terminal, currentTask || 'Working');
      res.json({
        success: true,
        message: `Terminal "${terminal}" registered as WORKING`,
        currentTask: currentTask || 'Working'
      });
    } else {
      registerIdle(terminal);
      res.json({
        success: true,
        message: `Terminal "${terminal}" registered as IDLE`
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Dashboard API ───────────────────────────────────────────────────────────

app.get('/api/dashboard', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = process.env.SPACEOS_ROOT || '/opt/spaceos';
    // New 7-terminal architecture (2026-06-21)
    const terminalsRoot = path.join(projectRoot, 'terminals');

    // Get all terminals status - new role-based architecture
    const terminals: any[] = [];
    const terminalNames = [
      'root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer'
    ];

    for (const terminal of terminalNames) {
      const inboxDir = path.join(terminalsRoot, terminal, 'inbox');
      const outboxDir = path.join(terminalsRoot, terminal, 'outbox');

      let inboxCount = 0;
      let outboxCount = 0;
      let unreadInbox = 0;
      let unreadOutbox = 0;

      try {
        const inboxFiles = await fs.readdir(inboxDir);
        inboxCount = inboxFiles.filter(f => f.endsWith('.md')).length;
        for (const file of inboxFiles.filter(f => f.endsWith('.md'))) {
          const content = await fs.readFile(path.join(inboxDir, file), 'utf-8');
          if (content.includes('status: UNREAD')) unreadInbox++;
        }
      } catch (err) { /* dir may not exist */ }

      try {
        const outboxFiles = await fs.readdir(outboxDir);
        outboxCount = outboxFiles.filter(f => f.endsWith('.md')).length;
        for (const file of outboxFiles.filter(f => f.endsWith('.md'))) {
          const content = await fs.readFile(path.join(outboxDir, file), 'utf-8');
          if (content.includes('status: UNREAD')) unreadOutbox++;
        }
      } catch (err) { /* dir may not exist */ }

      const status = getStatus(terminal);

      terminals.push({
        name: terminal,
        inbox: inboxCount,
        outbox: outboxCount,
        unreadInbox,
        unreadOutbox,
        status: status?.state || 'idle',
        lastActivity: status?.lastActivity || null,
      });
    }

    // Global metrics
    const totalInbox = terminals.reduce((sum, t) => sum + t.inbox, 0);
    const totalOutbox = terminals.reduce((sum, t) => sum + t.outbox, 0);
    const totalUnread = terminals.reduce((sum, t) => sum + t.unreadInbox + t.unreadOutbox, 0);
    const activeSessions = terminals.filter(t => t.status === 'working').length;

    res.json({
      timestamp: new Date().toISOString(),
      metrics: {
        totalInbox,
        totalOutbox,
        totalUnread,
        activeSessions,
        terminals: terminals.length,
      },
      terminals,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Message Registry API ────────────────────────────────────────────────────

/**
 * Query messages from registry
 * GET /api/registry/messages?terminal=backend&status=UNREAD&type=task&limit=50
 */
app.get('/api/registry/messages', async (req: Request, res: Response) => {
  try {
    const query: MessageQuery = {};

    if (req.query.terminal) query.terminal = req.query.terminal as string;
    if (req.query.box) query.box = req.query.box as 'inbox' | 'outbox';
    if (req.query.status) query.status = req.query.status as string as any;
    if (req.query.type) query.type = req.query.type as string as any;
    if (req.query.priority) query.priority = req.query.priority as string as any;
    if (req.query.fromTerminal) query.fromTerminal = req.query.fromTerminal as string;
    if (req.query.toTerminal) query.toTerminal = req.query.toTerminal as string;
    if (req.query.since) query.since = req.query.since as string;
    if (req.query.limit) query.limit = parseInt(req.query.limit as string, 10);
    if (req.query.offset) query.offset = parseInt(req.query.offset as string, 10);
    if (req.query.orderBy) query.orderBy = req.query.orderBy as 'createdAt' | 'detectedAt' | 'priority';
    if (req.query.orderDir) query.orderDir = req.query.orderDir as 'ASC' | 'DESC';

    const messages = queryMessages(query);
    res.json({ count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Get single message by ID
 * GET /api/registry/messages/:messageId
 */
app.get('/api/registry/messages/:messageId', async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const message = getMessage(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(message);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Get UNREAD messages for a terminal
 * GET /api/registry/unread/:terminal
 */
app.get('/api/registry/unread/:terminal', async (req: Request, res: Response) => {
  try {
    const terminal = String(req.params.terminal);
    const box = req.query.box as 'inbox' | 'outbox' | undefined;
    const messages = getUnreadMessages(terminal, box);
    res.json({ count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Get registry statistics
 * GET /api/registry/stats
 */
app.get('/api/registry/stats', async (_req: Request, res: Response) => {
  try {
    const stats = registryGetMessageStats();
    res.json(stats);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Verify message integrity (hash check)
 * GET /api/registry/verify/:messageId
 */
app.get('/api/registry/verify/:messageId', async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const result = await verifyMessageHash(messageId);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Verify all messages (tampering report)
 * GET /api/registry/verify-all
 */
app.get('/api/registry/verify-all', async (_req: Request, res: Response) => {
  try {
    const result = await verifyAllMessages();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Get status history for a message
 * GET /api/registry/history/:messageId
 */
app.get('/api/registry/history/:messageId', async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const history = getStatusHistory(messageId);
    res.json({ messageId, history });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Mark message as READ
 * POST /api/registry/mark-read/:messageId
 */
app.post('/api/registry/mark-read/:messageId', async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const changedBy = req.body?.changedBy || 'api';
    const result = await registryMarkAsRead(messageId, changedBy);
    if (!result) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * Mark message as PROCESSED
 * POST /api/registry/mark-processed/:messageId
 */
app.post('/api/registry/mark-processed/:messageId', async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const changedBy = req.body?.changedBy || 'api';
    const result = await markAsProcessed(messageId, changedBy);
    if (!result) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Kanban API ──────────────────────────────────────────────────────────────

app.get('/api/kanban/snapshot', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = process.env.SPACEOS_ROOT || '/opt/spaceos';
    const planningRoot = path.join(projectRoot, 'docs/planning');
    const mailboxRoot = path.join(projectRoot, 'docs/mailbox');

    // Helper function to parse planning items
    const parsePlanningItem = async (filePath: string, stage: string) => {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        let title = path.basename(filePath, '.md');
        let priority = 'medium';

        // Parse YAML frontmatter
        if (lines[0] === '---') {
          for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') break;
            if (lines[i].startsWith('title:')) {
              title = lines[i].replace('title:', '').trim().replace(/^["']|["']$/g, '');
            }
            if (lines[i].startsWith('priority:')) {
              priority = lines[i].replace('priority:', '').trim();
            }
          }
        }

        // Fallback: look for first H1
        if (title === path.basename(filePath, '.md')) {
          const h1 = lines.find(l => l.startsWith('# '));
          if (h1) title = h1.replace('# ', '').trim();
        }

        const stat = await fs.stat(filePath);
        return {
          id: path.basename(filePath),
          title,
          status: stage,
          priority,
          createdAt: stat.birthtime.toISOString(),
        };
      } catch (err) {
        return null;
      }
    };

    // Discovery Track
    const discovery: {
      ideas: any[];
      selected: any[];
      debate: any[];
      consensus: any[];
      queue: any[];
      totals: { ideas: number; selected: number; debate: number; consensus: number; queue: number };
    } = {
      ideas: [],
      selected: [],
      debate: [],
      consensus: [],
      queue: [],
      totals: { ideas: 0, selected: 0, debate: 0, consensus: 0, queue: 0 },
    };

    // Load all discovery stages
    const stages = ['ideas', 'selected', 'debate', 'consensus', 'queue'] as const;
    for (const stage of stages) {
      try {
        const stageDir = path.join(planningRoot, stage === 'debate' ? 'consensus' : stage);
        const files = await fs.readdir(stageDir);
        const mdFiles = files.filter(f => f.endsWith('.md') && !f.includes('archive'));

        // For debate, filter files that contain "debate" in name or status
        const items = [];
        for (const file of mdFiles.slice(0, 10)) { // Limit to 10 per stage
          const item = await parsePlanningItem(path.join(stageDir, file), stage);
          if (item) items.push(item);
        }

        discovery[stage] = items;
        discovery.totals[stage] = mdFiles.length;
      } catch (err) { /* dir may not exist */ }
    }

    // Helper to parse mailbox message
    const parseMailboxMessage = async (filePath: string) => {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        let title = path.basename(filePath, '.md');
        let status = 'UNREAD';
        let priority = 'medium';
        let from = '';
        let type = 'task';

        // Parse YAML frontmatter
        if (lines[0] === '---') {
          for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') break;
            if (lines[i].startsWith('title:')) {
              title = lines[i].replace('title:', '').trim().replace(/^["']|["']$/g, '');
            }
            if (lines[i].startsWith('status:')) {
              status = lines[i].replace('status:', '').trim();
            }
            if (lines[i].startsWith('priority:')) {
              priority = lines[i].replace('priority:', '').trim();
            }
            if (lines[i].startsWith('from:')) {
              from = lines[i].replace('from:', '').trim();
            }
            if (lines[i].startsWith('type:')) {
              type = lines[i].replace('type:', '').trim();
            }
          }
        }

        // Fallback: look for first H1
        if (title === path.basename(filePath, '.md')) {
          const h1 = lines.find(l => l.startsWith('# '));
          if (h1) title = h1.replace('# ', '').trim();
        }

        const stat = await fs.stat(filePath);
        return {
          id: path.basename(filePath),
          title,
          status,
          priority,
          from,
          type,
          createdAt: stat.birthtime.toISOString(),
        };
      } catch (err) {
        return null;
      }
    };

    // Delivery Track
    const terminals = [
      'kernel', 'orch', 'fe', 'joinery', 'cutting', 'identity',
      'infra', 'e2e', 'architect', 'librarian', 'nexus', 'conductor'
    ];

    const swimlanes: any[] = [];

    for (const terminal of terminals) {
      const inboxDir = path.join(mailboxRoot, terminal, 'inbox');
      const outboxDir = path.join(mailboxRoot, terminal, 'outbox');

      let inboxCount = 0;
      let doneCount = 0;
      const inboxMessages: any[] = [];
      const doneMessages: any[] = [];

      try {
        const inboxFiles = await fs.readdir(inboxDir);
        const mdFiles = inboxFiles.filter(f => f.endsWith('.md')).sort().reverse();
        inboxCount = mdFiles.length;

        // Parse first 5 inbox messages
        for (const file of mdFiles.slice(0, 5)) {
          const msg = await parseMailboxMessage(path.join(inboxDir, file));
          if (msg) inboxMessages.push(msg);
        }
      } catch (err) { /* dir may not exist */ }

      try {
        const outboxFiles = await fs.readdir(outboxDir);
        const mdFiles = outboxFiles.filter(f => f.endsWith('.md')).sort().reverse();
        doneCount = mdFiles.length;

        // Parse first 5 done messages
        for (const file of mdFiles.slice(0, 5)) {
          const msg = await parseMailboxMessage(path.join(outboxDir, file));
          if (msg) doneMessages.push(msg);
        }
      } catch (err) { /* dir may not exist */ }

      const status = getStatus(terminal);

      swimlanes.push({
        terminal,
        sessionActive: status?.state === 'working',
        totals: { inbox: inboxCount, working: 0, review: 0, done: doneCount },
        columns: {
          inbox: inboxMessages,
          active: [],
          review: [],
          done: doneMessages,
        },
      });
    }

    const delivery = {
      swimlanes,
      activeSessions: swimlanes.filter(s => s.sessionActive).map(s => s.terminal),
      totals: {
        inbox: swimlanes.reduce((sum, s) => sum + s.totals.inbox, 0),
        working: swimlanes.reduce((sum, s) => sum + s.totals.working, 0),
        review: swimlanes.reduce((sum, s) => sum + s.totals.review, 0),
        done: swimlanes.reduce((sum, s) => sum + s.totals.done, 0),
      },
    };

    res.json({ discovery, delivery });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/kanban/metrics', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = process.env.SPACEOS_ROOT || '/opt/spaceos';
    const planningRoot = path.join(projectRoot, 'docs/planning');

    let discoveryWip = 0;
    let deliveryWip = 0;

    try {
      const ideaFiles = await fs.readdir(path.join(planningRoot, 'ideas'));
      discoveryWip += ideaFiles.filter(f => f.endsWith('.md')).length;
    } catch (err) { /* ignore */ }

    try {
      const queueFiles = await fs.readdir(path.join(planningRoot, 'queue'));
      discoveryWip += queueFiles.filter(f => f.endsWith('.md')).length;
    } catch (err) { /* ignore */ }

    const allStatus = getAllStatus();
    const activeSessions = Object.values(allStatus).filter((s: any) => s.state === 'working').length;

    res.json({
      discoveryWip,
      deliveryWip,
      activeSessions,
      throughput: 0,
      cycleTime: 0,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Planning Pipeline API ───────────────────────────────────────────────────

app.get('/api/planning/items', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = process.env.SPACEOS_ROOT || '/opt/spaceos';
    const ideasDir = path.join(projectRoot, 'docs/planning/ideas');
    const selectedDir = path.join(projectRoot, 'docs/planning/selected');
    const queueDir = path.join(projectRoot, 'docs/planning/queue');

    // Read all planning items
    const items: any[] = [];

    // Ideas
    try {
      const ideaFiles = await fs.readdir(ideasDir);
      for (const file of ideaFiles.filter(f => f.endsWith('.md'))) {
        const content = await fs.readFile(path.join(ideasDir, file), 'utf-8');
        const match = content.match(/^#\s+(.+)$/m);
        items.push({
          id: file,
          title: match ? match[1] : file,
          status: 'idea',
          priority: 'medium',
          createdAt: (await fs.stat(path.join(ideasDir, file))).mtime.toISOString(),
        });
      }
    } catch (err) { /* dir may not exist */ }

    // Queue
    try {
      const queueFiles = await fs.readdir(queueDir);
      for (const file of queueFiles.filter(f => f.endsWith('.md'))) {
        const content = await fs.readFile(path.join(queueDir, file), 'utf-8');
        const match = content.match(/^#\s+(.+)$/m);
        items.push({
          id: file,
          title: match ? match[1] : file,
          status: 'queue',
          priority: 'high',
          createdAt: (await fs.stat(path.join(queueDir, file))).mtime.toISOString(),
        });
      }
    } catch (err) { /* dir may not exist */ }

    // Metrics
    const metrics = {
      ideas: items.filter(i => i.status === 'idea').length,
      selected: 0,
      inDebate: 0,
      consensus: 0,
      queued: items.filter(i => i.status === 'queue').length,
      lastScan: new Date().toISOString(),
    };

    res.json({ items, metrics });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Projects API ────────────────────────────────────────────────────────────

app.get('/api/projects', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = process.env.SPACEOS_ROOT || '/opt/spaceos';
    const tasksDir = path.join(projectRoot, 'docs/tasks');

    // Read active tasks
    const projects: any[] = [];
    const milestones: any[] = [];

    try {
      const activeFiles = await fs.readdir(path.join(tasksDir, 'active'));
      for (const file of activeFiles.filter(f => f.endsWith('.md'))) {
        const content = await fs.readFile(path.join(tasksDir, 'active', file), 'utf-8');
        const match = content.match(/^#\s+(.+)$/m);
        const title = match ? match[1] : file;

        projects.push({
          id: file,
          name: title,
          status: 'active',
          priority: 'high',
          startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          progress: Math.floor(Math.random() * 80),
          terminal: 'nexus',
          epic: 'NEXUS-001',
          tasks: 10,
          completedTasks: Math.floor(Math.random() * 8),
        });
      }
    } catch (err) { /* dir may not exist */ }

    // Add a demo milestone
    milestones.push({
      id: 'milestone-1',
      name: 'Nexus Phase 6 Complete',
      date: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'upcoming',
    });

    res.json({ projects, milestones });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Inter-Agent Messaging API ────────────────────────────────────────────────

// Send inter-agent message
app.post('/api/agent-messages', async (req: Request, res: Response) => {
  try {
    const { from, to, content, type, priority, ref } = req.body;

    if (!from || !to || !content) {
      return res.status(400).json({ error: 'from, to, and content are required' });
    }

    const message = createAgentMessage({ from, to, content, type, priority, ref });
    res.json({ success: true, message });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get all pending messages
app.get('/api/agent-messages/pending', async (_req: Request, res: Response) => {
  try {
    const messages = getPendingMessages();
    res.json({ count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get pending messages for a specific terminal
app.get('/api/agent-messages/pending/:terminal', async (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const messages = getPendingMessages(terminal);
    res.json({ count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get recent messages
app.get('/api/agent-messages/recent', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const messages = getRecentMessages(limit);
    res.json({ count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get message statistics
app.get('/api/agent-messages/stats', async (_req: Request, res: Response) => {
  try {
    const stats = getMessageStats();
    res.json(stats);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get channel coordinator state
app.get('/api/channel-coordinator/state', async (_req: Request, res: Response) => {
  try {
    const state = getCoordinatorState();
    res.json(state);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Multi-Channel Notification API ──────────────────────────────────────────

// Get multi-channel status
app.get('/api/channels/status', async (_req: Request, res: Response) => {
  try {
    const status = getMultiChannelStatus();
    res.json(status);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Validate all channel tokens
app.get('/api/channels/validate', async (_req: Request, res: Response) => {
  try {
    const results = await validateAllTokens();
    res.json(results);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Send notification to all enabled channels
app.post('/api/channels/notify', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    const results = await notifyAllChannels(message);
    res.json({ results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Send notification to a specific channel
app.post('/api/channels/:channel/notify', async (req: Request, res: Response) => {
  try {
    const channel = req.params.channel as ChannelProviderType;
    const { message } = req.body;

    if (!['telegram', 'slack', 'discord'].includes(channel)) {
      return res.status(400).json({ error: 'Invalid channel type' });
    }
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const result = await notifyChannel(channel, message);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Inbox Watcher SSE Bridge ────────────────────────────────────────────────

function setupInboxWatcherBridge(): void {
  inboxEvents.on('inbox_change', async (event: InboxEvent) => {
    // Check if terminal should be woken up (not already working)
    if (!shouldWakeUp(event.terminal)) {
      console.log(`[InboxWatcher] ${event.terminal} is WORKING — not sending wake-up for ${event.messageId}`);
      return;
    }

    // Broadcast to the specific terminal
    const eventData: MailboxEventData = {
      terminal: event.terminal,
      type: 'new_message',
      messageId: event.messageId,
      timestamp: event.timestamp,
      details: {
        priority: event.priority,
        messageType: event.messageType,
        filePath: event.filePath,
        source: 'file_watcher',
      },
    };

    broadcastToTerminal(event.terminal, 'wake_up', eventData);
    mailboxEvents.emit('new_message', eventData);

    console.log(`[SSE] Wake-up sent to ${event.terminal} for ${event.messageId}`);

    // Start the terminal session directly (no external daemon needed)
    try {
      const result = await startTerminalSession(event.terminal, event.messageId);
      if (result.success) {
        console.log(`[SessionStarter] ${result.message}`);
      } else {
        console.log(`[SessionStarter] Skip: ${result.message}`);
      }
    } catch (err) {
      console.error(`[SessionStarter] Error starting ${event.terminal}:`, err);
    }
  });
}

// ─── React Frontend Serving ──────────────────────────────────────────────────

// Serve React build (Datahaven Dashboard)
const reactBuildPath = path.join(projectRoot, 'datahaven-web/client/dist');
app.use(express.static(reactBuildPath));

// SPA fallback - serve index.html for all non-API routes
app.use((req: Request, res: Response) => {
  // Skip if already responded (static files)
  if (res.headersSent) {
    return;
  }

  // 404 for API routes
  if (req.path.startsWith('/api') || req.path.startsWith('/mcp') || req.path === '/health' || req.path === '/ready') {
    return res.status(404).json({ error: 'Not found' });
  }

  // Serve React app for all other routes
  res.sendFile(path.join(reactBuildPath, 'index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  await initVectorStore();

  const count = await getDocumentCount();
  if (count === 0) {
    console.log('📚 Store empty — running initial knowledge base indexing...');
    await buildIndex();
  } else {
    console.log(
      `📚 Store has ${count} documents. POST /api/knowledge/index to re-index.`
    );
  }

  // Initialize message registry (sync with filesystem)
  await initializeRegistry();

  // Start inbox file watcher
  startInboxWatcher();
  setupInboxWatcherBridge();

  // Log existing UNREAD messages on startup
  const existingUnread = await scanExistingUnread();
  if (existingUnread.length > 0) {
    console.log(`\n📬 Found ${existingUnread.length} existing UNREAD messages:`);
    for (const msg of existingUnread) {
      console.log(`   - ${msg.terminal}: ${msg.messageId} (${msg.priority || 'normal'})`);
    }
  }

  const server = app.listen(PORT, () => {
    isReady = true;
    console.log(`\n🚀 SpaceOS Knowledge Service on port ${PORT}`);
    console.log(`   GET  /health`);
    console.log(`   GET  /ready`);
    console.log(`\n   Knowledge Service:`);
    console.log(`   GET  /api/knowledge/search?q=...&topK=5`);
    console.log(`   POST /api/knowledge/search   { q, topK? }`);
    console.log(`   POST /api/knowledge/index    (re-index)`);
    console.log(`\n   Mailbox Tools:`);
    console.log(`   GET  /api/mailbox/:terminal/inbox?status=UNREAD|READ|all`);
    console.log(`   POST /api/mailbox/:terminal/inbox   (send_message)`);
    console.log(`   POST /api/mailbox/:terminal/outbox  (submit_done)`);
    console.log(`\n   Tasks:`);
    console.log(`   GET  /api/tasks/status?task_id=...`);
    console.log(`\n   Live Notifications:`);
    console.log(`   GET  /api/mailbox/:terminal/subscribe  (SSE wake-on-inbox)`);
    console.log(`\n   MCP Protocol (Claude Code):`);
    console.log(`   GET  /mcp              (server info)`);
    console.log(`   POST /mcp              (JSON-RPC: initialize, tools/list, tools/call)\n`);

    // Start Nightwatch scheduler if enabled (replaces bash cron)
    if (process.env.ENABLE_NIGHTWATCH === 'true') {
      const intervalMs = parseInt(process.env.NIGHTWATCH_INTERVAL || '120000', 10);
      startNightwatchScheduler(intervalMs);
      console.log(`   ⏰ Nightwatch Scheduler: ENABLED (every ${intervalMs / 1000}s)`);
    } else {
      console.log(`   ⏰ Nightwatch Scheduler: DISABLED (set ENABLE_NIGHTWATCH=true to enable)`);
    }

    // Start Heartbeat scheduler if enabled (Marveen-inspired)
    if (process.env.ENABLE_HEARTBEAT === 'true') {
      const heartbeatConfig = getHeartbeatConfig();
      startHeartbeatScheduler(heartbeatConfig);
      console.log(`   💓 Heartbeat Scheduler: ENABLED (every ${heartbeatConfig.intervalMs / 60000}min)`);
    } else {
      console.log(`   💓 Heartbeat Scheduler: DISABLED (set ENABLE_HEARTBEAT=true to enable)`);
    }

    // Start Auto-Restart scheduler if enabled (Marveen-inspired "nightly dream")
    if (process.env.ENABLE_AUTO_RESTART === 'true') {
      const autoRestartConfig = getAutoRestartConfig();
      startAutoRestartScheduler(autoRestartConfig);
      const scheduleDesc = autoRestartConfig.schedule.type === 'daily'
        ? `daily at ${autoRestartConfig.schedule.hour}:${String((autoRestartConfig.schedule as any).minute ?? 0).padStart(2, '0')}`
        : `every ${(autoRestartConfig.schedule as any).hours}h`;
      console.log(`   🔄 Auto-Restart: ENABLED (${scheduleDesc})`);
    } else {
      console.log(`   🔄 Auto-Restart: DISABLED (set ENABLE_AUTO_RESTART=true to enable)`);
    }

    // Initialize inter-agent messaging
    initMessageDb();
    console.log(`   📨 Agent Messages: Database initialized`);

    // Initialize dispatch control database (shared by all dispatch modules)
    const dispatchDb = initDispatchDb();
    setProposalDb(dispatchDb);
    setWindowsDb(dispatchDb);
    const dispatchMode = getDispatchMode();
    console.log(`   🎛️ Dispatch Control: ${dispatchMode.toUpperCase()} mode`);
    const windowStats = getWindowStats();
    console.log(`   🕐 Scheduled Windows: ${windowStats.totalWindows} configured, current: ${windowStats.currentWindow || 'none'}`);

    // Start message router if enabled
    if (process.env.ENABLE_MESSAGE_ROUTER === 'true') {
      const routerIntervalMs = parseInt(process.env.MESSAGE_ROUTER_INTERVAL || '10000', 10);
      startMessageRouter(routerIntervalMs);
      console.log(`   📬 Message Router: ENABLED (every ${routerIntervalMs / 1000}s)`);
    } else {
      console.log(`   📬 Message Router: DISABLED (set ENABLE_MESSAGE_ROUTER=true to enable)`);
    }

    // Start channel coordinator if enabled
    if (process.env.ENABLE_TELEGRAM_COORDINATOR === 'true') {
      startChannelCoordinator();
      console.log(`   📡 Telegram Coordinator: ENABLED (hybrid backfill mode)`);
    } else {
      console.log(`   📡 Telegram Coordinator: DISABLED (set ENABLE_TELEGRAM_COORDINATOR=true to enable)`);
    }

    // Start system metrics collection (always enabled, 1 min interval)
    const metricsIntervalMs = parseInt(process.env.METRICS_INTERVAL || '60000', 10);
    startMetricsScheduler(metricsIntervalMs);
    console.log(`   📊 System Metrics: ENABLED (every ${metricsIntervalMs / 1000}s)`);

    // Start Autonomous Development scheduler if enabled (Marveen-inspired continuous dev)
    if (process.env.ENABLE_AUTONOMOUS_DEV === 'true') {
      startAutonomousDevScheduler();
      const status = getAutonomousDevStatus();
      console.log(`   🤖 Autonomous Dev: ENABLED (every ${30}min)`);
      console.log(`      📄 Focus file: ${status.config.focusFile}`);
      console.log(`      🔄 Cold start: ${status.config.coldStart}`);
    } else {
      console.log(`   🤖 Autonomous Dev: DISABLED (set ENABLE_AUTONOMOUS_DEV=true to enable)`);
    }

    // Start Root Monitor scheduler if enabled (hourly quality checks)
    if (process.env.ENABLE_ROOT_MONITOR === 'true') {
      startRootMonitorScheduler();
      const status = getRootMonitorStatus();
      console.log(`   👁️ Root Monitor: ENABLED (every ${30}min)`);
    } else {
      console.log(`   👁️ Root Monitor: DISABLED (set ENABLE_ROOT_MONITOR=true to enable)`);
    }

    // Start Idea Scan scheduler if enabled (UI prototype to planning ideas)
    if (process.env.ENABLE_IDEA_SCAN === 'true') {
      startIdeaScanScheduler();
      const status = getIdeaScanStatus();
      console.log(`   💡 Idea Scan: ENABLED (every ${30}min)`);
      console.log(`      📁 Project: ${status.config.projectPath}`);
    } else {
      console.log(`   💡 Idea Scan: DISABLED (set ENABLE_IDEA_SCAN=true to enable)`);
    }
    // Start Hourly Digest scheduler if enabled
    if (process.env.ENABLE_HOURLY_DIGEST !== 'false') {
      startHourlyDigestScheduler();
      const status = getHourlyDigestStatus();
      const nextRun = status.nextRun ? status.nextRun.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }) : 'N/A';
      console.log(`   📊 Hourly Digest: ENABLED (next: ${nextRun})`);
    } else {
      console.log(`   📊 Hourly Digest: DISABLED (set ENABLE_HOURLY_DIGEST=true to enable)`);
    }

    // Start Phase Coordinator scheduler if enabled (project status -> conductor notification)
    if (process.env.ENABLE_PHASE_COORDINATOR === 'true') {
      startPhaseCoordinator();
      const phaseStatus = getPhaseCoordinatorStatus();
      console.log('   Phase Coordinator: ENABLED (every ' + phaseStatus.config.intervalMinutes + 'min)');
    } else {
      // console.log('   Phase Coordinator: DISABLED (set ENABLE_PHASE_COORDINATOR=true to enable)');
    }

    // Initialize multi-channel notifications
    initMultiChannel();
    const channelStatus = getMultiChannelStatus();
    const enabledChannels = Object.entries(channelStatus)
      .filter(([_, s]) => s.enabled)
      .map(([c]) => c);
    if (enabledChannels.length > 0) {
      console.log(`   📢 Multi-Channel: ${enabledChannels.join(', ')}`);
    } else {
      console.log(`   📢 Multi-Channel: No channels configured`);
    }

    // Set up Telegram webhook if configured (async in background)
    const telegramWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    (async () => {
      if (telegramWebhookUrl) {
        const webhookSuccess = await setTelegramWebhook(telegramWebhookUrl);
        console.log(`   🤖 Telegram Bot: Webhook ${webhookSuccess ? 'configured' : 'FAILED'} → ${telegramWebhookUrl}`);
      } else {
        const webhookInfo = await getWebhookInfo();
        if (webhookInfo?.url) {
          console.log(`   🤖 Telegram Bot: Webhook active → ${webhookInfo.url}`);
        } else {
          console.log(`   🤖 Telegram Bot: No webhook (set TELEGRAM_WEBHOOK_URL to enable)`);
        }
      }
    })();
    console.log('');
  });

  // Graceful shutdown (P2)
  const gracefulShutdown = (signal: string) => {
    console.log(`\n⏳ ${signal} received, shutting down gracefully...`);
    isShuttingDown = true;
    stopHourlyDigestScheduler();
    isReady = false;

    // Stop all schedulers and services
    stopNightwatchScheduler();
    stopHeartbeatScheduler();
    stopAutoRestartScheduler();
    stopAutonomousDevScheduler();
    stopRootMonitorScheduler();
    stopIdeaScanScheduler();
    stopPhaseCoordinator();
    stopMessageRouter();
    stopChannelCoordinator();
    // stopMetricsScheduler();
    closeMessageDb();
    closeDispatchDb();

    // Stop accepting new connections
    server.close(() => {
      console.log('✅ HTTP server closed');

      // Close all SSE connections
      for (const [terminal, clients] of sseClients) {
        for (const client of clients) {
          client.end();
        }
        clients.clear();
      }
      console.log('✅ SSE connections closed');

      console.log('👋 Goodbye!');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('⚠️ Forced exit after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
