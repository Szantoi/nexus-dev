/**
 * Health & Readiness Routes
 */

import { Router, Request, Response } from 'express';

const router = Router();

// Store for health metrics
let vectorBackend = 'unknown';
let embeddingBackend = 'unknown';
let documentCount = 0;
let knowledgePath = '(default)';
let collectionName = '(default)';
let port = 3456;
let isReady = false;
let isShuttingDown = false;

export function setHealthMetrics(metrics: {
  vectorBackend?: string;
  embeddingBackend?: string;
  documentCount?: number;
  knowledgePath?: string;
  collectionName?: string;
  port?: number;
  ready?: boolean;
  shuttingDown?: boolean;
}): void {
  if (metrics.vectorBackend) vectorBackend = metrics.vectorBackend;
  if (metrics.embeddingBackend) embeddingBackend = metrics.embeddingBackend;
  if (metrics.documentCount !== undefined) documentCount = metrics.documentCount;
  if (metrics.knowledgePath) knowledgePath = metrics.knowledgePath;
  if (metrics.collectionName) collectionName = metrics.collectionName;
  if (metrics.port) port = metrics.port;
  if (metrics.ready !== undefined) isReady = metrics.ready;
  if (metrics.shuttingDown !== undefined) isShuttingDown = metrics.shuttingDown;
}

export function getHealthState(): { ready: boolean; shuttingDown: boolean } {
  return { ready: isReady, shuttingDown: isShuttingDown };
}

// ─── Health Check ─────────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    vectorBackend,
    embeddingBackend,
    documents: documentCount,
    knowledgePath,
    collectionName,
    port,
  });
});

// ─── Readiness Probe ──────────────────────────────────────────────────────────

router.get('/ready', (_req: Request, res: Response) => {
  // Check if server is shutting down
  if (isShuttingDown) {
    res.status(503).json({
      status: 'shutting down',
      reason: 'Server is shutting down',
    });
    return;
  }

  // Check if essential services are ready
  if (isReady && vectorBackend !== 'unknown') {
    res.json({
      status: 'ready',
      vectorBackend,
      embeddingBackend,
      documents: documentCount,
    });
  } else {
    res.status(503).json({
      status: 'not ready',
      reason: isReady ? 'Vector store not initialized' : 'Server not ready',
    });
  }
});

// ─── Liveness Probe ───────────────────────────────────────────────────────────

router.get('/live', (_req: Request, res: Response) => {
  res.json({
    status: 'alive',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

export default router;
