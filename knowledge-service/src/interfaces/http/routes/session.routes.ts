/**
 * Session Management Routes
 * Terminal sessions, inject, wake, status
 */

import { Router, Request, Response } from 'express';
import {
  startSession,
  injectPrompt,
  wakeUpTerminal,
  getSessionStatus,
  getAllSessionsStatus,
  getSessionLogs,
  stopSession,
  stopAllSessions,
} from '../../../sessionManager';

const router = Router();

// ─── Start Session ───────────────────────────────────────────────────────────

router.post('/start', async (req: Request, res: Response) => {
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

// ─── Inject Prompt ───────────────────────────────────────────────────────────

router.post('/inject', async (req: Request, res: Response) => {
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

// ─── Wake Terminal ───────────────────────────────────────────────────────────

router.post('/wake', async (req: Request, res: Response) => {
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

// ─── Get Session Status ──────────────────────────────────────────────────────

router.get('/:terminal', (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const status = getSessionStatus(terminal);
  res.json(status);
});

// ─── Get All Sessions ────────────────────────────────────────────────────────

router.get('/', (_req: Request, res: Response) => {
  const status = getAllSessionsStatus();
  res.json(status);
});

// ─── Session Logs ────────────────────────────────────────────────────────────

router.get('/logs', (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 1;
  const logs = getSessionLogs(days);
  res.json(logs);
});

// ─── Stop Session ─────────────────────────────────────────────────────────────

router.post('/stop', async (req: Request, res: Response) => {
  try {
    const { terminal, fromTerminal, graceful, reason, summary } = req.body;

    if (!terminal || typeof terminal !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "terminal" field' });
    }

    const result = await stopSession({
      terminal,
      fromTerminal,
      graceful: graceful !== false, // Default to true
      reason: reason || 'manual',
      summary,
    });

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: `Failed to stop session: ${error}` });
  }
});

// ─── Stop All Sessions ────────────────────────────────────────────────────────

router.post('/stop-all', async (req: Request, res: Response) => {
  try {
    const { fromTerminal, excludePriority, graceful } = req.body;

    const result = await stopAllSessions({
      fromTerminal,
      excludePriority: excludePriority !== false, // Default to true
      graceful: graceful !== false, // Default to true
    });

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    res.status(500).json({ error: `Failed to stop all sessions: ${error}` });
  }
});

export default router;
