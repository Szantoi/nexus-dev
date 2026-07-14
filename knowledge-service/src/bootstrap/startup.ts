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
import { startTerminalSession } from '../sessionStarter';
import { shouldWakeUp } from '../terminalStatus';
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
  // Listen for inbox changes and trigger session start/injection
  inboxEvents.on('inbox_change', async (event: InboxEvent) => {
    // Deduplicate: skip if same messageId was processed recently
    if (isDuplicateEvent(event.messageId)) {
      console.log(`[InboxWatcher] Skipping duplicate event for ${event.messageId}`);
      return;
    }
    // Check if terminal should be woken up (not already working)
    if (!shouldWakeUp(event.terminal)) {
      console.log(`[InboxWatcher] ${event.terminal} is WORKING — not sending wake-up for ${event.messageId}`);
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

    console.log(`[SSE] Wake-up sent to ${event.terminal} for ${event.messageId}`);

    // Start the terminal session or inject message into running session
    try {
      const result = await startTerminalSession(event.terminal, event.messageId);
      if (result.success) {
        console.log(`[SessionStarter] ${result.message}`);
      } else {
        console.log(`[SessionStarter] Skip: ${result.message}`);
      }
    } catch (err) {
      console.error(`[SessionStarter] Error starting ${event.terminal}:`, err);
    }
  });
}

// ─── Initialization ─────────────────────────────────────────────────────────

export async function initialize(): Promise<void> {
  // Initialize TaskMessageBox (SQLite backend)
  await initTaskMessageBox();

  // Initialize vector store
  await initVectorStore();

  const count = await getDocumentCount();
  if (count === 0) {
    console.log('📚 Store empty — running initial knowledge base indexing...');
    await buildIndex();
  } else {
    console.log(
      `📚 Store has ${count} documents. POST /api/knowledge/index to re-index.`
    );
  }

  // Initialize message registry (sync with filesystem)
  await initializeRegistry();

  // Start inbox file watcher
  startInboxWatcher();
  setupInboxWatcherBridge();

  // Log existing UNREAD messages on startup
  const existingUnread = await scanExistingUnread();
  if (existingUnread.length > 0) {
    console.log(`\n📬 Found ${existingUnread.length} existing UNREAD messages:`);
    for (const msg of existingUnread) {
      console.log(`   - ${msg.terminal}: ${msg.messageId} (${msg.priority || 'normal'})`);
    }
  }
}

// ─── Start Services ─────────────────────────────────────────────────────────

export function startServices(port: number): void {
  isReady = true;
  setHealthMetrics({ ready: true, shuttingDown: false });

  console.log(`\n🚀 SpaceOS Knowledge Service on port ${port}`);
  console.log(`   GET  /health`);
  console.log(`   GET  /ready`);
  console.log(`\n   Knowledge Service:`);
  console.log(`   GET  /api/knowledge/search?q=...&topK=5`);
  console.log(`   POST /api/knowledge/search   { q, topK? }`);
  console.log(`   POST /api/knowledge/index    (re-index)`);
  console.log(`\n   Mailbox Tools:`);
  console.log(`   GET  /api/mailbox/:terminal/inbox?status=UNREAD|READ|all`);
  console.log(`   POST /api/mailbox/:terminal/inbox   (send_message)`);
  console.log(`   POST /api/mailbox/:terminal/outbox  (submit_done)`);
  console.log(`\n   Tasks:`);
  console.log(`   GET  /api/tasks/status?task_id=...`);
  console.log(`\n   Live Notifications:`);
  console.log(`   GET  /api/mailbox/:terminal/subscribe  (SSE wake-on-inbox)`);
  console.log(`\n   MCP Protocol (Claude Code):`);
  console.log(`   GET  /mcp              (server info)`);
  console.log(`   POST /mcp              (JSON-RPC: initialize, tools/list, tools/call)\n`);

  // Start Nightwatch scheduler if enabled
  if (process.env.ENABLE_NIGHTWATCH === 'true') {
    const intervalMs = parseInt(process.env.NIGHTWATCH_INTERVAL || '120000', 10);
    startNightwatchScheduler(intervalMs);
    console.log(`   ⏰ Nightwatch Scheduler: ENABLED (every ${intervalMs / 1000}s)`);
  } else {
    console.log(`   ⏰ Nightwatch Scheduler: DISABLED (set ENABLE_NIGHTWATCH=true to enable)`);
  }

  // Start Heartbeat scheduler if enabled
  if (process.env.ENABLE_HEARTBEAT === 'true') {
    const heartbeatConfig = getHeartbeatConfig();
    startHeartbeatScheduler(heartbeatConfig);
    console.log(`   💓 Heartbeat Scheduler: ENABLED (every ${heartbeatConfig.intervalMs / 60000}min)`);
  } else {
    console.log(`   💓 Heartbeat Scheduler: DISABLED (set ENABLE_HEARTBEAT=true to enable)`);
  }

  // Start Auto-Restart scheduler if enabled
  if (process.env.ENABLE_AUTO_RESTART === 'true') {
    const autoRestartConfig = getAutoRestartConfig();
    startAutoRestartScheduler(autoRestartConfig);
    const scheduleDesc = autoRestartConfig.schedule.type === 'daily'
      ? `daily at ${autoRestartConfig.schedule.hour}:${String((autoRestartConfig.schedule as any).minute ?? 0).padStart(2, '0')}`
      : `every ${(autoRestartConfig.schedule as any).hours}h`;
    console.log(`   🔄 Auto-Restart: ENABLED (${scheduleDesc})`);
  } else {
    console.log(`   🔄 Auto-Restart: DISABLED (set ENABLE_AUTO_RESTART=true to enable)`);
  }

  // Initialize inter-agent messaging
  initMessageDb();
  console.log(`   📨 Agent Messages: Database initialized`);

  // Initialize dispatch control database
  const dispatchDb = initDispatchDb();
  setProposalDb(dispatchDb);
  setWindowsDb(dispatchDb);
  const dispatchMode = getDispatchMode();
  console.log(`   🎛️ Dispatch Control: ${dispatchMode.toUpperCase()} mode`);
  const windowStats = getWindowStats();
  console.log(`   🕐 Scheduled Windows: ${windowStats.totalWindows} configured, current: ${windowStats.currentWindow || 'none'}`);

  // Start message router if enabled
  if (process.env.ENABLE_MESSAGE_ROUTER === 'true') {
    const routerIntervalMs = parseInt(process.env.MESSAGE_ROUTER_INTERVAL || '10000', 10);
    startMessageRouter(routerIntervalMs);
    console.log(`   📬 Message Router: ENABLED (every ${routerIntervalMs / 1000}s)`);
  } else {
    console.log(`   📬 Message Router: DISABLED (set ENABLE_MESSAGE_ROUTER=true to enable)`);
  }

  // Start channel coordinator if enabled
  if (process.env.ENABLE_TELEGRAM_COORDINATOR === 'true') {
    startChannelCoordinator();
    console.log(`   📡 Telegram Coordinator: ENABLED (hybrid backfill mode)`);
  } else {
    console.log(`   📡 Telegram Coordinator: DISABLED (set ENABLE_TELEGRAM_COORDINATOR=true to enable)`);
  }

  // Start system metrics collection (always enabled)
  const metricsIntervalMs = parseInt(process.env.METRICS_INTERVAL || '60000', 10);
  startMetricsScheduler(metricsIntervalMs);
  console.log(`   📊 System Metrics: ENABLED (every ${metricsIntervalMs / 1000}s)`);

  // Start Autonomous Development scheduler if enabled
  if (process.env.ENABLE_AUTONOMOUS_DEV === 'true') {
    startAutonomousDevScheduler();
    const status = getAutonomousDevStatus();
    console.log(`   🤖 Autonomous Dev: ENABLED (every 30min)`);
    console.log(`      📄 Focus file: ${status.config.focusFile}`);
    console.log(`      🔄 Cold start: ${status.config.coldStart}`);
  } else {
    console.log(`   🤖 Autonomous Dev: DISABLED (set ENABLE_AUTONOMOUS_DEV=true to enable)`);
  }

  // Start Root Monitor scheduler if enabled
  if (process.env.ENABLE_ROOT_MONITOR === 'true') {
    startRootMonitorScheduler();
    console.log(`   👁️ Root Monitor: ENABLED (every 30min)`);
  } else {
    console.log(`   👁️ Root Monitor: DISABLED (set ENABLE_ROOT_MONITOR=true to enable)`);
  }

  // Start Idea Scan scheduler if enabled
  if (process.env.ENABLE_IDEA_SCAN === 'true') {
    startIdeaScanScheduler();
    const status = getIdeaScanStatus();
    console.log(`   💡 Idea Scan: ENABLED (every 30min)`);
    console.log(`      📁 Project: ${status.config.projectPath}`);
  } else {
    console.log(`   💡 Idea Scan: DISABLED (set ENABLE_IDEA_SCAN=true to enable)`);
  }

  // Start Hourly Digest scheduler if enabled
  if (process.env.ENABLE_HOURLY_DIGEST !== 'false') {
    startHourlyDigestScheduler();
    const status = getHourlyDigestStatus();
    const nextRun = status.nextRun ? status.nextRun.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }) : 'N/A';
    console.log(`   📊 Hourly Digest: ENABLED (next: ${nextRun})`);
  } else {
    console.log(`   📊 Hourly Digest: DISABLED (set ENABLE_HOURLY_DIGEST=true to enable)`);
  }

  // Start Phase Coordinator scheduler if enabled
  if (process.env.ENABLE_PHASE_COORDINATOR === 'true') {
    startPhaseCoordinator();
    const phaseStatus = getPhaseCoordinatorStatus();
    console.log(`   📋 Phase Coordinator: ENABLED (every ${phaseStatus.config.intervalMinutes}min)`);
  }

  // Initialize multi-channel notifications
  initMultiChannel();
  const channelStatus = getMultiChannelStatus();
  const enabledChannels = Object.entries(channelStatus)
    .filter(([_, s]) => s.enabled)
    .map(([c]) => c);
  if (enabledChannels.length > 0) {
    console.log(`   📢 Multi-Channel: ${enabledChannels.join(', ')}`);
  } else {
    console.log(`   📢 Multi-Channel: No channels configured`);
  }

  // Start Telegram Response Worker (always enabled)
  startResponseWorker();

  // Start Multi-Bot Manager (ADR-049 Phase 1)
  if (process.env.ENABLE_MULTI_BOT === 'true') {
    startAllBots().then(() => {
      const botsStatus = getBotsStatus();
      const runningBots = Object.entries(botsStatus).filter(([_, s]) => s.running);
      console.log(`   🤖 Multi-Bot Manager: ENABLED (${runningBots.length} bots)`);
      for (const [name, status] of Object.entries(botsStatus)) {
        const icon = status.running ? '✅' : '❌';
        console.log(`      ${icon} @${status.username} → ${status.terminal}`);
      }
    }).catch(err => {
      console.error('   🤖 Multi-Bot Manager: FAILED to start', err);
    });
  } else {
    console.log(`   🤖 Multi-Bot Manager: DISABLED (set ENABLE_MULTI_BOT=true to enable)`);
  }
  console.log(`   📱 Telegram Response Worker: ENABLED`);

  // Auto-subscribe to all EPICS.yaml checkpoints
  const checkpointCount = subscribeToAllCheckpoints();
  if (checkpointCount > 0) {
    const status = getCheckpointSubscriptionStatus();
    const pendingCount = status.filter(s => s.status === 'pending').length;
    console.log(`   🎯 Checkpoint Subscriptions: ${checkpointCount} created (${pendingCount} pending checkpoints)`);
  } else {
    console.log(`   🎯 Checkpoint Subscriptions: No pending checkpoints`);
  }

  // Attach epic progress notifications (Telegram)
  attachEpicNotifications();
  console.log(`   📢 Epic Notifications: ENABLED (Telegram progress tracking)`);

  // Set up Telegram webhook if configured (async in background)
  const telegramWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
  (async () => {
    if (telegramWebhookUrl) {
      const webhookSuccess = await setTelegramWebhook(telegramWebhookUrl);
      console.log(`   🤖 Telegram Bot: Webhook ${webhookSuccess ? 'configured' : 'FAILED'} → ${telegramWebhookUrl}`);
    } else {
      const webhookInfo = await getWebhookInfo();
      if (webhookInfo?.url) {
        console.log(`   🤖 Telegram Bot: Webhook active → ${webhookInfo.url}`);
      } else {
        console.log(`   🤖 Telegram Bot: No webhook (set TELEGRAM_WEBHOOK_URL to enable)`);
      }
    }
  })();
  console.log('');
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

export function createGracefulShutdown(server: Server): (signal: string) => void {
  return (signal: string) => {
    console.log(`\n⏳ ${signal} received, shutting down gracefully...`);
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

    // Stop accepting new connections
    server.close(() => {
      console.log('✅ HTTP server closed');

      // Close all SSE connections
      closeAllSSEConnections();
      console.log('✅ SSE connections closed');

      console.log('👋 Goodbye!');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('⚠️ Forced exit after timeout');
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
