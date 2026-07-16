/**
 * SpaceOS Knowledge Service — Express server
 *
 * Refactored to use modular routes and bootstrap modules.
 * See bootstrap/app.ts for route configuration.
 * See bootstrap/startup.ts for initialization logic.
 */

import 'dotenv/config';
import path from 'path';
import { env } from './config/env';
import { createApp, initialize, startServices, createGracefulShutdown } from './bootstrap';
import { setHealthMetrics } from './interfaces/http/routes';
import { usingChroma, getDocumentCount } from './vectorStore';
import { embeddingBackend } from './embeddings';
import { KNOWLEDGE_BASE_PATH, COLLECTION_NAME } from './config/paths';
import { logger } from './core/logger';

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = env.PORT;
const HOST = env.HOST;
const reactBuildPath = path.join(__dirname, '../public');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Initialize services (vector store, inbox watcher, message registry)
  await initialize();

  // Create Express app with all routes
  const app = createApp({
    enableStaticFiles: true,
    staticPath: reactBuildPath,
  });

  // Update health metrics
  const docCount = await getDocumentCount();
  setHealthMetrics({
    vectorBackend: usingChroma() ? 'chroma' : 'in-memory',
    embeddingBackend: embeddingBackend(),
    documentCount: docCount,
    knowledgePath: KNOWLEDGE_BASE_PATH,
    collectionName: COLLECTION_NAME,
    port: PORT,
  });

  // Start HTTP server. Bind host is config-driven (env.HOST) so exposed
  // deployments can listen on a private interface only (e.g. Tailscale).
  const server = app.listen(PORT, HOST, () => {
    logger.info(`[Server] Listening on ${HOST}:${PORT}`);
    startServices(PORT);
  });

  // Set up graceful shutdown
  const gracefulShutdown = createGracefulShutdown(server);
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch(err => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
