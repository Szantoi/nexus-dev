// watchQueue.ts - Queued task dispatch trigger
// 2026-07-01: ISSUE-007 fix - Conductor nem kap triggert queued task dispatch-ra
//
// Ellenőrzi a focus queue-t és nudge-olja a Conductort ha:
// 1. Van queued task
// 2. A target terminál idle
// 3. Conductor nincs éppen busy

import {
  hasSession,
  sendKeys,
  sendEnter,
  getState,
  setState,
  log,
} from './common';
import { getStatus } from '../terminalStatus';

const QUEUE_CHECK_COOLDOWN = 300; // 5 perc cooldown ugyanarra a task-ra

interface FocusQueueItem {
  id: string;
  terminal: string;
  title: string;
  priority: string;
  status: 'queued' | 'active' | 'done' | 'blocked';
}

interface FocusQueueResponse {
  activeTask?: {
    id: string;
    terminal: string;
    title: string;
  };
  queue: FocusQueueItem[];
}

async function getFocusQueue(): Promise<FocusQueueResponse | null> {
  try {
    const response = await fetch('http://localhost:3456/api/focus-queue');
    if (!response.ok) return null;
    return await response.json() as FocusQueueResponse;
  } catch {
    return null;
  }
}

function isTerminalIdle(terminal: string): boolean {
  try {
    const status = getStatus(terminal);
    return !status || status.state === 'idle';
  } catch {
    return true; // Ha nem tudjuk, feltételezzük hogy idle
  }
}

function isConductorBusy(): boolean {
  try {
    const status = getStatus('conductor');
    return status?.state === 'working';
  } catch {
    return false;
  }
}

export async function watchQueue(): Promise<{
  checked: number;
  dispatched: string[];
  skipped: string[];
}> {
  const now = Math.floor(Date.now() / 1000);
  const dispatched: string[] = [];
  const skipped: string[] = [];

  // 1. Focus queue lekérése
  const focusQueue = await getFocusQueue();
  if (!focusQueue) {
    return { checked: 0, dispatched, skipped };
  }

  // 2. Queued task-ok szűrése
  const queuedTasks = focusQueue.queue.filter(t => t.status === 'queued');

  if (queuedTasks.length === 0) {
    return { checked: 0, dispatched, skipped };
  }

  // 3. Conductor ellenőrzése
  const conductorBusy = isConductorBusy();
  const conductorSession = await hasSession('spaceos-conductor');

  if (!conductorSession) {
    await log('[watchQueue] Conductor session nem fut - skip');
    return { checked: queuedTasks.length, dispatched, skipped: queuedTasks.map(t => t.id) };
  }

  if (conductorBusy) {
    await log('[watchQueue] Conductor busy - skip');
    return { checked: queuedTasks.length, dispatched, skipped: queuedTasks.map(t => t.id) };
  }

  // 4. Minden queued task-ra ellenőrzés
  for (const task of queuedTasks) {
    const stateKey = `watchQueue_${task.id}`;
    const lastCheck = await getState(stateKey);

    // Cooldown ellenőrzés
    if (lastCheck) {
      const elapsed = now - parseInt(lastCheck, 10);
      if (elapsed < QUEUE_CHECK_COOLDOWN) {
        skipped.push(task.id);
        continue;
      }
    }

    // Target terminál idle?
    const terminalIdle = isTerminalIdle(task.terminal);
    if (!terminalIdle) {
      skipped.push(task.id);
      continue;
    }

    // Nudge Conductor with timestamp
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const nudgeMsg = `[${timestamp}] [QUEUE] Queued task vár dispatch-ra:
- Task: ${task.id}
- Terminal: ${task.terminal}
- Title: ${task.title}
- Priority: ${task.priority}

Kérlek dispatch-old ki a feladatot a ${task.terminal} terminálnak.`;

    await sendKeys('spaceos-conductor', nudgeMsg);
    await new Promise(r => setTimeout(r, 300));
    await sendEnter('spaceos-conductor');

    await setState(stateKey, String(now));
    dispatched.push(task.id);

    await log(`[watchQueue] Conductor nudge: ${task.id} → ${task.terminal}`);

    // Csak egy task-ot dispatch-olunk ciklusonként
    break;
  }

  return {
    checked: queuedTasks.length,
    dispatched,
    skipped
  };
}

// Standalone futtatás
if (require.main === module) {
  watchQueue().then(result => {
    console.log(`[watchQueue] Checked: ${result.checked}, Dispatched: ${result.dispatched.join(', ') || 'none'}, Skipped: ${result.skipped.join(', ') || 'none'}`);
  });
}
