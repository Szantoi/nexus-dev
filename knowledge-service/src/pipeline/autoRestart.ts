/**
 * auto-restart.ts — "Nightly Dream Consolidation"
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Purpose: Prevent context window bloat and resource leaks
 * by periodically restarting Claude Code sessions.
 *
 * Two scheduling modes:
 * - daily: Restart at a specific hour (e.g., 03:00)
 * - interval: Restart every N hours
 *
 * Two restart modes:
 * - fresh: Clean restart, discard context
 * - continue: Restart process but preserve conversation
 */

import {
  SESSIONS,
  SESSION_WORKDIR,
  PRIORITY_SESSIONS,
  hasSession,
  killSession,
  newSession,
  sendKeys,
  sendEnter,
  getState,
  setState,
  log,
  telegram,
} from './common';
import { detectPaneState } from './paneState';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RestartSchedule =
  | { type: 'daily'; hour: number; minute?: number }
  | { type: 'interval'; hours: number };

export type RestartMode = 'fresh' | 'continue';

export interface AutoRestartConfig {
  enabled: boolean;
  schedule: RestartSchedule;
  mode: RestartMode;
  skipIfBusy: boolean;
  maxRetries: number;
}

export interface RestartResult {
  session: string;
  restarted: boolean;
  reason: string;
  mode?: RestartMode;
  timestamp: string;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AutoRestartConfig = {
  enabled: process.env.ENABLE_AUTO_RESTART === 'true',
  schedule: { type: 'daily', hour: 3, minute: 0 },
  mode: 'fresh',
  skipIfBusy: true,
  maxRetries: 2,
};

// ─── Scheduling Logic ────────────────────────────────────────────────────────

/**
 * Check if it's time for a restart based on schedule
 */
function isRestartTime(schedule: RestartSchedule): boolean {
  const now = new Date();

  if (schedule.type === 'daily') {
    const targetHour = schedule.hour;
    const targetMinute = schedule.minute ?? 0;
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Match within a 5-minute window
    return (
      currentHour === targetHour &&
      currentMinute >= targetMinute &&
      currentMinute < targetMinute + 5
    );
  }

  // Interval-based: this will be checked against last restart time
  return true;
}

/**
 * Check if restart already happened today (for daily mode)
 */
async function alreadyRestartedToday(session: string): Promise<boolean> {
  const lastRestart = await getState(`${session}_last_restart`);
  if (!lastRestart) return false;

  const lastDate = new Date(lastRestart);
  const now = new Date();

  return (
    lastDate.getFullYear() === now.getFullYear() &&
    lastDate.getMonth() === now.getMonth() &&
    lastDate.getDate() === now.getDate()
  );
}

/**
 * Check if enough time has passed for interval mode
 */
async function intervalElapsed(session: string, hours: number): Promise<boolean> {
  const lastRestart = await getState(`${session}_last_restart`);
  if (!lastRestart) return true; // Never restarted, proceed

  const lastDate = new Date(lastRestart);
  const now = new Date();
  const elapsedMs = now.getTime() - lastDate.getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  return elapsedHours >= hours;
}

// ─── Restart Actions ─────────────────────────────────────────────────────────

/**
 * Perform a fresh restart (kill and recreate session)
 */
async function freshRestart(session: string): Promise<void> {
  const workdir = SESSION_WORKDIR[session] || (process.env.SPACEOS_ROOT || '/opt/spaceos');
  const terminal = SESSIONS[session];

  await log(`[AutoRestart] Fresh restart: ${session}`);

  // Kill existing session
  await killSession(session);

  // Wait for cleanup
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Create new session
  await newSession(session, workdir);

  // Wait for session to initialize
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Start Claude with appropriate model
  const model = PRIORITY_SESSIONS.includes(session) ? 'sonnet' : 'haiku';
  await sendKeys(session, `claude --model ${model}`);
  await sendEnter(session);

  await log(`[AutoRestart] Fresh restart complete: ${session} (model: ${model})`);
}

/**
 * Perform a continue restart (send /compact command)
 */
async function continueRestart(session: string): Promise<void> {
  await log(`[AutoRestart] Continue restart: ${session}`);

  // Send /compact to reduce context while preserving conversation
  await sendKeys(session, '/compact');
  await sendEnter(session);

  // Wait for command to process
  await new Promise((resolve) => setTimeout(resolve, 3000));

  await log(`[AutoRestart] Continue restart complete: ${session}`);
}

// ─── Main Functions ──────────────────────────────────────────────────────────

/**
 * Check and restart a single session if needed
 */
export async function checkAndRestart(
  session: string,
  config: AutoRestartConfig = DEFAULT_CONFIG
): Promise<RestartResult> {
  const timestamp = new Date().toISOString();

  // Disabled
  if (!config.enabled) {
    return { session, restarted: false, reason: 'Auto-restart disabled', timestamp };
  }

  // Session doesn't exist
  const exists = await hasSession(session);
  if (!exists) {
    return { session, restarted: false, reason: 'Session not found', timestamp };
  }

  // Check schedule
  if (!isRestartTime(config.schedule)) {
    return { session, restarted: false, reason: 'Not restart time', timestamp };
  }

  // Check if already restarted (daily mode)
  if (config.schedule.type === 'daily') {
    if (await alreadyRestartedToday(session)) {
      return { session, restarted: false, reason: 'Already restarted today', timestamp };
    }
  }

  // Check interval elapsed (interval mode)
  if (config.schedule.type === 'interval') {
    if (!(await intervalElapsed(session, config.schedule.hours))) {
      return { session, restarted: false, reason: 'Interval not elapsed', timestamp };
    }
  }

  // Skip if busy
  if (config.skipIfBusy) {
    const state = await detectPaneState(session);
    if (state.state === 'busy') {
      return { session, restarted: false, reason: 'Session busy, skipping', timestamp };
    }
  }

  // Perform restart
  try {
    if (config.mode === 'fresh') {
      await freshRestart(session);
    } else {
      await continueRestart(session);
    }

    // Record restart time
    await setState(`${session}_last_restart`, timestamp);

    return {
      session,
      restarted: true,
      reason: `${config.mode} restart successful`,
      mode: config.mode,
      timestamp,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await log(`[AutoRestart] Error restarting ${session}: ${errorMsg}`);
    return { session, restarted: false, reason: `Restart failed: ${errorMsg}`, timestamp };
  }
}

/**
 * Check and restart all priority sessions
 */
export async function checkAndRestartAll(
  config: AutoRestartConfig = DEFAULT_CONFIG
): Promise<RestartResult[]> {
  const results: RestartResult[] = [];

  for (const session of PRIORITY_SESSIONS) {
    const result = await checkAndRestart(session, config);
    results.push(result);

    // Small delay between restarts
    if (result.restarted) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  // Log summary
  const restarted = results.filter((r) => r.restarted);
  if (restarted.length > 0) {
    const sessions = restarted.map((r) => SESSIONS[r.session] || r.session).join(', ');
    await log(`[AutoRestart] Restarted ${restarted.length} sessions: ${sessions}`);
    await telegram(`🔄 Auto-restart: ${sessions} (${config.mode} mode)`);
  }

  return results;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let restartInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the auto-restart scheduler
 * Checks every 5 minutes if it's time for a restart
 */
export function startAutoRestartScheduler(config: AutoRestartConfig = DEFAULT_CONFIG): void {
  if (!config.enabled) {
    console.log('[AutoRestart] Scheduler disabled');
    return;
  }

  // Check every 5 minutes
  const checkIntervalMs = 5 * 60 * 1000;

  restartInterval = setInterval(async () => {
    try {
      await checkAndRestartAll(config);
    } catch (error) {
      console.error('[AutoRestart] Scheduler error:', error);
    }
  }, checkIntervalMs);

  const scheduleDesc =
    config.schedule.type === 'daily'
      ? `daily at ${config.schedule.hour}:${String(config.schedule.minute ?? 0).padStart(2, '0')}`
      : `every ${config.schedule.hours} hours`;

  console.log(`[AutoRestart] Scheduler started: ${scheduleDesc} (${config.mode} mode)`);
}

/**
 * Stop the auto-restart scheduler
 */
export function stopAutoRestartScheduler(): void {
  if (restartInterval) {
    clearInterval(restartInterval);
    restartInterval = null;
    console.log('[AutoRestart] Scheduler stopped');
  }
}

/**
 * Get the default config (for external use)
 */
export function getDefaultConfig(): AutoRestartConfig {
  return { ...DEFAULT_CONFIG };
}
