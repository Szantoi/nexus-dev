/**
 * Context Persistence Module
 *
 * Manages terminal context files for long-running workflows:
 * - STATUS.md — Current state snapshot
 * - .session-state.json — Cross-session goal recovery
 * - .turn-count — Context saturation tracking
 * - CHECKPOINTS.md — Milestone tracking
 *
 * All files are MCP-servable and role/token validated.
 *
 * Created: 2026-07-07
 * Reference: docs/knowledge/patterns/TERMINAL_CONTEXT_PERSISTENCE_FILES.md
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { resolveTerminal, getTerminalPath, getAllTerminalNames } from './terminalConfig';

// ─── Types ────────────────────────────────────────────────────────────────

export interface SessionState {
  epicId: string;
  epicName: string;
  epicProgress: number;
  nextCheckpointId: string | null;
  nextCheckpointName: string | null;
  completedCheckpoints: string[];
  lastTurnCount: number;
  lastActiveTask: string | null;
  savedAt: string;
  sessionId: string;
}

export interface TerminalStatus {
  terminal: string;
  lastUpdated: string;
  systemStatus: 'operational' | 'in_progress' | 'paused' | 'blocked';
  currentFocus: string | null;
  content: string;
}

export interface TerminalCheckpoints {
  terminal: string;
  content: string;
  checkpoints: Array<{
    date: string;
    name: string;
    decision: string;
  }>;
}

export interface ContextFiles {
  terminal: string;
  hasStatus: boolean;
  hasSessionState: boolean;
  hasTurnCount: boolean;
  hasCheckpoints: boolean;
  turnCount: number;
  sessionState: SessionState | null;
}

// ─── Constants ────────────────────────────────────────────────────────────

const TURN_WARNING_THRESHOLD = 30;
const TURN_CRITICAL_THRESHOLD = 50;
const TURN_AUTO_REANCHOR_THRESHOLD = 50;

// ─── STATUS.md Functions ──────────────────────────────────────────────────

/**
 * Read STATUS.md for a terminal
 */
export async function readStatusMd(terminal: string): Promise<TerminalStatus | null> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const statusPath = path.join(terminalPath, 'STATUS.md');

  try {
    const content = await fs.readFile(statusPath, 'utf-8');

    // Parse basic metadata from content
    const lastUpdatedMatch = content.match(/\*\*Last Updated:\*\*\s*(.+)/);
    const systemStatusMatch = content.match(/\*\*System Status:\*\*\s*(.+)/);
    const currentFocusMatch = content.match(/\*\*Active Task:\*\*\s*(.+)/);

    let systemStatus: 'operational' | 'in_progress' | 'paused' | 'blocked' = 'operational';
    if (systemStatusMatch) {
      const status = systemStatusMatch[1].toLowerCase();
      if (status.includes('in progress')) systemStatus = 'in_progress';
      else if (status.includes('paused')) systemStatus = 'paused';
      else if (status.includes('blocked')) systemStatus = 'blocked';
    }

    return {
      terminal: canonical,
      lastUpdated: lastUpdatedMatch?.[1] || new Date().toISOString(),
      systemStatus,
      currentFocus: currentFocusMatch?.[1] || null,
      content,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Write STATUS.md for a terminal
 */
export async function writeStatusMd(
  terminal: string,
  options: {
    systemStatus: 'operational' | 'in_progress' | 'paused' | 'blocked';
    currentFocus?: string;
    epicProgress?: { name: string; progress: number; details?: string };
    recentActions?: string[];
    nextSteps?: string[];
    customContent?: string;
  }
): Promise<{ success: boolean; path: string }> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const statusPath = path.join(terminalPath, 'STATUS.md');

  const now = new Date();
  const timestamp = `${now.toISOString().split('T')[0]} ${now.toTimeString().split(' ')[0]} UTC`;

  const statusEmoji = {
    operational: 'OPERATIONAL',
    in_progress: 'IN PROGRESS',
    paused: 'PAUSED',
    blocked: 'BLOCKED',
  };

  let content = `# ${canonical.charAt(0).toUpperCase() + canonical.slice(1)} Status Report

**Last Updated:** ${timestamp}
**System Status:** ${statusEmoji[options.systemStatus]}
**Health Check:** Latest check at ${timestamp}

## Current Focus

${options.currentFocus ? `**Active Task:** ${options.currentFocus}` : '**Active Task:** None'}
`;

  if (options.epicProgress) {
    content += `
## Epic Progress

### ${options.epicProgress.name} (${options.epicProgress.progress}%)
${options.epicProgress.details || ''}
`;
  }

  if (options.recentActions && options.recentActions.length > 0) {
    content += `
## Recent Actions

${options.recentActions.map(a => `- ${a}`).join('\n')}
`;
  }

  if (options.nextSteps && options.nextSteps.length > 0) {
    content += `
## Next Steps

${options.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`;
  }

  if (options.customContent) {
    content += `\n${options.customContent}`;
  }

  content += `
---

**${canonical.charAt(0).toUpperCase() + canonical.slice(1)} Status:** ${options.systemStatus === 'in_progress' ? 'WORKING' : options.systemStatus.toUpperCase()}
**Session Started:** ${timestamp}
**Next Report:** Daily or on priority changes
`;

  await fs.writeFile(statusPath, content, 'utf-8');

  return { success: true, path: statusPath };
}

// ─── .session-state.json Functions ────────────────────────────────────────

/**
 * Read .session-state.json for a terminal
 */
export async function readSessionState(terminal: string): Promise<SessionState | null> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const statePath = path.join(terminalPath, '.session-state.json');

  try {
    const content = await fs.readFile(statePath, 'utf-8');
    return JSON.parse(content) as SessionState;
  } catch (err) {
    return null;
  }
}

/**
 * Write .session-state.json for a terminal
 */
export async function writeSessionState(
  terminal: string,
  state: Partial<SessionState>
): Promise<{ success: boolean; path: string }> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const statePath = path.join(terminalPath, '.session-state.json');

  // Load existing state or create new
  let existingState: SessionState = {
    epicId: '',
    epicName: '',
    epicProgress: 0,
    nextCheckpointId: null,
    nextCheckpointName: null,
    completedCheckpoints: [],
    lastTurnCount: 0,
    lastActiveTask: null,
    savedAt: new Date().toISOString(),
    sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };

  try {
    const existing = await readSessionState(terminal);
    if (existing) {
      existingState = existing;
    }
  } catch {}

  // Merge with new state
  const newState: SessionState = {
    ...existingState,
    ...state,
    savedAt: new Date().toISOString(),
  };

  await fs.writeFile(statePath, JSON.stringify(newState, null, 2), 'utf-8');

  return { success: true, path: statePath };
}

// ─── .turn-count Functions ────────────────────────────────────────────────

/**
 * Read .turn-count for a terminal
 */
export async function readTurnCount(terminal: string): Promise<number> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const turnPath = path.join(terminalPath, '.turn-count');

  try {
    const content = await fs.readFile(turnPath, 'utf-8');
    return parseInt(content.trim(), 10) || 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Increment .turn-count for a terminal
 */
export async function incrementTurnCount(
  terminal: string,
  amount: number = 1
): Promise<{
  success: boolean;
  count: number;
  warning: boolean;
  critical: boolean;
  needsReanchor: boolean;
}> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const turnPath = path.join(terminalPath, '.turn-count');

  const current = await readTurnCount(terminal);
  const newCount = current + amount;

  await fs.writeFile(turnPath, String(newCount), 'utf-8');

  return {
    success: true,
    count: newCount,
    warning: newCount >= TURN_WARNING_THRESHOLD && newCount < TURN_CRITICAL_THRESHOLD,
    critical: newCount >= TURN_CRITICAL_THRESHOLD,
    needsReanchor: newCount >= TURN_AUTO_REANCHOR_THRESHOLD,
  };
}

/**
 * Reset .turn-count for a terminal
 */
export async function resetTurnCount(terminal: string): Promise<{ success: boolean; path: string }> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const turnPath = path.join(terminalPath, '.turn-count');

  await fs.writeFile(turnPath, '0', 'utf-8');

  return { success: true, path: turnPath };
}

/**
 * Get context saturation status for a terminal
 */
export async function getContextSaturation(terminal: string): Promise<{
  terminal: string;
  turnCount: number;
  status: 'ok' | 'warning' | 'critical';
  message: string;
  needsReanchor: boolean;
}> {
  const count = await readTurnCount(terminal);

  let status: 'ok' | 'warning' | 'critical' = 'ok';
  let message = `Turn count: ${count} (healthy)`;

  if (count >= TURN_CRITICAL_THRESHOLD) {
    status = 'critical';
    message = `Turn count: ${count} - CRITICAL: >50 turns, context may be saturated. Consider re-anchoring or new session.`;
  } else if (count >= TURN_WARNING_THRESHOLD) {
    status = 'warning';
    message = `Turn count: ${count} - WARNING: >30 turns, approaching context saturation.`;
  }

  return {
    terminal: resolveTerminal(terminal) || terminal,
    turnCount: count,
    status,
    message,
    needsReanchor: count >= TURN_AUTO_REANCHOR_THRESHOLD,
  };
}

// ─── CHECKPOINTS.md Functions ─────────────────────────────────────────────

/**
 * Read CHECKPOINTS.md for a terminal
 */
export async function readCheckpointsMd(terminal: string): Promise<TerminalCheckpoints | null> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const checkpointsPath = path.join(terminalPath, 'CHECKPOINTS.md');

  try {
    const content = await fs.readFile(checkpointsPath, 'utf-8');

    // Parse checkpoints from content
    const checkpoints: Array<{ date: string; name: string; decision: string }> = [];
    const checkpointMatches = content.matchAll(/### .*?([\d-]+).*?—\s*(.+?)\s*(?:\n|GO\/NO-GO)/g);

    for (const match of checkpointMatches) {
      checkpoints.push({
        date: match[1],
        name: match[2],
        decision: 'GO/NO-GO',
      });
    }

    return {
      terminal: canonical,
      content,
      checkpoints,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Append a checkpoint to CHECKPOINTS.md
 */
export async function appendCheckpoint(
  terminal: string,
  checkpoint: {
    date: string;
    name: string;
    decision: string;
    evaluationCriteria: string[];
    goActions: string[];
    noGoActions: string[];
    refs?: string[];
  }
): Promise<{ success: boolean; path: string }> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;
  const checkpointsPath = path.join(terminalPath, 'CHECKPOINTS.md');

  // Read existing content or create header
  let existing = '';
  try {
    existing = await fs.readFile(checkpointsPath, 'utf-8');
  } catch {
    existing = `# ${canonical.charAt(0).toUpperCase() + canonical.slice(1)} Checkpoints

> Stratégiai döntési pontok és deadline-ok

---
`;
  }

  // Build checkpoint section
  const newCheckpoint = `
### ${checkpoint.date} — ${checkpoint.name} ${checkpoint.decision}

**Döntés:** ${checkpoint.decision}

**Értékelési szempontok:**
${checkpoint.evaluationCriteria.map(c => `- ${c}`).join('\n')}

**HA GO:**
${checkpoint.goActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}

**HA NO-GO:**
${checkpoint.noGoActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}
${checkpoint.refs ? `\n**Ref:**\n${checkpoint.refs.map(r => `- ${r}`).join('\n')}` : ''}

---
`;

  // Find position to insert (before last separator or at end)
  const content = existing.trim() + '\n' + newCheckpoint + `\n_Last updated: ${new Date().toISOString().split('T')[0]} ${new Date().toTimeString().split(' ')[0]}_\n`;

  await fs.writeFile(checkpointsPath, content, 'utf-8');

  return { success: true, path: checkpointsPath };
}

// ─── Combined Context Functions ───────────────────────────────────────────

/**
 * Get all context files status for a terminal
 */
export async function getContextFilesStatus(terminal: string): Promise<ContextFiles> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  const terminalPath = getTerminalPath(terminal)!;

  const [status, sessionState, turnCount, checkpoints] = await Promise.all([
    readStatusMd(terminal).catch(() => null),
    readSessionState(terminal).catch(() => null),
    readTurnCount(terminal).catch(() => 0),
    readCheckpointsMd(terminal).catch(() => null),
  ]);

  return {
    terminal: canonical,
    hasStatus: status !== null,
    hasSessionState: sessionState !== null,
    hasTurnCount: turnCount > 0,
    hasCheckpoints: checkpoints !== null,
    turnCount,
    sessionState,
  };
}

/**
 * Get context files for all terminals
 */
export async function getAllContextFilesStatus(): Promise<ContextFiles[]> {
  const terminals = getAllTerminalNames();
  const results: ContextFiles[] = [];

  for (const terminal of terminals) {
    try {
      const status = await getContextFilesStatus(terminal);
      results.push(status);
    } catch {
      // Skip terminals without paths
    }
  }

  return results;
}

/**
 * Build session start context for goal re-anchoring
 */
export async function buildSessionStartContext(terminal: string): Promise<string> {
  const canonical = resolveTerminal(terminal);
  if (!canonical) {
    throw new Error(`Unknown terminal: ${terminal}`);
  }

  let context = '';

  // 1. Load session state for cross-session recovery
  const sessionState = await readSessionState(terminal);
  if (sessionState) {
    context += `## Session Recovery Context

| Field | Value |
|-------|-------|
| **Epic** | \`${sessionState.epicId}\` — ${sessionState.epicName} |
| **Progress** | ${sessionState.epicProgress}% |
| **Last Task** | ${sessionState.lastActiveTask || 'None'} |
| **Session ID** | ${sessionState.sessionId} |

`;
    if (sessionState.completedCheckpoints.length > 0) {
      context += `**Completed Checkpoints:** ${sessionState.completedCheckpoints.join(', ')}\n\n`;
    }
    if (sessionState.nextCheckpointId) {
      context += `**Next Checkpoint:** ${sessionState.nextCheckpointId} — ${sessionState.nextCheckpointName}\n\n`;
    }
  }

  // 2. Load turn count for context saturation warning
  const saturation = await getContextSaturation(terminal);
  if (saturation.status !== 'ok') {
    context += `## Context Saturation Warning

${saturation.message}

`;
  }

  // 3. Load STATUS.md for current state
  const status = await readStatusMd(terminal);
  if (status) {
    context += `## Current Status

${status.currentFocus ? `**Current Focus:** ${status.currentFocus}` : '**Status:** Idle'}

`;
  }

  return context;
}
