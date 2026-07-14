/**
 * Cost Monitoring Routes
 * Exposes worker cost data via HTTP endpoints (including SSE streaming)
 * Part of MSG-BACKEND-126: Cost Monitoring API Endpoints
 */

import { Router, Request, Response } from 'express';
import {
  getCurrentCosts,
  getTodayCosts,
  getTerminalCosts,
  getCostHistory,
  getCostConfig,
  updateCostConfig,
  recordPauseNotification,
  type CostConfigDto,
} from '../../../application/services/costMonitoringService';

const router = Router();

// ─── Cache Implementation ────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const cache = new Map<string, CacheEntry<any>>();

function getCached<T>(key: string, ttlSeconds: number, generator: () => T): T {
  const entry = cache.get(key);
  const now = Date.now();

  if (entry && now < entry.expiry) {
    return entry.data as T;
  }

  const data = generator();
  cache.set(key, {
    data,
    expiry: now + ttlSeconds * 1000,
  });

  return data;
}

// Cleanup expired cache entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now >= entry.expiry) {
      cache.delete(key);
    }
  }
}, 60000);

// ─── SSE Endpoint ────────────────────────────────────────────────────────────

/**
 * GET /api/monitoring/cost/stream
 * Server-Sent Events endpoint for real-time cost updates
 * No caching - real-time updates every 1-2 seconds
 * Connection timeout: 5 minutes with keep-alive every 30s
 */
router.get('/stream', (req: Request, res: Response) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  console.log('[CostMonitoring] SSE client connected');

  let intervalId: NodeJS.Timeout | null = null;
  let keepAliveId: NodeJS.Timeout | null = null;
  let iteration = 0;
  const MAX_ITERATIONS = 150; // 150 × 2s = 5 minutes

  // Send cost updates every 2 seconds
  intervalId = setInterval(() => {
    if (iteration >= MAX_ITERATIONS) {
      cleanup();
      return;
    }

    try {
      const costData = getCurrentCosts();
      const json = JSON.stringify(costData);

      res.write(`event: cost-update\n`);
      res.write(`data: ${json}\n\n`);

      iteration++;
    } catch (err) {
      console.error('[CostMonitoring] SSE send error:', err);
      cleanup();
    }
  }, 2000);

  // Send keep-alive comment every 30 seconds
  keepAliveId = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch (err) {
      console.error('[CostMonitoring] SSE keep-alive error:', err);
      cleanup();
    }
  }, 30000);

  // Cleanup function
  function cleanup() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (keepAliveId) {
      clearInterval(keepAliveId);
      keepAliveId = null;
    }
    console.log('[CostMonitoring] SSE client disconnected');
    res.end();
  }

  // Handle client disconnect
  req.on('close', cleanup);
  req.on('error', cleanup);
});

// ─── REST Endpoints ──────────────────────────────────────────────────────────

/**
 * GET /api/monitoring/cost/today
 * Today's cost summary (cached 30s)
 */
router.get('/today', (req: Request, res: Response) => {
  try {
    const data = getCached('today', 30, getTodayCosts);
    res.json(data);
  } catch (err) {
    console.error('[CostMonitoring] /today error:', err);
    res.status(500).json({ error: 'Failed to fetch today costs' });
  }
});

/**
 * GET /api/monitoring/cost/terminal/:terminal
 * Terminal cost detail with history (cached 1min)
 * Query params: ?days=7
 */
router.get('/terminal/:terminal', (req: Request, res: Response) => {
  try {
    const terminalParam = req.params.terminal;
    const terminal = typeof terminalParam === 'string' ? terminalParam : '';
    const daysQuery = req.query.days;
    const daysParam = typeof daysQuery === 'string' ? daysQuery : (Array.isArray(daysQuery) ? daysQuery[0] : '7');
    const days = parseInt(String(daysParam) || '7') || 7;

    if (!terminal) {
      res.status(400).json({ error: 'Terminal name required' });
      return;
    }

    const validTerminals = ['backend', 'frontend', 'architect', 'designer', 'conductor', 'librarian', 'explorer'];
    if (!validTerminals.includes(terminal)) {
      res.status(400).json({ error: `Invalid terminal. Must be one of: ${validTerminals.join(', ')}` });
      return;
    }

    const cacheKey = `terminal:${terminal}:${days}`;
    const data = getCached(cacheKey, 60, () => getTerminalCosts(terminal, days));

    res.json(data);
  } catch (err) {
    console.error('[CostMonitoring] /terminal/:terminal error:', err);
    res.status(500).json({ error: 'Failed to fetch terminal costs' });
  }
});

/**
 * GET /api/monitoring/cost/history
 * Cost history for last N days (cached 5min)
 * Query params: ?days=7
 */
router.get('/history', (req: Request, res: Response) => {
  try {
    const daysQuery = req.query.days;
    const daysParam = typeof daysQuery === 'string' ? daysQuery : (Array.isArray(daysQuery) ? daysQuery[0] : '7');
    const days = Math.min(parseInt(String(daysParam) || '7') || 7, 30); // Max 30 days
    const cacheKey = `history:${days}`;

    const data = getCached(cacheKey, 300, () => getCostHistory(days));
    res.json(data);
  } catch (err) {
    console.error('[CostMonitoring] /history error:', err);
    res.status(500).json({ error: 'Failed to fetch cost history' });
  }
});

/**
 * GET /api/monitoring/cost/config
 * Get current cost configuration (cached 10min)
 */
router.get('/config', (req: Request, res: Response) => {
  try {
    const data = getCached('config', 600, getCostConfig);
    res.json(data);
  } catch (err) {
    console.error('[CostMonitoring] /config GET error:', err);
    res.status(500).json({ error: 'Failed to fetch cost config' });
  }
});

/**
 * PUT /api/monitoring/cost/config
 * Update cost configuration (admin only)
 * TODO: Add proper auth middleware when admin role is implemented
 */
router.put('/config', (req: Request, res: Response) => {
  try {
    // TODO: Check admin role
    // if (!req.user?.role || req.user.role !== 'admin') {
    //   res.status(403).json({ error: 'Admin role required' });
    //   return;
    // }

    const config: Partial<CostConfigDto> = req.body;

    // Validate input
    if (config.dailyBudget !== undefined) {
      if (typeof config.dailyBudget !== 'number' || config.dailyBudget <= 0) {
        res.status(400).json({ error: 'dailyBudget must be a positive number' });
        return;
      }
    }

    const updated = updateCostConfig(config);

    // Invalidate config cache
    cache.delete('config');

    res.json({
      status: 'ok',
      config: updated,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CostMonitoring] /config PUT error:', err);
    res.status(500).json({ error: 'Failed to update cost config' });
  }
});

/**
 * POST /api/monitoring/cost/pause-notification
 * Record auto-pause notification
 */
router.post('/pause-notification', (req: Request, res: Response) => {
  try {
    const data = req.body;

    // Validate required fields
    if (!data.currentCost || !data.dailyBudget || !data.thresholdStatus || !data.terminals) {
      res.status(400).json({ error: 'Missing required fields: currentCost, dailyBudget, thresholdStatus, terminals' });
      return;
    }

    const result = recordPauseNotification(data);
    res.json(result);
  } catch (err) {
    console.error('[CostMonitoring] /pause-notification error:', err);
    res.status(500).json({ error: 'Failed to record pause notification' });
  }
});

// ─── Health Check ────────────────────────────────────────────────────────────

router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'cost-monitoring',
    cacheSize: cache.size,
  });
});

export default router;
