/**
 * Epic Progress Notifications
 *
 * Sends Telegram notifications about epic/checkpoint progress:
 * - Checkpoint completed (phase 1, 2, 3...)
 * - Epic fully completed
 * - Development session started
 * - Progress updates
 *
 * ADR-053: User-facing monitoring notifications
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { sendNotification } from '../telegram/telegramService';
import { pipelineEvents, type PipelineEvent } from './eventBus';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Checkpoint {
  id: string;
  name: string;
  trigger_to: string | string[];
  condition: string;
  status: 'pending' | 'done';
}

interface Epic {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  target_date?: string;
  checkpoints?: Checkpoint[];
}

interface EpicsData {
  epics: Epic[];
}

// ─── Epic Status Tracking ──────────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const EPICS_PATH = process.env.EPICS_PATH || `${SPACEOS_ROOT}/docs/projects/EPICS.yaml`;

/**
 * Load EPICS.yaml data
 */
function loadEpics(): EpicsData {
  try {
    const content = fs.readFileSync(EPICS_PATH, 'utf-8');
    return yaml.load(content) as EpicsData;
  } catch (error) {
    console.error('[EpicNotifications] Failed to load EPICS.yaml:', error);
    return { epics: [] };
  }
}

/**
 * Get epic progress summary
 */
function getEpicProgress(epicId: string): {
  epic: Epic | null;
  totalCheckpoints: number;
  doneCheckpoints: number;
  pendingCheckpoints: number;
  progress: number; // 0-100
} {
  const data = loadEpics();
  const epic = data.epics.find(e => e.id === epicId) || null;

  if (!epic || !epic.checkpoints) {
    return {
      epic,
      totalCheckpoints: 0,
      doneCheckpoints: 0,
      pendingCheckpoints: 0,
      progress: epic?.status === 'done' ? 100 : 0,
    };
  }

  const total = epic.checkpoints.length;
  const done = epic.checkpoints.filter(cp => cp.status === 'done').length;
  const pending = total - done;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    epic,
    totalCheckpoints: total,
    doneCheckpoints: done,
    pendingCheckpoints: pending,
    progress,
  };
}

// ─── Notification Functions ────────────────────────────────────────────────────

/**
 * Send checkpoint completion notification
 */
export async function notifyCheckpointComplete(
  epicId: string,
  checkpointId: string,
  checkpointName: string,
  fromTerminal: string
): Promise<void> {
  const progress = getEpicProgress(epicId);

  // Progress bar visualization
  const progressBar = createProgressBar(progress.progress);

  const message = [
    `🎯 *CHECKPOINT COMPLETE*`,
    ``,
    `✅ *${checkpointName}*`,
    `📋 Epic: \`${epicId}\``,
    ``,
    `${progressBar} ${progress.progress}%`,
    `(${progress.doneCheckpoints}/${progress.totalCheckpoints} checkpoints)`,
    ``,
    progress.pendingCheckpoints > 0
      ? `⏳ Még ${progress.pendingCheckpoints} checkpoint hátra`
      : `🎉 *Minden checkpoint DONE!*`,
    ``,
    `_From: ${fromTerminal}_`,
  ].join('\n');

  await sendNotification(message);
  console.log(`[EpicNotifications] Checkpoint complete: ${checkpointId} in ${epicId}`);
}

/**
 * Send epic completion notification
 */
export async function notifyEpicComplete(epicId: string): Promise<void> {
  const data = loadEpics();
  const epic = data.epics.find(e => e.id === epicId);

  if (!epic) return;

  const message = [
    `🏆 *EPIC COMPLETE!*`,
    ``,
    `🎉 *${epic.name}*`,
    `📋 ID: \`${epicId}\``,
    ``,
    `✅ Minden feladat és checkpoint elkészült!`,
    epic.target_date ? `📅 Target: ${epic.target_date}` : null,
    ``,
    `_Gratulálok a csapatnak!_`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendNotification(message);
  console.log(`[EpicNotifications] Epic complete: ${epicId}`);
}

/**
 * Send session started notification
 */
export async function notifySessionStarted(
  terminal: string,
  taskId: string,
  taskTitle?: string
): Promise<void> {
  const message = [
    `🚀 *SESSION STARTED*`,
    ``,
    `*Terminal:* ${terminal}`,
    `*Task:* \`${taskId}\``,
    taskTitle ? `*Title:* ${taskTitle}` : null,
    ``,
    `_Fejlesztés elkezdődött..._`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendNotification(message);
  console.log(`[EpicNotifications] Session started: ${terminal} -> ${taskId}`);
}

/**
 * Send task done notification
 */
export async function notifyTaskDone(
  terminal: string,
  taskId: string,
  summary?: string
): Promise<void> {
  // Try to load task details from message registry for richer context
  let taskTitle = '';
  let epicId = '';
  let filesChanged: string[] = [];

  try {
    // Extract just the number from MSG-BACKEND-103 → 103
    const taskNumber = taskId.split('-').pop() || '';
    const taskPath = `${SPACEOS_ROOT}/terminals/${terminal}/outbox/*_${taskNumber}_*.md`;
    const files = require('child_process').execSync(`ls ${taskPath} 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);

    if (files.length > 0) {
      const content = fs.readFileSync(files[0], 'utf-8');
      const lines = content.split('\n');

      // Extract title from markdown h1
      const titleLine = lines.find(l => l.startsWith('# '));
      if (titleLine) taskTitle = titleLine.replace('# ', '').trim();

      // Extract epic from frontmatter
      const epicLine = lines.find(l => l.startsWith('epic_id:'));
      if (epicLine) epicId = epicLine.split(':')[1].trim();

      // Extract files changed
      const filesSection = content.match(/## Files Changed[\s\S]*?(?=##|$)/);
      if (filesSection) {
        filesChanged = filesSection[0].match(/- `([^`]+)`/g)?.map(f => f.replace(/- `|`/g, '')) || [];
      }
    }
  } catch (error) {
    // Fallback to basic info
  }

  const message = [
    `✅ *TASK DONE*`,
    ``,
    `📋 *Terminal:* ${terminal.toUpperCase()}`,
    `🎯 *Task ID:* \`${taskId}\``,
    taskTitle ? `📝 *Title:* ${taskTitle}` : null,
    epicId ? `🗂 *Epic:* \`${epicId}\`` : null,
    summary ? `💬 *Summary:* ${summary}` : null,
    filesChanged.length > 0 ? `📁 *Files:* ${filesChanged.slice(0, 3).join(', ')}${filesChanged.length > 3 ? ` +${filesChanged.length - 3} more` : ''}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  await sendNotification(message);
  console.log(`[EpicNotifications] Task done: ${terminal} -> ${taskId}`);
}

/**
 * Send task blocked notification
 */
export async function notifyTaskBlocked(
  terminal: string,
  taskId: string,
  reason?: string
): Promise<void> {
  // Try to load task details for richer context
  let taskTitle = '';
  let epicId = '';
  let blockedReason = reason || '';

  try {
    // Extract just the number from MSG-BACKEND-103 → 103
    const taskNumber = taskId.split('-').pop() || '';
    const taskPath = `${SPACEOS_ROOT}/terminals/${terminal}/outbox/*_${taskNumber}_*.md`;
    const files = require('child_process').execSync(`ls ${taskPath} 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);

    if (files.length > 0) {
      const content = fs.readFileSync(files[0], 'utf-8');
      const lines = content.split('\n');

      // Extract title
      const titleLine = lines.find(l => l.startsWith('# '));
      if (titleLine) taskTitle = titleLine.replace('# ', '').trim();

      // Extract epic
      const epicLine = lines.find(l => l.startsWith('epic_id:'));
      if (epicLine) epicId = epicLine.split(':')[1].trim();

      // Extract blocked reason from content
      if (!blockedReason) {
        const reasonMatch = content.match(/## (?:Blocked Reason|Why Blocked)[\s\S]*?\n\n([\s\S]*?)(?=\n##|$)/);
        if (reasonMatch) blockedReason = reasonMatch[1].trim().substring(0, 200);
      }
    }
  } catch (error) {
    // Fallback to basic info
  }

  const message = [
    `🚫 *TASK BLOCKED*`,
    ``,
    `📋 *Terminal:* ${terminal.toUpperCase()}`,
    `🎯 *Task ID:* \`${taskId}\``,
    taskTitle ? `📝 *Title:* ${taskTitle}` : null,
    epicId ? `🗂 *Epic:* \`${epicId}\`` : null,
    blockedReason ? `⚠️ *Reason:* ${blockedReason}` : null,
    ``,
    `🔴 _Beavatkozás szükséges!_`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendNotification(message);
  console.log(`[EpicNotifications] Task blocked: ${terminal} -> ${taskId}`);
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Create ASCII progress bar
 */
function createProgressBar(percent: number, length: number = 10): string {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

// ─── Event Bus Integration ─────────────────────────────────────────────────────

// Deduplication: Track sent notifications (task_id → timestamp)
const sentNotifications = new Map<string, number>();
const DEDUP_WINDOW_MS = 5000; // 5 seconds

/**
 * Check if notification was already sent recently
 */
function isDuplicate(taskId: string, eventType: 'done' | 'blocked'): boolean {
  const key = `${taskId}:${eventType}`;
  const lastSent = sentNotifications.get(key);
  const now = Date.now();

  if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
    console.log(`[EpicNotifications] Skipping duplicate ${eventType} for ${taskId} (sent ${Math.round((now - lastSent) / 1000)}s ago)`);
    return true;
  }

  sentNotifications.set(key, now);
  return false;
}

/**
 * Attach to pipeline event bus for automatic notifications
 */
export function attachEpicNotifications(): void {
  pipelineEvents.onAny(async (event: PipelineEvent) => {
    try {
      switch (event.type) {
        case 'session:started':
          if (event.terminal && event.messageId) {
            await notifySessionStarted(event.terminal, event.messageId);
          }
          break;

        case 'outbox:done':
          if (event.terminal && event.messageId) {
            // Deduplication check
            if (isDuplicate(event.messageId, 'done')) {
              break;
            }

            // Extract event data for richer notification
            const eventData = (event as any).data || {};
            const summary = eventData.summary || eventData.title;
            const epicId = eventData.epicId;
            const checkpointId = eventData.checkpointId;

            await notifyTaskDone(event.terminal, event.messageId, summary);

            // Check if this completes a checkpoint
            if (epicId && checkpointId) {
              console.log(`[EpicNotifications] Found checkpoint data: epic=${epicId}, cp=${checkpointId}`);
              await completeCheckpoint(epicId, checkpointId, event.terminal);
            }
          }
          break;

        case 'outbox:blocked':
          if (event.terminal && event.messageId) {
            // Deduplication check
            if (isDuplicate(event.messageId, 'blocked')) {
              break;
            }

            // Extract reason for richer notification
            const eventData = (event as any).data || {};
            const reason = eventData.reason || eventData.blockedReason;

            await notifyTaskBlocked(event.terminal, event.messageId, reason);
          }
          break;
      }
    } catch (error) {
      console.error('[EpicNotifications] Event handler error:', error);
    }
  });

  console.log('[EpicNotifications] Attached to Event Bus');
}

/**
 * Save updated EPICS.yaml
 */
function saveEpics(data: EpicsData): boolean {
  try {
    const yamlContent = yaml.dump(data, {
      lineWidth: 120,
      noRefs: true,
    });
    fs.writeFileSync(EPICS_PATH, yamlContent, 'utf-8');
    console.log('[EpicNotifications] EPICS.yaml updated');
    return true;
  } catch (error) {
    console.error('[EpicNotifications] Failed to save EPICS.yaml:', error);
    return false;
  }
}

/**
 * Complete a checkpoint by epic_id and checkpoint_id
 * Called when outbox:done event includes these fields
 */
async function completeCheckpoint(epicId: string, checkpointId: string, terminal: string): Promise<void> {
  console.log(`[EpicNotifications] Completing checkpoint: epic=${epicId}, cp=${checkpointId}, from=${terminal}`);

  const data = loadEpics();
  const epic = data.epics.find(e => e.id === epicId);

  if (!epic) {
    console.log(`[EpicNotifications] Epic ${epicId} not found`);
    return;
  }

  if (!epic.checkpoints) {
    console.log(`[EpicNotifications] Epic ${epicId} has no checkpoints`);
    return;
  }

  const checkpoint = epic.checkpoints.find(cp => cp.id === checkpointId);
  if (!checkpoint) {
    console.log(`[EpicNotifications] Checkpoint ${checkpointId} not found in ${epicId}`);
    return;
  }

  if (checkpoint.status === 'done') {
    console.log(`[EpicNotifications] Checkpoint ${checkpointId} already done`);
    return;
  }

  // Update checkpoint status to done
  checkpoint.status = 'done';
  console.log(`[EpicNotifications] Checkpoint ${checkpointId} marked as done`);

  // Check if all checkpoints are now done
  const allDone = epic.checkpoints.every(c => c.status === 'done');
  if (allDone) {
    epic.status = 'done';
    (epic as any).completed_date = new Date().toISOString().split('T')[0];
    console.log(`[EpicNotifications] Epic ${epicId} marked as done (all checkpoints complete)`);
  }

  // Save the updated EPICS.yaml
  saveEpics(data);

  // Send notifications
  await notifyCheckpointComplete(epicId, checkpointId, checkpoint.name, terminal);

  if (allDone) {
    await notifyEpicComplete(epicId);
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────────

export default {
  notifyCheckpointComplete,
  notifyEpicComplete,
  notifySessionStarted,
  notifyTaskDone,
  notifyTaskBlocked,
  attachEpicNotifications,
  getEpicProgress,
};
