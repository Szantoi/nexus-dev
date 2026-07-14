// Nightwatch - TypeScript equivalent of nightwatch.sh
// Main dispatcher that runs all watch modules
// 2026-06-24: Integrated with event bus for real-time SSE streaming

import { watchPriority } from './watchPriority';
import { watchDone, watchFrontendUiDone } from './watchDone';
import { watchStuck } from './watchStuck';
import { watchIdle } from './watchIdle';
import { watchMcpHeartbeat } from './watchMcpHeartbeat';
import { runWatchInbox } from './watchInbox';
import { watchQueue } from './watchQueue';
import { watchResponse } from './watchResponse';
import { runAlertRules } from './alertRules';
import { watchMonitor } from './watchMonitor';
import { watchTaskEscalations } from './taskEscalation';
import { watchGoals } from './watchGoals';
import { watchConductorProgress } from './watchConductorProgress';
import { log, telegram } from './common';
import { emitNightwatchCycle, pipelineEvents } from './eventBus';
import { NWT_MS } from '../constants/nwt';

// Goal Persistence Phase 3: Context Saturation Detection (2026-07-04)
import { checkContextSaturation, incrementTurnCount } from '../conductor/contextSaturation';

export interface NightwatchResult {
  timestamp: string;
  priority: { checked: number; started: string[] };
  done: { found: number; triggered: string[] };
  frontendUiDone: { found: number; triggered: string[] };  // UI Review Loop (2026-07-11)
  stuck: { processed: number; nudged: Array<{ session: string; reason: string }> };
  inbox: { nudged: string[]; autoStarted: string[]; skipped: string[] };
  queue: { checked: number; dispatched: string[]; skipped: string[] };
  response: { found: number; routed: string[]; skipped: string[] };
  idle: { processed: number; shutdown: number };
  mcpHeartbeat: { processed: number; nudged: Array<{ session: string; terminal: string; reason: string }> };
  monitor: { triggered: boolean; reason: string };
  escalation: { checked: number; retried: number; escalated: number };
  goals: { checked: number; triggered: string[]; expired: string[]; errors: string[] };
  conductorProgress: { running: boolean; idle: boolean; nudged: boolean; reason?: string };
  durationMs: number;
}

export async function runNightwatch(): Promise<NightwatchResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  await log('Nightwatch ciklus indult');

  // 1. Priority sessions first
  const priorityResult = await watchPriority();

  // 2. DONE processing
  const doneResult = await watchDone();

  // 2.5. Frontend UI DONE → Designer review trigger (MCP-based, replaces watch-ui-review.sh)
  const frontendUiDoneResult = await watchFrontendUiDone();

  // 3. Stuck detection
  const stuckResult = await watchStuck();

  // 4. Inbox detection - auto-start/nudge terminals with UNREAD messages
  const inboxResult = await runWatchInbox();

  // 5. Queue dispatch - nudge Conductor if queued tasks waiting
  const queueResult = await watchQueue();

  // 6. Response routing - route outbox responses to target terminals (ISSUE-006)
  const responseResult = await watchResponse();

  // 7. Idle shutdown last
  const idleResult = await watchIdle();

  // 8. MCP heartbeat - detect sessions without MCP registration
  const mcpHeartbeatResult = await watchMcpHeartbeat();

  // 9. Alert rules - critical state detection
  await runAlertRules();

  // 10. Monitor terminal - health check every 5th cycle (10 min)
  const monitorResult = await watchMonitor();

  // 11. Task Escalation - check expired subscriptions, retry or escalate
  const escalationResult = await watchTaskEscalations();

  // 12. Goals (ADR-059) - Monitor-Driven Goal Progression
  // Checks all watching goals for completion criteria
  // When criteria are met, triggers target terminal (usually Conductor)
  const goalsResult = await watchGoals();

  // 13. Conductor Progress Encouragement (30-minute interval)
  // Monitor encourages Conductor to continue JoineryTech development every 30 minutes
  // Conductor shares plans and Monitor provides encouragement
  const conductorProgressResult = await watchConductorProgress();

  // 14. Context Saturation Detection - check Conductor turn count, auto re-anchor if >50
  // Increment turn count each cycle (approximation: 1 nightwatch cycle ≈ 2-3 Conductor turns)
  incrementTurnCount();
  const saturationResult = checkContextSaturation();
  if (saturationResult === 'reanchored') {
    await log('[Nightwatch] ✓ Context saturation detected, auto re-anchoring injected');
  }

  const durationMs = Date.now() - startTime;

  const result: NightwatchResult = {
    timestamp,
    priority: priorityResult,
    done: doneResult,
    frontendUiDone: frontendUiDoneResult,
    stuck: stuckResult,
    inbox: inboxResult,
    queue: queueResult,
    response: responseResult,
    idle: idleResult,
    mcpHeartbeat: mcpHeartbeatResult,
    monitor: monitorResult,
    escalation: escalationResult,
    goals: goalsResult,
    conductorProgress: conductorProgressResult,
    durationMs,
  };

  // Emit event for SSE streaming
  emitNightwatchCycle(result as unknown as Record<string, unknown>);

  await log(`Nightwatch kész: ${durationMs}ms`);

  return result;
}

// Scheduled runner - runs every 1 NWT (2 minutes)
let intervalId: NodeJS.Timeout | null = null;

export function startNightwatchScheduler(intervalMs = NWT_MS): void {
  if (intervalId) {
    console.log('[Nightwatch] Scheduler already running');
    return;
  }

  console.log(`[Nightwatch] Scheduler starting (interval: ${intervalMs}ms)`);

  // Run immediately
  runNightwatch()
    .then(result => console.log('[Nightwatch] Initial run complete'))
    .catch(err => console.error('[Nightwatch] Initial run error:', err));

  // Then run on interval
  intervalId = setInterval(async () => {
    try {
      const result = await runNightwatch();

      // Log summary
      const summary = [
        `priority:${result.priority.started.length}`,
        `done:${result.done.triggered.length}`,
        `stuck:${result.stuck.nudged.length}`,
        `inbox:${result.inbox.nudged.length}+${result.inbox.autoStarted.length}`,
        `queue:${result.queue.dispatched.length}`,
        `response:${result.response.routed.length}`,
        `idle:${result.idle.shutdown}`,
        `mcp:${result.mcpHeartbeat.nudged.length}`,
        `goals:${result.goals.triggered.length}/${result.goals.checked}`,
      ].join(' ');

      console.log(`[Nightwatch] ${summary} (${result.durationMs}ms)`);
    } catch (err) {
      console.error('[Nightwatch] Cycle error:', err);
    }
  }, intervalMs);
}

export function stopNightwatchScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Nightwatch] Scheduler stopped');
  }
}

// Run standalone
if (require.main === module) {
  runNightwatch().then(result => {
    console.log('\n=== Nightwatch Results ===');
    console.log(`Timestamp: ${result.timestamp}`);
    console.log(`Duration: ${result.durationMs}ms`);
    console.log('\nPriority:');
    console.log(`  Checked: ${result.priority.checked}`);
    console.log(`  Started: ${result.priority.started.join(', ') || 'none'}`);
    console.log('\nDone:');
    console.log(`  Found: ${result.done.found}`);
    console.log(`  Triggered: ${result.done.triggered.join(', ') || 'none'}`);
    console.log('\nStuck:');
    console.log(`  Processed: ${result.stuck.processed}`);
    console.log(`  Nudged: ${result.stuck.nudged.map(n => `${n.session}(${n.reason})`).join(', ') || 'none'}`);
    console.log('\nIdle:');
    console.log(`  Processed: ${result.idle.processed}`);
    console.log(`  Shutdown: ${result.idle.shutdown}`);
  });
}
