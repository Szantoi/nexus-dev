/**
 * Federation API routes (ADR-066 reference, increment 2).
 *
 * Unified cross-island HTTP endpoints, exposed on EVERY island's knowledge-service:
 *   POST /api/federation/send         — queue a cross-island message
 *   GET  /api/federation/inbox        — token-optimized metadata list (no bodies)
 *   GET  /api/federation/message/:id  — full message content, on demand
 *   POST /api/federation/ack          — acknowledge delivery (unread → read)
 *
 * DB-driven (canonical task-message-box store, single source of truth), token-auth
 * per island (reuses the MCP Bearer auth), token-optimized (inbox returns metadata
 * only). No file parsing anywhere on this path.
 */
import { Router, Request, Response } from 'express';
import { authenticateRest } from '../../../mcp';
import {
  sendFederationMessage,
  getFederationInbox,
  getMessage,
  updateMessageStatus,
  getStatusHistory,
} from '../../../task-message-box/store';
import { MessageStatus } from '../../../task-message-box/types';
import { isCanonicalStatus } from '../../../task-message-box/message-model';

export function createFederationApiRouter(): Router {
  const router = Router();

  // Island-to-island auth: valid Bearer token maps to an agent identity.
  router.use(authenticateRest);

  // POST /api/federation/send
  router.post('/send', async (req: Request, res: Response): Promise<void> => {
    const b = req.body || {};
    if (!b.from_island || !b.to_island || !b.to_terminal || !b.subject || !b.body) {
      res.status(400).json({ error: 'Missing required fields: from_island, to_island, to_terminal, subject, body' });
      return;
    }
    const result = await sendFederationMessage({
      from_island: b.from_island,
      from_terminal: b.from_terminal || 'root',
      to_island: b.to_island,
      to_terminal: b.to_terminal,
      type: b.type || 'info',
      priority: b.priority || 'medium',
      subject: b.subject,
      body: b.body,
      ref_id: b.ref_id,
    });
    if (!result.success) { res.status(500).json({ error: result.error }); return; }
    res.json({ success: true, id: result.id });
  });

  // GET /api/federation/inbox?island=X&status=unread   (metadata only)
  router.get('/inbox', async (req: Request, res: Response): Promise<void> => {
    const island = req.query.island as string | undefined;
    if (!island) { res.status(400).json({ error: 'island query param required' }); return; }
    const status = (req.query.status as MessageStatus | 'all') || 'unread';
    const result = await getFederationInbox(island, status);
    if (!result.success) { res.status(500).json({ error: result.error }); return; }
    res.json({ success: true, count: result.count, messages: result.data });
  });

  // GET /api/federation/message/:id   (full content — fetch only when needed)
  router.get('/message/:id', async (req: Request, res: Response): Promise<void> => {
    const msg = await getMessage(String(req.params.id));
    if (!msg) { res.status(404).json({ error: 'message not found' }); return; }
    res.json({ success: true, message: msg });
  });

  // POST /api/federation/ack   { id }   (delivery ack: unread → read)
  router.post('/ack', async (req: Request, res: Response): Promise<void> => {
    const id = (req.body || {}).id as string | undefined;
    if (!id) { res.status(400).json({ error: 'id required' }); return; }
    // Ack = the unread → read delivery transition, taken through the SAME audited
    // path as every other status change: validated against the config state machine
    // AND recorded in status_history. (Previously this bypassed the audit trail.)
    const by = (req as Request & { mcpTerminal?: string }).mcpTerminal;
    const result = await updateMessageStatus(id, 'read' as MessageStatus, by);
    if (!result.success) {
      const code = result.error?.includes('not found') ? 404 : 409; // 409 = invalid transition
      res.status(code).json({ error: result.error });
      return;
    }
    res.json({ success: true, id, status: 'read' });
  });

  // POST /api/federation/status   { id, to, by? }
  // THE tool-call path for status changes (DB-driven agent management): agents
  // report lifecycle transitions here with a constrained enum — never by writing
  // status text into .md files. Validated against the config state machine and
  // recorded in the status_history audit trail.
  router.post('/status', async (req: Request, res: Response): Promise<void> => {
    const { id, to, by } = (req.body || {}) as { id?: string; to?: string; by?: string };
    if (!id || !to) { res.status(400).json({ error: 'id and to required' }); return; }
    if (!isCanonicalStatus(to)) {
      res.status(400).json({ error: `'${to}' is not a canonical status` });
      return;
    }
    const result = await updateMessageStatus(id, to as MessageStatus, by || (req as Request & { mcpTerminal?: string }).mcpTerminal);
    if (!result.success) {
      const code = result.error?.includes('not found') ? 404 : 409; // 409 = invalid transition
      res.status(code).json({ error: result.error });
      return;
    }
    res.json({ success: true, id, status: to });
  });

  // GET /api/federation/history/:id — the message's status-transition audit trail.
  // This is the trajectory record the agent-eval suite scores against.
  router.get('/history/:id', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const msg = await getMessage(id);
    if (!msg) { res.status(404).json({ error: 'message not found' }); return; }
    res.json({ success: true, id, status: msg.status, history: getStatusHistory(id) });
  });

  return router;
}

export default { createFederationApiRouter };
