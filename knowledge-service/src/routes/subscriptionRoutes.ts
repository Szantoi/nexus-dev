/**
 * Subscription Routes - SSE Endpoint for Push Notifications
 *
 * Implements ADR-052: FSM Subscription System
 * Provides Server-Sent Events (SSE) endpoint for real-time notifications
 *
 * 2026-06-30: Phase 1 Core Implementation
 */

import { Router, type Request, type Response } from 'express';
import { emitOutboxEvent } from '../pipeline/eventBus';

const router = Router();

// ─── SSE Client Registry ──────────────────────────────────────────────────────

/**
 * Active SSE clients by terminal
 * terminal name -> Set of Response objects
 */
const sseClients = new Map<string, Set<Response>>();

// ─── SSE Endpoint ─────────────────────────────────────────────────────────────

/**
 * GET /api/subscriptions/events
 *
 * Server-Sent Events endpoint for push notifications
 *
 * Query params:
 *   - terminal: Terminal name (required)
 *
 * Response: text/event-stream
 */
router.get('/events', (req: Request, res: Response) => {
  const terminal = req.query.terminal as string;

  if (!terminal) {
    return res.status(400).json({ error: 'terminal parameter required' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Register client
  if (!sseClients.has(terminal)) {
    sseClients.set(terminal, new Set());
  }
  const clients = sseClients.get(terminal)!;
  clients.add(res);

  console.log(`[SSE] ${terminal} connected (total: ${clients.size})`);

  // Send initial connection event
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    terminal,
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // Send initial subscription list (requires importing subscriptionManager)
  // Deferred to avoid circular dependency
  setTimeout(() => {
    try {
      const { subscriptionManager } = require('../pipeline/subscriptionManager');
      const subscriptions = subscriptionManager.getSubscriptions(terminal);

      res.write(`data: ${JSON.stringify({
        type: 'init',
        subscriptions,
        timestamp: new Date().toISOString(),
      })}\n\n`);
    } catch (error) {
      console.error('[SSE] Failed to load subscriptions:', error);
    }
  }, 100);

  // Cleanup on disconnect
  req.on('close', () => {
    const clients = sseClients.get(terminal);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        sseClients.delete(terminal);
      }
    }
    console.log(`[SSE] ${terminal} disconnected (remaining: ${clients?.size || 0})`);
  });

  // Keep connection alive with periodic ping
  const pingInterval = setInterval(() => {
    try {
      res.write(':ping\n\n');
    } catch (error) {
      clearInterval(pingInterval);
    }
  }, 30000); // 30 seconds

  req.on('close', () => {
    clearInterval(pingInterval);
  });
});

// ─── Broadcast Helper ─────────────────────────────────────────────────────────

/**
 * Broadcast data to all SSE clients of a terminal
 *
 * @param terminal Terminal name
 * @param data Data to send (will be JSON stringified)
 * @returns Number of clients that received the message
 */
export function broadcastToTerminal(terminal: string, data: unknown): number {
  const clients = sseClients.get(terminal);
  if (!clients || clients.size === 0) {
    return 0;
  }

  const message = `data: ${JSON.stringify(data)}\n\n`;
  let successCount = 0;

  clients.forEach(client => {
    try {
      client.write(message);
      successCount++;
    } catch (error) {
      // Remove failed client
      clients.delete(client);
      console.error(`[SSE] Failed to send to ${terminal}:`, error);
    }
  });

  return successCount;
}

/**
 * Get active SSE connection count for a terminal
 */
export function getActiveConnections(terminal?: string): number {
  if (terminal) {
    return sseClients.get(terminal)?.size || 0;
  }

  // Total across all terminals
  let total = 0;
  for (const clients of sseClients.values()) {
    total += clients.size;
  }
  return total;
}

/**
 * Get all active terminals with SSE connections
 */
export function getActiveTerminals(): string[] {
  return Array.from(sseClients.keys());
}

// ─── Test Endpoint ───────────────────────────────────────────────────────────

/**
 * POST /api/subscriptions/test-trigger
 *
 * Test endpoint to trigger subscription events manually
 * Used for testing checkpoint subscriptions
 *
 * Body:
 *   - terminal: Source terminal (e.g., "frontend")
 *   - messageId: Message/Epic ID to trigger (e.g., "EPIC-DATAHAVEN-UI")
 *   - eventType: Event type (default: "outbox:done")
 */
router.post('/test-trigger', (req: Request, res: Response) => {
  const { terminal, messageId, eventType = 'outbox:done' } = req.body;

  if (!terminal || !messageId) {
    return res.status(400).json({ error: 'terminal and messageId required' });
  }

  console.log(`[Test] Emitting ${eventType} for ${messageId} from ${terminal}`);

  emitOutboxEvent(eventType, terminal, messageId, {
    source: 'test_trigger',
    completedAt: new Date().toISOString(),
  });

  return res.json({
    success: true,
    message: `Event ${eventType} emitted for ${messageId}`,
    terminal,
    messageId,
    eventType,
  });
});

export default router;
