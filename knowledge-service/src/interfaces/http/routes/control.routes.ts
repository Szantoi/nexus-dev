/**
 * Dispatch Control Routes
 * Budget management, proposals, scheduled windows, emergency controls
 */

import { Router, Request, Response } from 'express';
import { verifyToken } from '../../../task-audit/auth';
import {
  getDispatchMode,
  setDispatchMode,
  recordTokenUsage,
  getTerminalBudgetStatus,
  getDailyBudgetSummary,
  canDispatch,
  setTerminalBudget,
  queueDispatch,
  getDispatchQueue,
  markDispatchExecuting,
  markDispatchCompleted,
  getUsageStats,
  // Proposal system
  createProposal,
  getPendingProposals,
  getProposal,
  decideProposal,
  approveAllPending,
  expireOldProposals,
  getProposalStats,
  notifyNewProposal,
  // Scheduled windows
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
} from '../../../dispatch-control';
import { startSession } from '../../../sessionManager';
import {
  stopNightwatchScheduler,
  stopHeartbeatScheduler,
  stopAutoRestartScheduler,
  stopAutonomousDevScheduler,
  stopRootMonitorScheduler,
  stopIdeaScanScheduler,
  stopPhaseCoordinator,
  stopMessageRouter,
  stopChannelCoordinator,
} from '../../../pipeline';

const router = Router();

// ─── Auth Helper ─────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response): { authenticated: true; holder: string } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return null;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return null;
  }

  return { authenticated: true, holder: authResult.holder || 'api' };
}

// ─── Mode Endpoints ──────────────────────────────────────────────────────────

router.get('/mode', (_req: Request, res: Response) => {
  try {
    const mode = getDispatchMode();
    res.json({ mode });
  } catch (error) {
    console.error('[Control API] Mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/mode', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  try {
    const { mode } = req.body;
    if (!['auto', 'manual', 'scheduled'].includes(mode)) {
      res.status(400).json({ error: 'Invalid mode. Must be: auto, manual, or scheduled' });
      return;
    }

    const previousMode = getDispatchMode();
    setDispatchMode(mode, auth.holder);

    res.json({
      success: true,
      mode,
      previousMode,
      updatedBy: auth.holder,
    });
  } catch (error) {
    console.error('[Control API] Set mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Budget Endpoints ────────────────────────────────────────────────────────

router.get('/budget', (_req: Request, res: Response) => {
  try {
    const summary = getDailyBudgetSummary();
    res.json(summary);
  } catch (error) {
    console.error('[Control API] Budget error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/budget/:terminal', (req: Request, res: Response) => {
  try {
    const terminal = String(req.params.terminal);
    const status = getTerminalBudgetStatus(terminal);
    res.json(status);
  } catch (error) {
    console.error('[Control API] Terminal budget error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/budget/:terminal', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

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

// ─── Usage Endpoints ─────────────────────────────────────────────────────────

router.post('/usage', async (req: Request, res: Response) => {
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

router.get('/usage', (req: Request, res: Response) => {
  try {
    const terminal = req.query.terminal as string | undefined;
    const stats = getUsageStats(terminal);
    res.json(stats);
  } catch (error) {
    console.error('[Control API] Usage stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Dispatch Check & Queue ──────────────────────────────────────────────────

router.get('/can-dispatch', (req: Request, res: Response) => {
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

router.get('/queue', (_req: Request, res: Response) => {
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

router.post('/queue', async (req: Request, res: Response) => {
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

// ─── Manual Dispatch ─────────────────────────────────────────────────────────

router.post('/dispatch', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

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
      fromTerminal: auth.holder,
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

// ─── Emergency Stop ──────────────────────────────────────────────────────────

router.post('/emergency-stop', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  try {
    // Set mode to manual
    const previousMode = getDispatchMode();
    setDispatchMode('manual', auth.holder);

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

// ─── Proposals Endpoints ─────────────────────────────────────────────────────

router.get('/proposals', (_req: Request, res: Response) => {
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

router.get('/proposals/:id', (req: Request, res: Response) => {
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

router.post('/proposals', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

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
      proposedBy: auth.holder,
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

router.post('/proposals/:id/approve', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  try {
    const proposalId = String(req.params.id);
    const result = await decideProposal({
      proposalId,
      approved: true,
      decidedBy: auth.holder,
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

router.post('/proposals/:id/reject', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  try {
    const proposalId = String(req.params.id);
    const result = await decideProposal({
      proposalId,
      approved: false,
      decidedBy: auth.holder,
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

router.post('/proposals/approve-all', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  try {
    const result = approveAllPending(auth.holder);
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[Control API] Approve all error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/proposals/expire', async (req: Request, res: Response) => {
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

// ─── Scheduled Windows Endpoints ─────────────────────────────────────────────

router.get('/windows', (_req: Request, res: Response) => {
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

router.post('/windows', (req: Request, res: Response) => {
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

router.delete('/windows/:name', (req: Request, res: Response) => {
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

router.get('/windows/check/:terminal', (req: Request, res: Response) => {
  try {
    const terminal = String(req.params.terminal);
    const check = checkWindowForTerminal(terminal);

    res.json(check);
  } catch (error) {
    console.error('[Control API] Window check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/windows/session/start', (req: Request, res: Response) => {
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

router.post('/windows/session/end', (req: Request, res: Response) => {
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

router.get('/windows/sessions', (_req: Request, res: Response) => {
  try {
    const sessions = getAllActiveSessions();
    res.json({ sessions });
  } catch (error) {
    console.error('[Control API] Get sessions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/windows/default-mode', (req: Request, res: Response) => {
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

router.post('/windows/load-defaults', (_req: Request, res: Response) => {
  try {
    loadDefaultWindows();
    const windows = getWindows();
    res.json({ success: true, windowsLoaded: windows.length, windows });
  } catch (error) {
    console.error('[Control API] Load defaults error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
