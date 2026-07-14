/**
 * watchConductorProgress.ts — Conductor folyamatos munka trigger
 *
 * Célja: A Conductor aktívan görgesse tovább a fejlesztési folyamatokat
 *
 * Működés:
 * 1. Ellenőrzi hogy a Conductor fut-e
 * 2. Ha fut ÉS idle (nincs friss aktivitás) → nudge küldés
 * 3. Ellenőrzi a queue-t, outbox-okat, planning pipeline-t
 * 4. Ha van feldolgozható munka → explicit prompt injection
 *
 * 2026-07-02: Conductor auto-trigger implementáció
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import {
  SPACEOS_ROOT,
  hasSession,
  sendKeys,
  sendEnter,
  capturePane,
  getState,
  setState,
  log,
  telegram,
} from './common';
import { queryMessages } from '../messageRegistry';

// ─── Config ─────────────────────────────────────────────────────────────────

const CONDUCTOR_SESSION = 'spaceos-conductor';
const CONDUCTOR_TERMINAL = 'conductor';
// PRODUCTION MODE: 30 minute intervals for steady progress
const IDLE_THRESHOLD_MINUTES = 15; // Conductor idle 15+ perc → check plans
const NUDGE_INTERVAL_MINUTES = 30; // Max 1x/30min encouragement

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConductorProgressResult {
  running: boolean;
  idle: boolean;
  nudged: boolean;
  reason?: string;
  workAvailable?: {
    queue: number;
    outbox: number;
    planning: number;
  };
}

// ─── Detect idle Conductor ──────────────────────────────────────────────────

async function isConductorIdle(): Promise<{ idle: boolean; lastActivity?: number }> {
  const stateKey = 'conductor_last_activity';
  const lastActivityStr = await getState(stateKey);

  if (!lastActivityStr) {
    // No activity recorded → assume idle
    return { idle: true };
  }

  const lastActivity = parseInt(lastActivityStr, 10);
  const now = Math.floor(Date.now() / 1000);
  const idleSeconds = now - lastActivity;
  const idleMinutes = Math.floor(idleSeconds / 60);

  return {
    idle: idleMinutes >= IDLE_THRESHOLD_MINUTES,
    lastActivity: idleMinutes,
  };
}

// ─── Check work availability ────────────────────────────────────────────────

async function checkWorkAvailable(): Promise<{
  queue: number;
  outbox: number;
  planning: number;
  total: number;
}> {
  let queue = 0;
  let outbox = 0;
  let planning = 0;

  // 1. Planning queue
  try {
    const queuePath = path.join(SPACEOS_ROOT, 'docs/planning/queue');
    const files = await fs.readdir(queuePath);
    queue = files.filter(f => f.endsWith('.md')).length;
  } catch {
    // Queue directory might not exist
  }

  // 2. Terminal outbox UNREAD (DONE/BLOCKED waiting for Conductor review)
  const terminals = ['backend', 'frontend', 'designer', 'architect', 'librarian', 'explorer'];
  for (const term of terminals) {
    try {
      const outboxPath = path.join(SPACEOS_ROOT, `terminals/${term}/outbox`);
      const files = await fs.readdir(outboxPath);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const content = await fs.readFile(path.join(outboxPath, file), 'utf-8');
        if (content.includes('status: UNREAD')) {
          outbox++;
        }
      }
    } catch {
      // Outbox might not exist
    }
  }

  // 3. Planning pipeline (ideas, selected, debate)
  const planningStages = ['ideas', 'selected', 'debate'];
  for (const stage of planningStages) {
    try {
      const stagePath = path.join(SPACEOS_ROOT, `docs/planning/${stage}`);
      const files = await fs.readdir(stagePath);
      planning += files.filter(f => f.endsWith('.md')).length;
    } catch {
      // Stage directory might not exist
    }
  }

  return {
    queue,
    outbox,
    planning,
    total: queue + outbox + planning,
  };
}

// ─── Check Monitor outbox for responses ────────────────────────────────────

async function hasRecentConductorResponse(): Promise<{ hasResponse: boolean; messageId?: string; age?: number }> {
  // Check Monitor's outbox for UNREAD messages FROM Conductor
  // These are responses that Conductor sent to Monitor
  try {
    const responses = queryMessages({
      terminal: 'monitor',
      box: 'outbox',
      status: 'UNREAD',
      fromTerminal: 'conductor',
      limit: 10,
    });

    if (responses.length === 0) {
      return { hasResponse: false };
    }

    // FIX MSG-NEXUS-025: Check if there are ANY UNREAD responses, regardless of age
    // If Monitor hasn't read the previous response yet, don't send another nudge
    const now = Date.now();
    const oldestResponse = responses[responses.length - 1];
    const oldestAge = Math.floor((now - new Date(oldestResponse.createdAt).getTime()) / (1000 * 60));

    // ANY UNREAD response exists - don't nudge again until Monitor reads it
    return {
      hasResponse: true,
      messageId: oldestResponse.messageId,
      age: oldestAge,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await log(`[WatchConductorProgress] Error checking Monitor outbox: ${errorMsg}`);
    return { hasResponse: false };
  }
}

// ─── Nudge Conductor ────────────────────────────────────────────────────────

async function nudgeConductor(work: { queue: number; outbox: number; planning: number }): Promise<boolean> {
  const nudgeKey = 'conductor_progress_nudge';
  const nudgeContentKey = 'conductor_progress_nudge_content';
  const lastNudgeStr = await getState(nudgeKey);
  const now = Math.floor(Date.now() / 1000);

  // 1. Check time since last nudge
  if (lastNudgeStr) {
    const lastNudge = parseInt(lastNudgeStr, 10);
    const elapsedMinutes = Math.floor((now - lastNudge) / 60);

    if (elapsedMinutes < NUDGE_INTERVAL_MINUTES) {
      // Too soon since last nudge
      return false;
    }
  }

  // 2. Check if Conductor already responded (FIXED MSG-NEXUS-025)
  const responseCheck = await hasRecentConductorResponse();
  if (responseCheck.hasResponse) {
    // Conductor already responded, don't send another nudge
    await log(
      `[WatchConductorProgress] Skipping nudge - Conductor response exists (${responseCheck.messageId}, ${responseCheck.age} min ago)`
    );
    return false;
  }

  // Build encouragement message focused on JoineryTech progress
  const workSummary: string[] = [];
  if (work.queue > 0) workSummary.push(`queue: ${work.queue}`);
  if (work.outbox > 0) workSummary.push(`outbox DONE: ${work.outbox}`);
  if (work.planning > 0) workSummary.push(`planning: ${work.planning}`);

  const nudgeMsg = `
🚀 Monitor → Conductor: 30-perces JoineryTech progress check

Folytatható munka észlelve: ${workSummary.join(' | ')}

**Feladat:**
1. **Írd meg a jelenlegi terveidet** (mik a következő lépések?)
2. **Folytasd a JoineryTech fejlesztést** (HR, Maintenance, QA, DMS modulok)
3. **Küldd a terveket Monitor outbox-ba** ha kész vagy

Prioritások: JoineryTech backend implementáció (Week 1-2 Domain/Application)
`.trim();

  // 3. Check message content deduplication (NEW MSG-NEXUS-025)
  const lastNudgeContent = await getState(nudgeContentKey);
  if (lastNudgeContent === nudgeMsg) {
    await log(
      `[WatchConductorProgress] Skipping nudge - same message content as last nudge`
    );
    return false;
  }

  await sendKeys(CONDUCTOR_SESSION, nudgeMsg);
  await new Promise(r => setTimeout(r, 500));
  await sendEnter(CONDUCTOR_SESSION);
  await new Promise(r => setTimeout(r, 1000));
  await sendEnter(CONDUCTOR_SESSION);

  await setState(nudgeKey, String(now));
  await setState(nudgeContentKey, nudgeMsg);
  await log(`[WatchConductorProgress] 30-min encouragement sent: ${workSummary.join(', ')}`);

  return true;
}

// ─── Update Conductor activity ──────────────────────────────────────────────

async function updateConductorActivity(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await setState('conductor_last_activity', String(now));
}

// ─── Main watcher ───────────────────────────────────────────────────────────

export async function watchConductorProgress(): Promise<ConductorProgressResult> {
  const result: ConductorProgressResult = {
    running: false,
    idle: false,
    nudged: false,
  };

  // 1. Check if Conductor session is running
  const sessionRunning = await hasSession(CONDUCTOR_SESSION);
  result.running = sessionRunning;

  if (!sessionRunning) {
    // Conductor not running - watchPriority will handle auto-start
    result.reason = 'Session not running (watchPriority handles start)';
    return result;
  }

  // 2. Check if Conductor is idle
  const idleCheck = await isConductorIdle();
  result.idle = idleCheck.idle;

  if (!idleCheck.idle) {
    // Conductor is active - no need to nudge
    result.reason = `Active (last activity: ${idleCheck.lastActivity} min ago)`;
    return result;
  }

  // 3. Check if there's work available
  const work = await checkWorkAvailable();
  result.workAvailable = work;

  if (work.total === 0) {
    // No work available - Conductor can idle
    result.reason = 'No work available (idle OK)';
    return result;
  }

  // 4. Work available + Conductor idle → nudge
  const nudged = await nudgeConductor(work);
  result.nudged = nudged;

  if (nudged) {
    result.reason = `30-min encouragement: ${work.queue} queue, ${work.outbox} outbox, ${work.planning} planning`;
    await telegram(`🚀 *Monitor → Conductor: 30-min JoineryTech Check*\n\`\`\`\nQueue: ${work.queue}\nOutbox DONE: ${work.outbox}\nPlanning: ${work.planning}\n\nConductor encouraged to continue JoineryTech work\n\`\`\``);
  } else {
    result.reason = 'Encouragement throttled (too soon since last check)';
  }

  return result;
}

// ─── Activity tracker (called by other watchers) ───────────────────────────

/**
 * Call this from watchInbox, watchDone, etc. when Conductor processes something
 * This prevents unnecessary nudges when Conductor is actively working
 */
export async function trackConductorActivity(): Promise<void> {
  await updateConductorActivity();
}

// ─── Standalone execution ───────────────────────────────────────────────────

if (require.main === module) {
  watchConductorProgress().then(result => {
    console.log('[WatchConductorProgress] Result:', JSON.stringify(result, null, 2));
  });
}
