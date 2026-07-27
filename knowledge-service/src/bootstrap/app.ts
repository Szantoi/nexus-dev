/**
 * Express Application Factory
 * Creates and configures the Express app with all routes and middleware
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import path from 'path';

// Import all routes
import {
  healthRoutes,
  pipelineRoutes,
  controlRoutes,
  taskRoutes,
  mailboxRoutes,
  sessionRoutes,
  terminalRoutes,
  knowledgeRoutes,
  memoryRoutes,
  digestRoutes,
  authRoutes,
  dashboardRoutes,
  registryRoutes,
  kanbanRoutes,
  projectsRoutes,
  agentMessagesRoutes,
  channelsRoutes,
  epicRouterRoutes,
  costMonitoringRoutes,
  escalationRoutes,
  subscriptionRoutes,
} from '../interfaces/http/routes';

// Import existing routers (not yet migrated)
import mcpRouter, { authorizeMailboxRest } from '../mcp';
import { authenticateRest, apiAuthGate, requireRootForMutations } from '../auth/tokenAuth';
import graphRoutes from '../api/graphRoutes';
import { createPlanningRouter } from '../api/planningRoutes';
import { createFederationApiRouter } from '../interfaces/http/routes/federation.routes';
import { createEvalApiRouter } from '../interfaces/http/routes/eval.routes';
import {
  createTelegramRouter,
  createMetricsRouter,
  createAutonomousDevRouter,
  createRootMonitorRouter,
  createIdeaScanRouter,
  createPhaseCoordinatorRouter,
} from '../pipeline';
import { logger } from '../core/logger';
import { env } from '../config/env';

// ─── Rate Limiting ───────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 500; // 500 requests per minute per IP

export { rateLimitStore };

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
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

  // req.ip only trusts forwarding headers when Express has an explicit
  // trusted proxy-hop count configured below.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

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

// ─── App Factory ─────────────────────────────────────────────────────────────

export interface AppConfig {
  enableStaticFiles?: boolean;
  staticPath?: string;
}

export function createApp(config: AppConfig = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY_HOPS > 0) {
    app.set('trust proxy', env.TRUST_PROXY_HOPS);
  }

  const allowedOrigins = new Set(
    env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean),
  );

  // ─── CORS ──────────────────────────────────────────────────────────────────

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (req.method === 'OPTIONS') {
      if (origin && !allowedOrigins.has(origin)) {
        res.status(403).json({ error: 'Origin not allowed' });
        return;
      }
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ─── Body Parser & Rate Limiting ───────────────────────────────────────────

  // Route handlers historically returned raw exception messages themselves,
  // bypassing the global error handler. Redact every internal-error JSON body
  // at the application boundary while preserving safe 4xx/503 diagnostics.
  app.use((_req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 500 && body && typeof body === 'object' && !Array.isArray(body)) {
        const safeBody: Record<string, unknown> = {
          ...(body as Record<string, unknown>),
          error: 'Internal server error',
        };
        delete safeBody.details;
        return sendJson(safeBody);
      }
      return sendJson(body);
    }) as Response['json'];
    next();
  });

  app.use(express.json());
  app.use(rateLimit);

  // In AUTH_MODE=required every /api route needs a valid Bearer token;
  // in 'open' mode this is a no-op and per-route auth (mailbox) still applies.
  app.use('/api', apiAuthGate);

  // ─── MCP Protocol ──────────────────────────────────────────────────────────

  app.use('/mcp', mcpRouter);

  // ─── Pipeline Routers (factory-created) ────────────────────────────────────

  app.use('/api/telegram', createTelegramRouter());
  app.use('/api/metrics', createMetricsRouter());
  app.use('/api/autonomous', requireRootForMutations, createAutonomousDevRouter());
  app.use('/api/monitor', requireRootForMutations, createRootMonitorRouter());
  app.use('/api/ideas', requireRootForMutations, createIdeaScanRouter());
  app.use('/api/graph', graphRoutes);
  app.use('/api/planning', createPlanningRouter());
  app.use('/api/phase', requireRootForMutations, createPhaseCoordinatorRouter());
  app.use('/api/federation', createFederationApiRouter());   // ADR-066 cross-island API
  app.use('/api/eval', requireRootForMutations, createEvalApiRouter()); // agent-eval: golden paths + trajectory scoring

  // ─── Refactored Routes ─────────────────────────────────────────────────────

  // Health & Pipeline
  app.use('/', healthRoutes);
  app.use('/api/pipeline', requireRootForMutations, pipelineRoutes);

  // Dispatch Control
  app.use('/api/control', requireRootForMutations, controlRoutes);

  // Task Management
  app.use('/api/task', taskRoutes);

  // Mailbox (MSG-NEXUS-016: Authentication required)
  app.use('/api/mailbox', authenticateRest, authorizeMailboxRest, mailboxRoutes);

  // Tasks status (backward compatibility - redirect to mailbox)
  app.get('/api/tasks/status', (req, res, next) => {
    req.url = '/tasks/status' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
    mailboxRoutes(req, res, next);
  });

  // Sessions
  app.use('/api/session', requireRootForMutations, sessionRoutes);
  app.use('/api/sessions', requireRootForMutations, sessionRoutes);

  // Terminal Status
  app.use('/api/terminal', terminalRoutes);
  app.use('/api/terminals', terminalRoutes);

  // Knowledge Service
  app.use('/api/knowledge', requireRootForMutations, knowledgeRoutes);

  // Memory Tiers (ADR-046)
  app.use('/api/memories', memoryRoutes);

  // Daily Digest (ADR-046)
  app.use('/api/digest', digestRoutes);

  // Subscriptions (ADR-052)
  app.use('/api/subscriptions', requireRootForMutations, subscriptionRoutes);

  // Task Escalation (ADR-052 Phase 2)
  app.use('/api/escalation', escalationRoutes);

  // Auth
  app.use('/api/auth', authRoutes);

  // Dashboard
  app.use('/api/dashboard', dashboardRoutes);

  // Message Registry
  app.use('/api/registry', registryRoutes);

  // Kanban
  app.use('/api/kanban', kanbanRoutes);

  // Projects
  app.use('/api/projects', projectsRoutes);

  // Agent Messages
  app.use('/api/agent-messages', agentMessagesRoutes);

  // Channels
  app.use('/api/channels', channelsRoutes);

  // Epic Router (2026-06-24)
  app.use('/api/epic-router', epicRouterRoutes);

  // Cost Monitoring (2026-07-04 - MSG-BACKEND-126)
  app.use('/api/monitoring/cost', requireRootForMutations, costMonitoringRoutes);

  // ─── Error Handler ─────────────────────────────────────────────────────────

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('[ERROR]', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ─── Static Files (React Dashboard) ────────────────────────────────────────

  if (config.enableStaticFiles) {
    const staticPath = config.staticPath || path.join(__dirname, '../../public');
    app.use(express.static(staticPath));

    // SPA fallback - serve index.html for non-API routes
    // Note: Express 5 / path-to-regexp 8.x requires explicit pattern instead of '*'
    app.use((req, res) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/mcp') ||
          req.path === '/health' || req.path === '/ready') {
        return res.status(404).json({ error: 'Not found' });
      }
      res.sendFile(path.join(staticPath, 'index.html'));
    });
  }

  return app;
}

export default createApp;
