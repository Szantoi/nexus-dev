/**
 * Message Registry Routes
 * Query, verify, status history for messages
 */

import { Router, Request, Response } from 'express';
import {
  queryMessages,
  getUnreadMessages,
  getMessage,
  getMessageStats,
  verifyMessageHash,
  verifyAllMessages,
  getStatusHistory,
  markAsRead,
  markAsProcessed,
  type MessageQuery,
} from '../../../messageRegistry';

const router = Router();

// ─── Query Messages ──────────────────────────────────────────────────────────

router.get('/messages', async (req: Request, res: Response) => {
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

// ─── Get Single Message ──────────────────────────────────────────────────────

router.get('/messages/:messageId', async (req: Request, res: Response) => {
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

// ─── Get UNREAD Messages ─────────────────────────────────────────────────────

router.get('/unread/:terminal', async (req: Request, res: Response) => {
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

// ─── Registry Statistics ─────────────────────────────────────────────────────

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = getMessageStats();
    res.json(stats);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Verify Message Hash ─────────────────────────────────────────────────────

router.get('/verify/:messageId', async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const result = await verifyMessageHash(messageId);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Verify All Messages ─────────────────────────────────────────────────────

router.get('/verify-all', async (_req: Request, res: Response) => {
  try {
    const result = await verifyAllMessages();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Status History ──────────────────────────────────────────────────────────

router.get('/history/:messageId', async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const history = getStatusHistory(messageId);
    res.json({ messageId, history });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mark as READ ────────────────────────────────────────────────────────────

router.post('/mark-read/:messageId', async (req: Request, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const changedBy = req.body?.changedBy || 'api';
    const result = await markAsRead(messageId, changedBy);
    if (!result) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Mark as PROCESSED ───────────────────────────────────────────────────────

router.post('/mark-processed/:messageId', async (req: Request, res: Response) => {
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

export default router;
