/**
 * Server Startup Module
 * Handles initialization, startup, and graceful shutdown
 */

import { Server } from 'http';
import {
  initVectorStore,
  getDocumentCount,
} from '../vectorStore';
import { initDatabase as initTaskMessageBox } from '../task-message-box';
import { buildIndex } from '../indexer';
import { startInboxWatcher, inboxEvents, scanExistingUnread, initializeRegistry, InboxEvent } from '../inboxWatcher';
import {
  startNightwatchScheduler,
  stopNightwatchScheduler,
  startHeartbeatScheduler,
  stopHeartbeatScheduler,
  startAutoRestartScheduler,
  stopAutoRestartScheduler,
  getHeartbeatConfig,
  getDefaultConfig as getAutoRestartConfig,
  // Inter-agent messaging
  initMessageDb,
  closeMessageDb,
  startMessageRouter,
  stopMessageRouter,
  // Channel coordinator
  startChannelCoordinator,
  stopChannelCoordinator,
  // Multi-channel provider
  initMultiChannel,
  getMultiChannelStatus,
  // Telegram Bot
  setWebhook as setTelegramWebhook,
  getWebhookInfo,
  // System metrics
  startMetricsScheduler,
  stopMetricsScheduler,
  // Autonomous development
  startAutonomousDevScheduler,
  stopAutonomousDevScheduler,
  getAutonomousDevStatus,
  // Root monitoring
  startRootMonitorScheduler,
  stopRootMonitorScheduler,
  getRootMonitorStatus,
  // Idea scanning
  startIdeaScanScheduler,
  stopIdeaScanScheduler,
  getIdeaScanStatus,
  // Hourly digest
  startHourlyDigestScheduler,
  stopHourlyDigestScheduler,
  getHourlyDigestStatus,
  // Phase coordination
  startPhaseCoordinator,
  stopPhaseCoordinator,
  getPhaseCoordinatorStatus,
} from '../pipeline';

import {
  initDispatchDb,
  closeDispatchDb,
  getDispatchMode,
  setProposalDb,
  setWindowsDb,
  getWindowStats,
} from '../dispatch-control';

import { mailboxEvents, closeAllSSEConnections } from '../interfaces/http/routes/mailbox.routes';
import { setHealthMetrics } from '../interfaces/http/routes/health.routes';
import { startResponseWorker, stopResponseWorker } from '../telegram/telegramService';
import { startAllBots, stopAllBots, getBotsStatus } from '../telegram/multiBotManager';
import { subscribeToAllCheckpoints, getCheckpointSubscriptionStatus } from '../pipeline/subscriptionManager';
import { attachEpicNotifications } from '../pipeline/epicNotifications';
import { logger } from '../core/logger';
import { closeGraphStore } from '../knowledgeGraph/graphStore';
import { env } from '../config/env';
import { logPathConfig } from '../config/paths';

// ─── State ──────────────────────────────────────────────────────────────────

let isReady = false;
let isShuttingDown = false;

export function getReadyState(): boolean {
  return isReady;
}

export function getShuttingDownState(): boolean {
  return isShuttingDown;
}

// ─── Inbox Watcher Bridge ───────────────────────────────────────────────────

// Deduplication: track recently processed messageIds to avoid double injection
const recentlyProcessedMessages = new Map<string, number>();
const DEDUP_WINDOW_MS = 5000; // 5 seconds

function isDuplicateEvent(messageId: string): boolean {
  const now = Date.now();
  const lastProcessed = recentlyProcessedMessages.get(messageId);

  if (lastProcessed && (now - lastProcessed) < DEDUP_WINDOW_MS) {
    return true; // Duplicate within window
  }

  // Clean up old entries
  for (const [id, timestamp] of recentlyProcessedMessages) {
    if ((now - timestamp) > DEDUP_WINDOW_MS * 2) {
      recentlyProcessedMessages.delete(id);
    }
  }

  recentlyProcessedMessages.set(messageId, now);
  return false;
}

export function setupInboxWatcherBridge(): void {
  // Listen for inbox changes and wake outbound runners. This service never
  // starts an agent directly: the runner remains the single launch authority.
  inboxEvents.on('inbox_change', (event: InboxEvent) => {
    // Deduplicate: skip if same messageId was processed recently
    if (isDuplicateEvent(event.messageId)) {
      logger.info(`[InboxWatcher] Skipping duplicate event for ${event.messageId}`);
      return;
    }
    // Broadcast SSE notification
    mailboxEvents.emit('notification', {
      terminal: event.terminal,
      type: 'new_message',
      messageId: event.messageId,
      timestamp: event.timestamp,
      details: {
        priority: event.priority,
        messageType: event.messageType,
        filePath: event.filePath,
        source: 'file_watcher',
      },
    });

    logger.info(`[SSE] Wake-up sent to ${event.terminal} for ${event.messageId}`);
  });
}

/**
 * Config-gated inbox-watcher start (TASK-QC-013). Returns whether the watcher
 * was started. The ENABLE_INBOX_WATCHER key is opt-out (default true) so
 * production behavior is unchanged; DEV isolation (conductor CLAUDE.md:
 * "Inbox-watcher KI") is enforced by setting it to 'false' in .env.dev.
 */
export function startInboxWatcherIfEnabled(): boolean {
  if (!env.ENABLE_INBOX_WATCHER) {
    logger.info('📪 Inbox watcher: DISABLED (set ENABLE_INBOX_WATCHER to re-enable)');
    return false;
  }
  logger.info('📬 Inbox watcher: ENABLED (set ENABLE_INBOX_WATCHER=false to disable)');
  startInboxWatcher();
  setupInboxWatcherBridge();
  return true;
}

// ─── Initialization ─────────────────────────────────────────────────────────

export async function initialize(): Promise<void> {
  // Log effective (secret-free) path configuration first so misconfigured
  // deployments are visible before any data is written.
  logPathConfig();

  // Initialize TaskMessageBox (SQLite backend)
  await initTaskMessageBox();

  // Initialize vector store
  await initVectorStore();

  const count = await getDocumentCount();
  if (count === 0) {
    logger.info('📚 Store empty — running initial knowledge base indexing...');
    await buildIndex();
  } else {
    logger.info(
      `📚 Store has ${count} documents. POST /api/knowledge/index to re-index.`
    );
  }

  // Initialize message registry (sync with filesystem)
  await initializeRegistry();

  // Start inbox file watcher (config-gated: DEV isolation keeps it off)
  startInboxWatcherIfEnabled();

  // Log existing UNREAD messages on startup
  const existingUnread = await scanExistingUnread();
  if (existingUnread.length > 0) {
    logger.info(`\n📬 Found ${existingUnread.length} existing UNREAD messages:`);
    for (const msg of existingUnread) {
      logger.info(`   - ${msg.terminal}: ${msg.messageId} (${msg.priority || 'normal'})`);
    }
  }
}

// ─── Start Services ─────────────────────────────────────────────────────────

export function startServices(port: number): void {
  isReady = true;
  setHealthMetrics({ ready: true, shuttingDown: false });

  logger.info(`\n🚀 SpaceOS Knowledge Service on port ${port}`);
  logger.info(`   GET  /health`);
  logger.info(`   GET  /ready`);
  logger.info(`\n   Knowledge Service:`);
  logger.info(`   GET  /api/knowledge/search?q=...&topK=5`);
  logger.info(`   POST /api/knowledge/search   { q, topK? }`);
  logger.info(`   POST /api/knowledge/index    (re-index)`);
  logger.info(`\n   Mailbox Tools:`);
  logger.info(`   GET  /api/mailbox/:terminal/inbox?status=UNREAD|READ|all`);
  logger.info(`   GET  /api/mailbox/:terminal/completions?after=<cursor>  (durable runner receipts)`);
  logger.info(`   POST /api/mailbox/:terminal/inbox   (send_message)`);
  logger.info(`   POST /api/mailbox/:terminal/outbox  (submit_done)`);
  logger.info(`\n   Tasks:`);
  logger.info(`   GET  /api/tasks/status?task_id=...`);
  logger.info(`\n   Live Notifications:`);
  logger.info(`   GET  /api/mailbox/:terminal/subscribe  (SSE wake-on-inbox)`);
  logger.info(`\n   MCP Protocol (Claude Code):`);
  logger.info(`   GET  /mcp              (server info)`);
  logger.info(`   POST /mcp              (JSON-RPC: initialize, tools/list, tools/call)\n`);

  // Start Nightwatch scheduler if enabled
  if (env.ENABLE_NIGHTWATCH) {
    const intervalMs = env.NIGHTWATCH_INTERVAL;
    startNightwatchScheduler(intervalMs);
    logger.info(`   ⏰ Nightwatch Scheduler: ENABLED (every ${intervalMs / 1000}s)`);
  } else {
    logger.info(`   ⏰ Nightwatch Scheduler: DISABLED (set ENABLE_NIGHTWATCH=true to enable)`);
  }

  // Start Heartbeat scheduler if enabled
  if (env.ENABLE_HEARTBEAT) {
    const heartbeatConfig = getHeartbeatConfig();
    startHeartbeatScheduler(heartbeatConfig);
    logger.info(`   💓 Heartbeat Scheduler: ENABLED (every ${heartbeatConfig.intervalMs / 60000}min)`);
  } else {
    logger.info(`   💓 Heartbeat Scheduler: DISABLED (set ENABLE_HEARTBEAT=true to enable)`);
  }

  // Start Auto-Restart scheduler if enabled
  if (env.ENABLE_AUTO_RESTART) {
    const autoRestartConfig = getAutoRestartConfig();
    startAutoRestartScheduler(autoRestartConfig);
    const scheduleDesc = autoRestartConfig.schedule.type === 'daily'
      ? `daily at ${autoRestartConfig.schedule.hour}:${String((autoRestartConfig.schedule as any).minute ?? 0).padStart(2, '0')}`
      : `every ${(autoRestartConfig.schedule as any).hours}h`;
    logger.info(`   🔄 Auto-Restart: ENABLED (${scheduleDesc})`);
  } else {
    logger.info(`   🔄 Auto-Restart: DISABLED (set ENABLE_AUTO_RESTART=true to enable)`);
  }

  // Initialize inter-agent messaging
  initMessageDb();
  logger.info(`   📨 Agent Messages: Database initialized`);

  // Initialize dispatch control database
  const dispatchDb = initDispatchDb();
  setProposalDb(dispatchDb);
  setWindowsDb(dispatchDb);
  const dispatchMode = getDispatchMode();
  logger.info(`   🎛️ Dispatch Control: ${dispatchMode.toUpperCase()} mode`);
  const windowStats = getWindowStats();
  logger.info(`   🕐 Scheduled Windows: ${windowStats.totalWindows} configured, current: ${windowStats.currentWindow || 'none'}`);

  // Start message router if enabled
  if (env.ENABLE_MESSAGE_ROUTER) {
    const routerIntervalMs = env.MESSAGE_ROUTER_INTERVAL;
    startMessageRouter(routerIntervalMs);
    logger.info(`   📬 Message Router: ENABLED (every ${routerIntervalMs / 1000}s)`);
  } else {
    logger.info(`   📬 Message Router: DISABLED (set ENABLE_MESSAGE_ROUTER=true to enable)`);
  }

  // Start channel coordinator if enabled
  if (env.ENABLE_TELEGRAM_COORDINATOR) {
    startChannelCoordinator();
    logger.info(`   📡 Telegram Coordinator: ENABLED (hybrid backfill mode)`);
  } else {
    logger.info(`   📡 Telegram Coordinator: DISABLED (set ENABLE_TELEGRAM_COORDINATOR=true to enable)`);
  }

  // Start system metrics collection (always enabled)
  const metricsIntervalMs = env.METRICS_INTERVAL;
  startMetricsScheduler(metricsIntervalMs);
  logger.info(`   📊 System Metrics: ENABLED (every ${metricsIntervalMs / 1000}s)`);

  // Start Autonomous Development scheduler if enabled
  if (env.ENABLE_AUTONOMOUS_DEV) {
    startAutonomousDevScheduler();
    const status = getAutonomousDevStatus();
    logger.info(`   🤖 Autonomous Dev: ENABLED (every 30min)`);
    logger.info(`      📄 Focus file: ${status.config.focusFile}`);
    logger.info(`      🔄 Cold start: ${status.config.coldStart}`);
  } else {
    logger.info(`   🤖 Autonomous Dev: DISABLED (set ENABLE_AUTONOMOUS_DEV=true to enable)`);
  }

  // Start Root Monitor scheduler if enabled
  if (env.ENABLE_ROOT_MONITOR) {
    startRootMonitorScheduler();
    logger.info(`   👁️ Root Monitor: ENABLED (every 30min)`);
  } else {
    logger.info(`   👁️ Root Monitor: DISABLED (set ENABLE_ROOT_MONITOR=true to enable)`);
  }

  // Start Idea Scan scheduler if enabled
  if (env.ENABLE_IDEA_SCAN) {
    startIdeaScanScheduler();
    const status = getIdeaScanStatus();
    logger.info(`   💡 Idea Scan: ENABLED (every 30min)`);
    logger.info(`      📁 Project: ${status.config.projectPath}`);
  } else {
    logger.info(`   💡 Idea Scan: DISABLED (set ENABLE_IDEA_SCAN=true to enable)`);
  }

  // Start Hourly Digest scheduler if enabled
  if (env.ENABLE_HOURLY_DIGEST) {
    startHourlyDigestScheduler();
    const status = getHourlyDigestStatus();
    const nextRun = status.nextRun ? status.nextRun.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }) : 'N/A';
    logger.info(`   📊 Hourly Digest: ENABLED (next: ${nextRun})`);
  } else {
    logger.info(`   📊 Hourly Digest: DISABLED (set ENABLE_HOURLY_DIGEST=true to enable)`);
  }

  // Start Phase Coordinator scheduler if enabled
  if (env.ENABLE_PHASE_COORDINATOR) {
    startPhaseCoordinator();
    const phaseStatus = getPhaseCoordinatorStatus();
    logger.info(`   📋 Phase Coordinator: ENABLED (every ${phaseStatus.config.intervalMinutes}min)`);
  }

  // Initialize multi-channel notifications
  initMultiChannel();
  const channelStatus = getMultiChannelStatus();
  const enabledChannels = Object.entries(channelStatus)
    .filter(([_, s]) => s.enabled)
    .map(([c]) => c);
  if (enabledChannels.length > 0) {
    logger.info(`   📢 Multi-Channel: ${enabledChannels.join(', ')}`);
  } else {
    logger.info(`   📢 Multi-Channel: No channels configured`);
  }

  // Start Telegram Response Worker (always enabled)
  startResponseWorker();

  // Start Multi-Bot Manager (ADR-049 Phase 1)
  if (env.ENABLE_MULTI_BOT) {
    startAllBots().then(() => {
      const botsStatus = getBotsStatus();
      const runningBots = Object.entries(botsStatus).filter(([_, s]) => s.running);
      logger.info(`   🤖 Multi-Bot Manager: ENABLED (${runningBots.length} bots)`);
      for (const [name, status] of Object.entries(botsStatus)) {
        const icon = status.running ? '✅' : '❌';
        logger.info(`      ${icon} @${status.username} → ${status.terminal}`);
      }
    }).catch(err => {
      logger.error('   🤖 Multi-Bot Manager: FAILED to start', err);
    });
  } else {
    logger.info(`   🤖 Multi-Bot Manager: DISABLED (set ENABLE_MULTI_BOT=true to enable)`);
  }
  logger.info(`   📱 Telegram Response Worker: ENABLED`);

  // Auto-subscribe to all EPICS.yaml checkpoints
  const checkpointCount = subscribeToAllCheckpoints();
  if (checkpointCount > 0) {
    const status = getCheckpointSubscriptionStatus();
    const pendingCount = status.filter(s => s.status === 'pending').length;
    logger.info(`   🎯 Checkpoint Subscriptions: ${checkpointCount} created (${pendingCount} pending checkpoints)`);
  } else {
    logger.info(`   🎯 Checkpoint Subscriptions: No pending checkpoints`);
  }

  // Attach epic progress notifications (Telegram)
  attachEpicNotifications();
  logger.info(`   📢 Epic Notifications: ENABLED (Telegram progress tracking)`);

  // Set up Telegram webhook if configured (async in background)
  const telegramWebhookUrl = env.TELEGRAM_WEBHOOK_URL;
  (async () => {
    if (telegramWebhookUrl) {
      const webhookSuccess = await setTelegramWebhook(telegramWebhookUrl);
      logger.info(`   🤖 Telegram Bot: Webhook ${webhookSuccess ? 'configured' : 'FAILED'} → ${telegramWebhookUrl}`);
    } else {
      const webhookInfo = await getWebhookInfo();
      if (webhookInfo?.url) {
        logger.info(`   🤖 Telegram Bot: Webhook active → ${webhookInfo.url}`);
      } else {
        logger.info(`   🤖 Telegram Bot: No webhook (set TELEGRAM_WEBHOOK_URL to enable)`);
      }
    }
  })();
  logger.info('');
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

export function createGracefulShutdown(server: Server): (signal: string) => void {
  return (signal: string) => {
    logger.info(`\n⏳ ${signal} received, shutting down gracefully...`);
    isShuttingDown = true;
    setHealthMetrics({ ready: false, shuttingDown: true });

    // Stop all schedulers and services
    stopHourlyDigestScheduler();
    isReady = false;
    stopNightwatchScheduler();
    stopHeartbeatScheduler();
    stopAutoRestartScheduler();
    stopAutonomousDevScheduler();
    stopRootMonitorScheduler();
    stopIdeaScanScheduler();
    stopPhaseCoordinator();
    stopMessageRouter();
    stopChannelCoordinator();
    stopResponseWorker();
    stopAllBots();
    closeMessageDb();
    closeDispatchDb();
    // Fire-and-forget: driver close is async, but shutdown must not block on it.
    closeGraphStore().catch(() => undefined);

    // Stop accepting new connections
    server.close(() => {
      logger.info('✅ HTTP server closed');

      // Close all SSE connections
      closeAllSSEConnections();
      logger.info('✅ SSE connections closed');

      logger.info('👋 Goodbye!');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      logger.error('⚠️ Forced exit after timeout');
      process.exit(1);
    }, 10000);
  };
}

export default {
  initialize,
  startServices,
  createGracefulShutdown,
  getReadyState,
  getShuttingDownState,
  setupInboxWatcherBridge,
};
