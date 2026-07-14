// checkpointTracker.ts - Track checkpoint completion
// ADR-053: Mode #4 Program-Awareness (2026-07-02)

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Checkpoint, Epic, loadActiveEpic } from './epicManager';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const TERMINALS_DIR = process.env.TERMINALS_PATH || `${SPACEOS_ROOT}/terminals`;
const EPICS_PATH = process.env.EPICS_PATH || `${SPACEOS_ROOT}/docs/projects/EPICS.yaml`;

/**
 * Parse checkpoint condition
 * Formats:
 * - "MSG-BACKEND-103 status=DONE"
 * - "EPIC-JOINERY-PHASE2 status=done"
 *
 * @returns { type: 'message' | 'epic', target: string, status: string }
 */
function parseCondition(condition: string): { type: 'message' | 'epic'; target: string; status: string } | null {
  try {
    const parts = condition.trim().split(' ');
    if (parts.length !== 2) {
      console.warn('[checkpointTracker] Invalid condition format:', condition);
      return null;
    }

    const [target, statusCheck] = parts;
    const [_, status] = statusCheck.split('=');

    if (target.startsWith('MSG-')) {
      return { type: 'message', target, status: status.toUpperCase() };
    } else if (target.startsWith('EPIC-')) {
      return { type: 'epic', target, status: status.toLowerCase() };
    }

    console.warn('[checkpointTracker] Unknown condition target:', target);
    return null;
  } catch (error) {
    console.error('[checkpointTracker] Failed to parse condition:', condition, error);
    return null;
  }
}

/**
 * Check if a message is in DONE status
 * Looks in the terminal's outbox for the message
 */
function checkMessageStatus(messageId: string, expectedStatus: string): boolean {
  try {
    // Extract terminal name from message ID (MSG-BACKEND-103 → backend)
    const parts = messageId.split('-');
    if (parts.length < 3) {
      console.warn('[checkpointTracker] Invalid message ID format:', messageId);
      return false;
    }

    const terminal = parts[1].toLowerCase();
    const outboxDir = path.join(TERMINALS_DIR, terminal, 'outbox');

    if (!fs.existsSync(outboxDir)) {
      return false;
    }

    // Search for DONE message matching this message ID
    const files = fs.readdirSync(outboxDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filepath = path.join(outboxDir, file);
      const content = fs.readFileSync(filepath, 'utf-8');

      // Check frontmatter for message ID reference
      const refMatch = content.match(/^ref:\s*(.+)$/m);
      const statusMatch = content.match(/^status:\s*(.+)$/m);

      if (refMatch && statusMatch) {
        const ref = refMatch[1].trim();
        const status = statusMatch[1].trim().toUpperCase();

        if (ref === messageId && status === expectedStatus) {
          return true;
        }
      }

      // Also check if the file itself is named with the message ID
      if (file.includes(messageId.toLowerCase()) && content.includes('type: done')) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('[checkpointTracker] Failed to check message status:', messageId, error);
    return false;
  }
}

/**
 * Check if an epic has the expected status
 */
function checkEpicStatus(epicId: string, expectedStatus: string): boolean {
  try {
    if (!fs.existsSync(EPICS_PATH)) {
      return false;
    }

    const content = fs.readFileSync(EPICS_PATH, 'utf-8');
    const data = yaml.load(content) as any;

    if (!data || !data.epics) {
      return false;
    }

    const epic = data.epics.find((e: any) => e.id === epicId);
    return epic && epic.status === expectedStatus;
  } catch (error) {
    console.error('[checkpointTracker] Failed to check epic status:', epicId, error);
    return false;
  }
}

/**
 * Check if checkpoint condition is met
 *
 * @param checkpoint Checkpoint to check
 * @returns true if condition met, false otherwise
 */
export function checkCheckpointCompletion(checkpoint: Checkpoint): boolean {
  const parsed = parseCondition(checkpoint.condition);
  if (!parsed) {
    return false;
  }

  if (parsed.type === 'message') {
    return checkMessageStatus(parsed.target, parsed.status);
  } else if (parsed.type === 'epic') {
    return checkEpicStatus(parsed.target, parsed.status);
  }

  return false;
}

/**
 * Update checkpoint status in EPICS.yaml
 *
 * @param epicId Epic ID containing the checkpoint
 * @param checkpointId Checkpoint ID to update
 * @param status New status ('pending' | 'done')
 * @returns true if successful, false otherwise
 */
export function updateCheckpointStatus(epicId: string, checkpointId: string, status: 'pending' | 'done'): boolean {
  try {
    if (!fs.existsSync(EPICS_PATH)) {
      console.error('[checkpointTracker] EPICS.yaml not found');
      return false;
    }

    const content = fs.readFileSync(EPICS_PATH, 'utf-8');
    const data = yaml.load(content) as any;

    if (!data || !data.epics) {
      console.error('[checkpointTracker] Invalid EPICS.yaml structure');
      return false;
    }

    const epic = data.epics.find((e: any) => e.id === epicId);
    if (!epic || !epic.checkpoints) {
      console.error(`[checkpointTracker] Epic ${epicId} not found or has no checkpoints`);
      return false;
    }

    const checkpoint = epic.checkpoints.find((cp: any) => cp.id === checkpointId);
    if (!checkpoint) {
      console.error(`[checkpointTracker] Checkpoint ${checkpointId} not found in epic ${epicId}`);
      return false;
    }

    // Update status
    checkpoint.status = status;

    // Write back to file
    const yamlContent = yaml.dump(data, { lineWidth: -1 });
    fs.writeFileSync(EPICS_PATH, yamlContent, 'utf-8');

    console.log(`[checkpointTracker] Checkpoint ${checkpointId} marked as ${status.toUpperCase()}`);
    return true;
  } catch (error) {
    console.error('[checkpointTracker] Failed to update checkpoint status:', error);
    return false;
  }
}

/**
 * Check all checkpoints for active epic and update their status
 * Returns number of newly completed checkpoints
 */
export function updateActiveEpicCheckpoints(): number {
  const epic = loadActiveEpic();
  if (!epic || !epic.checkpoints) {
    return 0;
  }

  let newlyCompleted = 0;

  for (const checkpoint of epic.checkpoints) {
    if (checkpoint.status === 'pending') {
      const isComplete = checkCheckpointCompletion(checkpoint);
      if (isComplete) {
        const updated = updateCheckpointStatus(epic.id, checkpoint.id, 'done');
        if (updated) {
          newlyCompleted++;
          console.log(`[checkpointTracker] ✅ Checkpoint completed: ${checkpoint.id} - ${checkpoint.name}`);
        }
      }
    }
  }

  return newlyCompleted;
}
