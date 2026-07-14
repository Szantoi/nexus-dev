// Pipeline Module Index
// TypeScript equivalents of bash pipeline scripts

// Core utilities
export * from './common';

// Session watchers
export * from './watchPriority';
export * from './watchDone';
export * from './watchStuck';
export * from './watchIdle';
export * from './watchInbox';

// Review and post-processing
export * from './reviewer';
export * from './terminalReviewer';
export * from './pipeline';

// Planning pipeline (scan → select → debate → consensus)
export * from './planConfig';
export * from './planScan';
export * from './planSelect';
export * from './planDebate';

// Support pipelines
export * from './pipelineConfig';
export * from './pipelineDocs';
export * from './cronLibrarian';

// Main dispatcher
export * from './nightwatch';

// Event bus for real-time streaming
export * from './eventBus';

// Marveen-inspired modules
export * from './paneState';
export * from './autoRestart';
export * from './heartbeat';
export * from './processLock';
export * from './pendingRetries';
export * from './memoryStore';
export * from './hybridSearch';
export * from './skillFactory';
export * from './missionControl';

// Inter-agent messaging
export * from './agentMessages';
export * from './messageRouter';
export * from './teamTrust';
export * from './channelCoordinator';

// Multi-channel notifications
export * from './channelProvider';

// Telegram Bot (webhook handler)
export * from './telegramBot';

// System metrics and monitoring
export * from './systemMetrics';

// Autonomous development (Marveen-inspired continuous dev)
export * from './autonomousDev';

// Root monitoring (hourly quality checks)
export * from './rootMonitor';

// Idea scanning (UI prototype to planning ideas)
export * from './ideaScan';

// Phase coordination (project status -> conductor notification)
export * from './phaseCoordinator';

// Project automation (TASKS.yaml → auto-dispatch)
export * from './projectDispatcher';

// Hourly digest (autonomous dev summary)
export * from './hourlyDigest';
