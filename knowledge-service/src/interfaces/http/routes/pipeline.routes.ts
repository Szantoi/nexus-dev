/**
 * Pipeline Routes
 * SSE events, stats, and pipeline control
 */

import { Router, Request, Response } from 'express';
import { pipelineEvents } from '../../../pipeline/eventBus';
import { runNightwatch } from '../../../pipeline/nightwatch';

const router = Router();

// ─── SSE Client Management ────────────────────────────────────────────────────

const pipelineSSEClients = new Set<Response>();

export function getPipelineClientCount(): number {
  return pipelineSSEClients.size;
}

// ─── SSE Events Stream ────────────────────────────────────────────────────────

router.get('/events', (req: Request, res: Response) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send recent events for reconnection support
  const since = req.query.since as string | undefined;
  const recentEvents = pipelineEvents.getRecentEvents(since, 20);

  if (recentEvents.length > 0) {
    res.write(`event: replay\ndata: ${JSON.stringify(recentEvents)}\n\n`);
  }

  // Subscribe to new events
  const eventHandler = (event: any) => {
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      pipelineSSEClients.delete(res);
      pipelineEvents.removeListener('*', eventHandler);
    }
  };

  pipelineEvents.onAny(eventHandler);
  pipelineSSEClients.add(res);

  // Heartbeat
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
      pipelineSSEClients.delete(res);
      pipelineEvents.removeListener('*', eventHandler);
    }
  }, 30000);

  // Cleanup
  req.on('close', () => {
    clearInterval(heartbeat);
    pipelineSSEClients.delete(res);
    pipelineEvents.removeListener('*', eventHandler);
  });
});

// ─── Pipeline Stats ───────────────────────────────────────────────────────────

router.get('/stats', (_req: Request, res: Response) => {
  const stats = pipelineEvents.getStats();
  const recentEvents = pipelineEvents.getRecentEvents(undefined, 10);

  res.json({
    eventCounts: stats,
    recentEvents,
    connectedClients: pipelineSSEClients.size,
  });
});

// ─── Manual Nightwatch Trigger ────────────────────────────────────────────────

router.post('/nightwatch/run', async (_req: Request, res: Response) => {
  try {
    const result = await runNightwatch();
    res.json({
      success: true,
      result,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Pipeline Health ──────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  const stats = pipelineEvents.getStats();
  const lastCycle = pipelineEvents.getRecentEvents(undefined, 1)[0];

  res.json({
    status: 'ok',
    lastCycleAt: lastCycle?.timestamp || null,
    eventCounts: stats,
    sseClients: pipelineSSEClients.size,
  });
});

export default router;
