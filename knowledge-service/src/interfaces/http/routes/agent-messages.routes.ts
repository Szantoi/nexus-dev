/**
 * Agent Messages Routes
 * Inter-agent messaging
 */

import { Router, Request, Response } from 'express';
import {
  createAgentMessage,
  getPendingMessages,
  getRecentMessages,
  getMessageStats,
  getCoordinatorState,
} from '../../../pipeline';

const router = Router();

// ─── Send Message ────────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
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

// ─── Get All Pending ─────────────────────────────────────────────────────────

router.get('/pending', async (_req: Request, res: Response) => {
  try {
    const messages = getPendingMessages();
    res.json({ count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Get Pending for Terminal ────────────────────────────────────────────────

router.get('/pending/:terminal', async (req: Request, res: Response) => {
  try {
    const terminal = req.params.terminal as string;
    const messages = getPendingMessages(terminal);
    res.json({ count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Get Recent ──────────────────────────────────────────────────────────────

router.get('/recent', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const messages = getRecentMessages(limit);
    res.json({ count: messages.length, messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Statistics ──────────────────────────────────────────────────────────────

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = getMessageStats();
    res.json(stats);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Coordinator State ───────────────────────────────────────────────────────

router.get('/coordinator/state', async (_req: Request, res: Response) => {
  try {
    const state = getCoordinatorState();
    res.json(state);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
