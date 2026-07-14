/**
 * HTTP Routes Index
 * Exports all route modules for use in the main server
 */

// Core routes
export { default as healthRoutes, setHealthMetrics, getHealthState } from './health.routes';
export { default as pipelineRoutes, getPipelineClientCount } from './pipeline.routes';

// Dispatch Control routes
export { default as controlRoutes } from './control.routes';

// Task management routes
export { default as taskRoutes } from './task.routes';

// Mailbox routes (inbox, outbox, SSE)
export {
  default as mailboxRoutes,
  mailboxEvents,
  closeAllSSEConnections,
  getSSEClientCount,
} from './mailbox.routes';

// Session management routes
export { default as sessionRoutes } from './session.routes';

// Terminal status routes
export { default as terminalRoutes } from './terminal.routes';

// Knowledge service routes
export { default as knowledgeRoutes } from './knowledge.routes';

// Memory tier routes (ADR-046)
export { default as memoryRoutes } from './memory.routes';

// Daily digest routes (ADR-046)
export { default as digestRoutes } from './digest.routes';

// Auth routes
export { default as authRoutes } from './auth.routes';

// Dashboard routes
export { default as dashboardRoutes } from './dashboard.routes';

// Message Registry routes
export { default as registryRoutes } from './registry.routes';

// Kanban routes
export { default as kanbanRoutes } from './kanban.routes';

// Projects routes
export { default as projectsRoutes } from './projects.routes';

// Agent Messages routes
export { default as agentMessagesRoutes } from './agent-messages.routes';

// Channels routes
export { default as channelsRoutes } from './channels.routes';

// Epic Router routes (2026-06-24)
export { default as epicRouterRoutes } from './epic-router.routes';

// Cost Monitoring routes (2026-07-04 - MSG-BACKEND-126)
export { default as costMonitoringRoutes } from './costMonitoringRoutes';
