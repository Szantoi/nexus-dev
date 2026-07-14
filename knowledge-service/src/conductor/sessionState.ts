// sessionState.ts - Cross-session Goal Recovery
// Goal Persistence Pattern Phase 3 (2026-07-04)
//
// Saves and restores Conductor goal state across session restarts.
// Prevents goal loss when session crashes or is manually restarted.

import * as fs from 'fs';
import * as path from 'path';
import { loadActiveEpic, getEpicProgress, getNextCheckpoint, Epic } from './epicManager';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const STATE_DIR = process.env.CONDUCTOR_STATE_DIR || `${SPACEOS_ROOT}/terminals/conductor`;
const STATE_FILE = path.join(STATE_DIR, '.session-state.json');

export interface GoalState {
  // Epic context
  epicId: string;
  epicName: string;
  epicProgress: number;

  // Checkpoint context
  nextCheckpointId: string | null;
  nextCheckpointName: string | null;
  completedCheckpoints: string[];

  // Session context
  lastTurnCount: number;
  lastActiveTask: string | null;

  // Metadata
  savedAt: string;
  sessionId: string;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Save current goal state to disk
 * Called at session end or periodically during session
 */
export function saveGoalState(
  turnCount: number = 0,
  activeTask: string | null = null,
  sessionId?: string
): boolean {
  try {
    const activeEpic = loadActiveEpic();
    if (!activeEpic) {
      console.log('[sessionState] No active epic to save');
      return false;
    }

    const progress = getEpicProgress(activeEpic);
    const nextCheckpoint = getNextCheckpoint(activeEpic);
    const completedCheckpoints = activeEpic.checkpoints
      ?.filter(cp => cp.status === 'done')
      .map(cp => cp.id) || [];

    const state: GoalState = {
      epicId: activeEpic.id,
      epicName: activeEpic.name,
      epicProgress: progress,
      nextCheckpointId: nextCheckpoint?.id || null,
      nextCheckpointName: nextCheckpoint?.name || null,
      completedCheckpoints,
      lastTurnCount: turnCount,
      lastActiveTask: activeTask,
      savedAt: new Date().toISOString(),
      sessionId: sessionId || generateSessionId(),
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    console.log(`[sessionState] ✓ Goal state saved (${activeEpic.id} @ ${progress}%)`);
    return true;
  } catch (error) {
    console.error('[sessionState] Failed to save goal state:', error);
    return false;
  }
}

/**
 * Load previous goal state from disk
 * Called at session start to recover context
 */
export function loadGoalState(): GoalState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log('[sessionState] No previous session state found');
      return null;
    }

    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(content) as GoalState;

    // Validate state is not too old (max 24 hours)
    const savedAt = new Date(state.savedAt);
    const hoursSinceSave = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceSave > 24) {
      console.log(`[sessionState] State too old (${hoursSinceSave.toFixed(1)}h), ignoring`);
      return null;
    }

    console.log(`[sessionState] ✓ Loaded previous state (${state.epicId} @ ${state.epicProgress}%)`);
    return state;
  } catch (error) {
    console.error('[sessionState] Failed to load goal state:', error);
    return null;
  }
}

/**
 * Build recovery context message for session injection
 * Returns markdown formatted context about previous session
 */
export function buildRecoveryContext(): string | null {
  const previousState = loadGoalState();
  if (!previousState) {
    return null;
  }

  // Compare with current state
  const currentEpic = loadActiveEpic();
  const currentProgress = currentEpic ? getEpicProgress(currentEpic) : 0;

  // Check if epic changed or significant progress was made
  const epicChanged = currentEpic?.id !== previousState.epicId;
  const progressDelta = currentProgress - previousState.epicProgress;

  let context = `## 🔄 CROSS-SESSION GOAL RECOVERY

**Előző session állapota** (${new Date(previousState.savedAt).toLocaleString('hu-HU')}):

| Metrika | Előző | Jelenlegi | Változás |
|---------|-------|-----------|----------|
| **Epic** | \`${previousState.epicId}\` | \`${currentEpic?.id || 'N/A'}\` | ${epicChanged ? '⚠️ VÁLTOZOTT' : '✅ Ugyanaz'} |
| **Progress** | ${previousState.epicProgress}% | ${currentProgress}% | ${progressDelta > 0 ? `+${progressDelta}%` : progressDelta === 0 ? '=' : `${progressDelta}%`} |
| **Last Turn Count** | ${previousState.lastTurnCount} | 0 (új session) | — |

`;

  if (previousState.lastActiveTask) {
    context += `### ⏸️ Félbehagyott Feladat

Az előző session-ben dolgozol ezen: \`${previousState.lastActiveTask}\`

**ELLENŐRIZD:** Befejeződött-e? Ha nem, folytasd!

`;
  }

  if (previousState.nextCheckpointId) {
    context += `### 🎯 Következő Milestone (előző session-ből)

\`${previousState.nextCheckpointId}\`: ${previousState.nextCheckpointName}

**TEENDŐ:** Ellenőrizd a checkpoint státuszát és haladj tovább!

`;
  }

  context += `---
*Cross-session Goal Recovery — Goal Persistence Pattern Phase 3*
`;

  return context;
}

/**
 * Clear saved state (called after successful epic completion)
 */
export function clearGoalState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
      console.log('[sessionState] Goal state cleared');
    }
  } catch (error) {
    console.error('[sessionState] Failed to clear goal state:', error);
  }
}
