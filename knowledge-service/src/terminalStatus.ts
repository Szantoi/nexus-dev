/**
 * Terminal Status Tracker
 *
 * Tracks whether terminals are idle or working to avoid
 * disturbing active sessions with wake-up notifications.
 *
 * Also tracks focus queue - priority list of tasks being worked on.
 *
 * Now uses terminalConfig.ts for terminal definitions.
 * 2026-06-24: Optimized to use messageRegistry DB for UNREAD counts.
 */

import { resolveTerminal, getTerminal, getTerminalPath, TERMINALS_DIR_PATH } from './terminalConfig';
import * as terminalsConfig from './config/terminals';
import { getUnreadMessages } from './messageRegistry';

export type TerminalState = 'idle' | 'working';

interface TerminalInfo {
  state: TerminalState;
  lastActivity: Date;
  currentTask?: string;
}

// ─── Focus Queue (Conductor's priority list) ─────────────────────────────────

export interface FocusItem {
  id: string;           // Task/message ID (e.g., "MSG-BACKEND-042")
  terminal: string;     // Target terminal
  title: string;        // Short description
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'queued' | 'active' | 'blocked' | 'done';
  addedAt: Date;
  startedAt?: Date;
  blockedReason?: string;
}

// In-memory focus queue (persisted to file)
let focusQueue: FocusItem[] = [];
let activeTaskId: string | null = null;

// In-memory terminal status (could be persisted to file if needed)
const terminalStatus: Map<string, TerminalInfo> = new Map();

// Idle timeout: if no heartbeat for 10 minutes, consider idle
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Register terminal as working (starting a task)
 */
export function registerWorking(terminal: string, taskId?: string): void {
  terminalStatus.set(terminal, {
    state: 'working',
    lastActivity: new Date(),
    currentTask: taskId,
  });
  console.log(`[TerminalStatus] ${terminal} -> WORKING${taskId ? ` (${taskId})` : ''}`);
}

/**
 * Register terminal as idle (finished task or session ended)
 */
export function registerIdle(terminal: string): void {
  const existing = terminalStatus.get(terminal);
  terminalStatus.set(terminal, {
    state: 'idle',
    lastActivity: new Date(),
    currentTask: undefined,
  });
  if (existing?.state === 'working') {
    console.log(`[TerminalStatus] ${terminal} -> IDLE`);
  }
}

/**
 * Update heartbeat (terminal is still active)
 */
export function heartbeat(terminal: string): void {
  const existing = terminalStatus.get(terminal);
  if (existing) {
    existing.lastActivity = new Date();
  } else {
    // First heartbeat, assume working
    registerWorking(terminal);
  }
}

/**
 * Check if terminal is currently working
 */
export function isWorking(terminal: string): boolean {
  const info = terminalStatus.get(terminal);
  if (!info) return false;

  // Check if timed out (no activity for IDLE_TIMEOUT_MS)
  const now = new Date();
  const elapsed = now.getTime() - info.lastActivity.getTime();
  if (elapsed > IDLE_TIMEOUT_MS) {
    // Auto-transition to idle
    info.state = 'idle';
    info.currentTask = undefined;
    console.log(`[TerminalStatus] ${terminal} -> IDLE (timeout)`);
    return false;
  }

  return info.state === 'working';
}

/**
 * Check if terminal should receive wake-up notification
 * Returns true if terminal is idle and should be woken up
 */
export function shouldWakeUp(terminal: string): boolean {
  return !isWorking(terminal);
}

/**
 * Get status of all terminals
 */
export function getAllStatus(): Record<string, TerminalInfo & { terminal: string }> {
  const result: Record<string, TerminalInfo & { terminal: string }> = {};
  for (const [terminal, info] of terminalStatus.entries()) {
    // Update state based on timeout
    isWorking(terminal); // This will auto-transition if needed
    result[terminal] = { ...info, terminal };
  }
  return result;
}

/**
 * Get single terminal status
 */
export function getStatus(terminal: string): TerminalInfo | null {
  const info = terminalStatus.get(terminal);
  if (!info) return null;
  // Update state based on timeout
  isWorking(terminal);
  return info;
}

/**
 * Get full terminal status with tmux capture and inbox/outbox counts
 * This is the Conductor's HIGH priority request (#2)
 */
export async function getFullTerminalStatus(terminal: string): Promise<{
  terminal: string;
  sessionRunning: boolean;
  state: TerminalState;
  lastActivity: Date | null;
  currentTask: string | null;
  tmuxCapture: string | null;
  unreadInbox: number;
  unreadOutbox: number;
}> {
  const { execSync } = await import('child_process');
  const fs = await import('fs/promises');
  const path = await import('path');

  const TMUX_SOCKET = terminalsConfig.getTmuxSocket();

  // Resolve alias to canonical name
  const canonical = resolveTerminal(terminal) || terminal;
  const terminalDef = getTerminal(canonical);
  const sessionName = terminalDef?.session || `spaceos-${canonical}`;
  const terminalPath = getTerminalPath(canonical) || path.join(TERMINALS_DIR_PATH, canonical);

  // Get existing status
  const info = getStatus(terminal);

  // Check if tmux session is running
  let sessionRunning = false;
  let tmuxCapture: string | null = null;

  try {
    execSync(`tmux -S ${TMUX_SOCKET} has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
    sessionRunning = true;

    // Capture last 15 lines of the pane
    try {
      tmuxCapture = execSync(`tmux -S ${TMUX_SOCKET} capture-pane -t ${sessionName} -p | tail -15`, {
        timeout: 3000,
        encoding: 'utf-8'
      }).trim();
    } catch {
      tmuxCapture = null;
    }
  } catch {
    sessionRunning = false;
  }

  // Count unread inbox/outbox messages using DB query (O(1) instead of O(n) file reads)
  let unreadInbox = 0;
  let unreadOutbox = 0;
  try {
    unreadInbox = getUnreadMessages(canonical, 'inbox').length;
    unreadOutbox = getUnreadMessages(canonical, 'outbox').length;
  } catch {
    // DB not ready, fallback to 0
  }

  return {
    terminal: canonical,
    sessionRunning,
    state: info?.state || 'idle',
    lastActivity: info?.lastActivity || null,
    currentTask: info?.currentTask || null,
    tmuxCapture,
    unreadInbox,
    unreadOutbox,
  };
}

// ─── Focus Queue API ─────────────────────────────────────────────────────────

/**
 * Set the entire focus queue (replaces existing)
 * Called by Conductor to define priority order
 */
export function setFocusQueue(items: Omit<FocusItem, 'addedAt'>[]): void {
  focusQueue = items.map(item => ({
    ...item,
    addedAt: new Date(),
  }));
  // Set first non-done item as active if none is active
  if (!activeTaskId) {
    const firstQueued = focusQueue.find(i => i.status === 'queued');
    if (firstQueued) {
      activeTaskId = firstQueued.id;
      firstQueued.status = 'active';
      firstQueued.startedAt = new Date();
    }
  }
  console.log(`[FocusQueue] Set ${focusQueue.length} items, active: ${activeTaskId || 'none'}`);
}

/**
 * Add item to focus queue
 */
export function addFocusItem(item: Omit<FocusItem, 'addedAt' | 'status'>): void {
  const existing = focusQueue.find(i => i.id === item.id);
  if (existing) {
    // Update existing
    Object.assign(existing, item);
    console.log(`[FocusQueue] Updated: ${item.id}`);
  } else {
    focusQueue.push({
      ...item,
      status: 'queued',
      addedAt: new Date(),
    });
    console.log(`[FocusQueue] Added: ${item.id} (${item.priority})`);
  }
  // Sort by priority
  sortFocusQueue();
}

/**
 * Set active task (what we're working on NOW)
 */
export function setActiveTask(taskId: string): void {
  // Mark previous active as queued
  const prevActive = focusQueue.find(i => i.status === 'active');
  if (prevActive && prevActive.id !== taskId) {
    prevActive.status = 'queued';
  }

  // Find and activate new task
  const task = focusQueue.find(i => i.id === taskId);
  if (task) {
    task.status = 'active';
    task.startedAt = new Date();
    activeTaskId = taskId;
    console.log(`[FocusQueue] Active: ${taskId} - ${task.title}`);
  } else {
    activeTaskId = taskId;
    console.log(`[FocusQueue] Active: ${taskId} (not in queue)`);
  }
}

/**
 * Mark task as blocked
 */
export function setTaskBlocked(taskId: string, reason: string): void {
  const task = focusQueue.find(i => i.id === taskId);
  if (task) {
    task.status = 'blocked';
    task.blockedReason = reason;
    console.log(`[FocusQueue] Blocked: ${taskId} - ${reason}`);
  }
  if (activeTaskId === taskId) {
    // Move to next queued task
    const next = focusQueue.find(i => i.status === 'queued');
    if (next) {
      setActiveTask(next.id);
    } else {
      activeTaskId = null;
    }
  }
}

/**
 * Mark task as done
 */
export function setTaskDone(taskId: string): void {
  const task = focusQueue.find(i => i.id === taskId);
  if (task) {
    task.status = 'done';
    console.log(`[FocusQueue] Done: ${taskId}`);
  }
  if (activeTaskId === taskId) {
    // Move to next queued task
    const next = focusQueue.find(i => i.status === 'queued');
    if (next) {
      setActiveTask(next.id);
    } else {
      activeTaskId = null;
      console.log(`[FocusQueue] No more tasks in queue`);
    }
  }
}

/**
 * Remove task from queue
 */
export function removeFocusItem(taskId: string): void {
  const idx = focusQueue.findIndex(i => i.id === taskId);
  if (idx >= 0) {
    focusQueue.splice(idx, 1);
    console.log(`[FocusQueue] Removed: ${taskId}`);
  }
  if (activeTaskId === taskId) {
    const next = focusQueue.find(i => i.status === 'queued');
    activeTaskId = next?.id || null;
  }
}

/**
 * Get current focus queue
 */
export function getFocusQueue(): {
  queue: FocusItem[];
  activeTask: FocusItem | null;
  summary: string;
} {
  const active = focusQueue.find(i => i.id === activeTaskId) || null;
  const queued = focusQueue.filter(i => i.status === 'queued').length;
  const blocked = focusQueue.filter(i => i.status === 'blocked').length;
  const done = focusQueue.filter(i => i.status === 'done').length;

  const summary = active
    ? `🎯 ${active.title} | ${queued} queued, ${blocked} blocked, ${done} done`
    : `💤 No active task | ${queued} queued, ${blocked} blocked`;

  return {
    queue: focusQueue,
    activeTask: active,
    summary,
  };
}

/**
 * Clear done items from queue
 */
export function clearDoneTasks(): number {
  const before = focusQueue.length;
  focusQueue = focusQueue.filter(i => i.status !== 'done');
  const removed = before - focusQueue.length;
  if (removed > 0) {
    console.log(`[FocusQueue] Cleared ${removed} done tasks`);
  }
  return removed;
}

// Sort by priority (critical > high > medium > low)
function sortFocusQueue(): void {
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  focusQueue.sort((a, b) => {
    // Active always first
    if (a.status === 'active') return -1;
    if (b.status === 'active') return 1;
    // Then by priority
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}
