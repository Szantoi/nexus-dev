/**
 * Mailbox Routes
 * Inbox, outbox, SSE subscriptions, broadcast
 */

import { Router, Request, Response } from 'express';
import { EventEmitter } from 'events';
import {
  listInbox,
  listOutbox,
  listAllUnreadOutbox,
  getInboxMessageCounter,
  markAsRead,
  sendMessage,
  submitDone,
  getTaskStatus,
} from '../../../mailbox';
import { validate, TerminalParamSchema, TerminalSchema } from '../../../validation';
import { triggerImmediatePipelineAsync } from '../../../pipeline/immediatePipeline';

const router = Router();

// ─── Event Emitter for SSE ───────────────────────────────────────────────────

export const mailboxEvents = new EventEmitter();
mailboxEvents.setMaxListeners(100);

interface MailboxEventData {
  terminal: string;
  type: 'new_message' | 'message_sent' | 'done_submitted';
  messageId: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

// SSE clients per terminal
const sseClients: Map<string, Set<Response>> = new Map();

// Export for graceful shutdown
export function closeAllSSEConnections(): void {
  for (const [terminal, clients] of sseClients) {
    for (const client of clients) {
      client.end();
    }
    clients.clear();
  }
}

export function getSSEClientCount(terminal?: string): number {
  if (terminal) {
    return sseClients.get(terminal)?.size || 0;
  }
  let total = 0;
  for (const clients of sseClients.values()) {
    total += clients.size;
  }
  return total;
}

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

// ─── List Inbox ──────────────────────────────────────────────────────────────

router.get('/:terminal/inbox', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
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

// ─── Send Message ────────────────────────────────────────────────────────────

router.post('/:terminal/inbox', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
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

// ─── Submit DONE ─────────────────────────────────────────────────────────────

router.post('/:terminal/outbox', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
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

// ─── List Outbox ─────────────────────────────────────────────────────────────

router.get('/:terminal/outbox', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
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

// ─── List All UNREAD Outbox ──────────────────────────────────────────────────

router.get('/outbox/unread', async (_req: Request, res: Response) => {
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

// ─── Inbox Message Counter ───────────────────────────────────────────────────

router.get('/counter', async (_req: Request, res: Response) => {
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

// ─── Mark as READ ────────────────────────────────────────────────────────────

router.post('/:terminal/:box/:messageId/read', validate(TerminalParamSchema, 'params'), async (req: Request, res: Response) => {
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

// ─── SSE: Subscribe to Inbox ─────────────────────────────────────────────────

router.get('/:terminal/subscribe', (req: Request, res: Response) => {
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

// ─── Broadcast ───────────────────────────────────────────────────────────────

router.post('/broadcast', (req: Request, res: Response) => {
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

// ─── Tasks Status (legacy endpoint under mailbox) ────────────────────────────

router.get('/tasks/status', async (req: Request, res: Response) => {
  const task_id = req.query.task_id as string | undefined;

  try {
    const tasks = await getTaskStatus(task_id);
    res.json({ count: tasks.length, tasks });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
