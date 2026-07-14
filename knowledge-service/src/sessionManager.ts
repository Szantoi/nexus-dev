/**
 * Session Manager
 *
 * Unified tmux session management for terminal coordination.
 * All session operations go through this module for:
 * - Consistent behavior
 * - Audit logging
 * - Error handling
 *
 * Now uses terminalConfig.ts for terminal definitions.
 */

import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveTerminal,
  getTerminal,
  getAllTerminalNames,
  canControl,
  getControllableTerminals,
  TERMINALS_DIR_PATH,
} from './terminalConfig';
import * as terminalsConfig from './config/terminals';
import { handleSessionEnd, type SessionEndContext } from './sessionHooks';

const TMUX_SOCKET = terminalsConfig.getTmuxSocket();
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const SESSION_LOG_PATH = `${SPACEOS_ROOT}/logs/sessions`;

// Model mapping
type ModelType = 'haiku' | 'sonnet' | 'opus';

/**
 * Check if fromTerminal has permission to control targetTerminal
 * Uses terminalConfig.ts canControl()
 */
function hasPermission(fromTerminal: string | undefined, targetTerminal: string): boolean {
  // No fromTerminal = system/API call, always allowed
  if (!fromTerminal) return true;

  // Resolve aliases
  const from = resolveTerminal(fromTerminal);
  const target = resolveTerminal(targetTerminal);

  if (!from || !target) return false;

  return canControl(from, target);
}

interface SessionStartOptions {
  terminal: string;
  model?: ModelType;
  prompt?: string;
  fromTerminal?: string; // Who initiated the start
}

interface SessionInjectOptions {
  terminal: string;
  prompt: string;
  fromTerminal?: string;
}

interface SessionStatus {
  terminal: string;
  sessionExists: boolean;
  claudeRunning: boolean;
  lastLines: string[];
}

interface SessionActionResult {
  success: boolean;
  message: string;
  action: string;
  terminal: string;
  timestamp: string;
  fromTerminal?: string;
  details?: Record<string, unknown>;
}

/**
 * Log session action for audit trail
 */
function logSessionAction(action: SessionActionResult): void {
  try {
    // Ensure log directory exists
    if (!fs.existsSync(SESSION_LOG_PATH)) {
      fs.mkdirSync(SESSION_LOG_PATH, { recursive: true });
    }

    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(SESSION_LOG_PATH, `${today}.jsonl`);

    fs.appendFileSync(logFile, JSON.stringify(action) + '\n');
  } catch (error) {
    console.error('[SessionManager] Failed to log action:', error);
  }
}

/**
 * Get session name from terminal name
 */
function sessionName(terminal: string): string {
  // Resolve alias to canonical name
  const canonical = resolveTerminal(terminal);
  const terminalDef = canonical ? getTerminal(canonical) : null;

  // Use session name from config if available
  if (terminalDef?.session) {
    return terminalDef.session;
  }

  return `spaceos-${canonical || terminal}`;
}

/**
 * Check if tmux session exists
 */
function sessionExists(terminal: string): boolean {
  try {
    execSync(`tmux -S ${TMUX_SOCKET} has-session -t ${sessionName(terminal)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Claude is running in the session (looking for Claude Code prompt)
 */
function isClaudeRunning(terminal: string): boolean {
  if (!sessionExists(terminal)) return false;

  try {
    const output = execSync(
      `tmux -S ${TMUX_SOCKET} capture-pane -t ${sessionName(terminal)} -p 2>/dev/null | tail -10`,
      { encoding: 'utf-8' }
    );
    // Look for Claude Code indicators
    return output.includes('Claude Code') ||
           output.includes('bypass permissions') ||
           output.includes('Schlepping') ||
           output.includes('⏵⏵');
  } catch {
    return false;
  }
}

/**
 * Capture last N lines from session
 */
function capturePane(terminal: string, lines: number = 15): string[] {
  if (!sessionExists(terminal)) return [];

  try {
    const output = execSync(
      `tmux -S ${TMUX_SOCKET} capture-pane -t ${sessionName(terminal)} -p 2>/dev/null | tail -${lines}`,
      { encoding: 'utf-8' }
    );
    return output.split('\n').filter(line => line.trim());
  } catch {
    return [];
  }
}

/**
 * Get session status
 */
export function getSessionStatus(terminal: string): SessionStatus {
  const canonical = resolveTerminal(terminal) || terminal;
  return {
    terminal: canonical,
    sessionExists: sessionExists(terminal),
    claudeRunning: isClaudeRunning(terminal),
    lastLines: capturePane(terminal, 10),
  };
}

/**
 * Get all sessions status
 */
export function getAllSessionsStatus(): SessionStatus[] {
  return getAllTerminalNames().map(terminal => getSessionStatus(terminal));
}

/**
 * Start a terminal session with optional prompt
 */
export async function startSession(options: SessionStartOptions): Promise<SessionActionResult> {
  const { terminal, prompt, fromTerminal } = options;
  const timestamp = new Date().toISOString();

  // Resolve terminal (supports aliases)
  const canonical = resolveTerminal(terminal);

  if (!canonical) {
    const result: SessionActionResult = {
      success: false,
      message: `Invalid terminal: ${terminal}. Valid: ${getAllTerminalNames().join(', ')}`,
      action: 'start_session',
      terminal,
      timestamp,
      fromTerminal,
    };
    logSessionAction(result);
    return result;
  }

  // Get terminal config for model default
  const terminalDef = getTerminal(canonical);
  const model = options.model || terminalDef?.model || 'sonnet';

  // Check permission
  if (!hasPermission(fromTerminal, canonical)) {
    const resolvedFrom = resolveTerminal(fromTerminal || '');
    const result: SessionActionResult = {
      success: false,
      message: `Permission denied: ${resolvedFrom || fromTerminal} cannot control ${canonical}`,
      action: 'start_session',
      terminal: canonical,
      timestamp,
      fromTerminal,
      details: { reason: 'permission_denied' },
    };
    logSessionAction(result);
    return result;
  }

  const session = sessionName(canonical);
  const workdir = terminalDef?.directory || path.join(TERMINALS_DIR_PATH, canonical);

  // Check if session already exists with Claude running
  if (sessionExists(canonical) && isClaudeRunning(canonical)) {
    const result: SessionActionResult = {
      success: false,
      message: `Session ${session} already running with Claude. Use inject_prompt instead.`,
      action: 'start_session',
      terminal: canonical,
      timestamp,
      fromTerminal,
      details: { claudeRunning: true },
    };
    logSessionAction(result);
    return result;
  }

  try {
    // Create or reuse tmux session
    if (!sessionExists(canonical)) {
      execSync(`tmux -S ${TMUX_SOCKET} new-session -d -s ${session} -c ${workdir}`);
    }

    // Build claude command
    const claudeCmd = prompt
      ? `claude --model ${model} --dangerously-skip-permissions -c "${prompt.replace(/"/g, '\\"')}"`
      : `claude --model ${model} --dangerously-skip-permissions`;

    // Send claude command (text first, then Enter)
    execSync(`tmux -S ${TMUX_SOCKET} send-keys -t ${session} '${claudeCmd}' Enter`);

    // FIX (MSG-NEXUS-017): Wait for Claude to actually start before returning
    // Previously returned immediately after sending command, causing injection to bash prompt
    // Now poll until Claude is running or timeout after 15 seconds
    const maxWaitMs = 15000;
    const pollIntervalMs = 500;
    const startTime = Date.now();
    let claudeStarted = false;

    while ((Date.now() - startTime) < maxWaitMs) {
      if (isClaudeRunning(canonical)) {
        claudeStarted = true;
        break;
      }
      // Wait before next poll
      execSync(`sleep ${pollIntervalMs / 1000}`);
    }

    if (!claudeStarted) {
      const result: SessionActionResult = {
        success: false,
        message: `Claude failed to start within ${maxWaitMs}ms for ${session}`,
        action: 'start_session',
        terminal: canonical,
        timestamp,
        fromTerminal,
        details: { model, timeout: true },
      };
      logSessionAction(result);
      return result;
    }

    const result: SessionActionResult = {
      success: true,
      message: `Started ${session} with ${model}${prompt ? ' and prompt' : ''} (Claude running)`,
      action: 'start_session',
      terminal: canonical,
      timestamp,
      fromTerminal,
      details: { model, hasPrompt: !!prompt, startupTimeMs: Date.now() - startTime },
    };
    logSessionAction(result);
    return result;
  } catch (error) {
    const result: SessionActionResult = {
      success: false,
      message: `Failed to start session: ${error}`,
      action: 'start_session',
      terminal: canonical,
      timestamp,
      fromTerminal,
    };
    logSessionAction(result);
    return result;
  }
}

/**
 * Inject prompt into running Claude session
 */
export async function injectPrompt(options: SessionInjectOptions): Promise<SessionActionResult> {
  const { terminal, prompt, fromTerminal } = options;
  const timestamp = new Date().toISOString();

  // Resolve terminal (supports aliases)
  const canonical = resolveTerminal(terminal);

  if (!canonical) {
    const result: SessionActionResult = {
      success: false,
      message: `Invalid terminal: ${terminal}`,
      action: 'inject_prompt',
      terminal,
      timestamp,
      fromTerminal,
    };
    logSessionAction(result);
    return result;
  }

  // Check permission
  if (!hasPermission(fromTerminal, canonical)) {
    const resolvedFrom = resolveTerminal(fromTerminal || '');
    const result: SessionActionResult = {
      success: false,
      message: `Permission denied: ${resolvedFrom || fromTerminal} cannot inject to ${canonical}`,
      action: 'inject_prompt',
      terminal: canonical,
      timestamp,
      fromTerminal,
      details: { reason: 'permission_denied' },
    };
    logSessionAction(result);
    return result;
  }

  const session = sessionName(canonical);

  // Check session exists
  if (!sessionExists(canonical)) {
    const result: SessionActionResult = {
      success: false,
      message: `Session ${session} does not exist. Use start_session first.`,
      action: 'inject_prompt',
      terminal: canonical,
      timestamp,
      fromTerminal,
    };
    logSessionAction(result);
    return result;
  }

  // Check Claude is running
  if (!isClaudeRunning(canonical)) {
    const result: SessionActionResult = {
      success: false,
      message: `Claude not running in ${session}. Use start_session to start Claude.`,
      action: 'inject_prompt',
      terminal: canonical,
      timestamp,
      fromTerminal,
    };
    logSessionAction(result);
    return result;
  }

  try {
    // Use Marveen-style injection for reliability with long prompts
    // Split into chunks if needed, send with -l flag for literal interpretation
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    execSync(`tmux -S ${TMUX_SOCKET} send-keys -t ${session} -l '${escapedPrompt}'`);
    // Use hex code 0d (carriage return) instead of Enter keyword to avoid bracketed paste mode issue
    execSync(`tmux -S ${TMUX_SOCKET} send-keys -t ${session} -H 0d`);

    const result: SessionActionResult = {
      success: true,
      message: `Injected prompt to ${session} (${prompt.length} chars)`,
      action: 'inject_prompt',
      terminal: canonical,
      timestamp,
      fromTerminal,
      details: { promptLength: prompt.length },
    };
    logSessionAction(result);
    return result;
  } catch (error) {
    const result: SessionActionResult = {
      success: false,
      message: `Failed to inject prompt: ${error}`,
      action: 'inject_prompt',
      terminal: canonical,
      timestamp,
      fromTerminal,
    };
    logSessionAction(result);
    return result;
  }
}

/**
 * Wake up a terminal - start session if needed and inject inbox read prompt
 */
export async function wakeUpTerminal(terminal: string, fromTerminal?: string): Promise<SessionActionResult> {
  const canonical = resolveTerminal(terminal) || terminal;
  const prompt = `Olvasd el az inbox mappát és dolgozd fel a UNREAD üzeneteket: terminals/${canonical}/inbox/`;

  // Check if already running with Claude
  if (isClaudeRunning(canonical)) {
    // Just inject the wake-up prompt
    return injectPrompt({ terminal: canonical, prompt, fromTerminal });
  }

  // Get default model from terminal config
  const terminalDef = getTerminal(canonical);
  const model = (terminalDef?.model || 'sonnet') as ModelType;

  // Start new session with prompt
  return startSession({
    terminal: canonical,
    model,
    prompt,
    fromTerminal,
  });
}

/**
 * Get recent session logs
 */
export function getSessionLogs(days: number = 1): SessionActionResult[] {
  const logs: SessionActionResult[] = [];

  try {
    if (!fs.existsSync(SESSION_LOG_PATH)) return logs;

    const files = fs.readdirSync(SESSION_LOG_PATH)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .slice(-days);

    for (const file of files) {
      const content = fs.readFileSync(path.join(SESSION_LOG_PATH, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          logs.push(JSON.parse(line));
        } catch {
          // Skip invalid lines
        }
      }
    }
  } catch {
    // Return empty if can't read logs
  }

  return logs;
}

/**
 * Get terminals that a controller can manage
 */
export function getControllable(fromTerminal: string): string[] {
  const canonical = resolveTerminal(fromTerminal);
  if (!canonical) return [];
  return getControllableTerminals(canonical);
}

// ─── Session Stop Options ─────────────────────────────────────────────────────

interface SessionStopOptions {
  terminal: string;
  fromTerminal?: string;
  graceful?: boolean; // If true, send Ctrl+C and wait for cleanup
  reason?: 'done' | 'blocked' | 'timeout' | 'handoff' | 'manual';
  summary?: string; // Session summary to save to memory
}

interface SessionStopAllOptions {
  fromTerminal?: string;
  excludePriority?: boolean; // If true, don't stop root/conductor
  graceful?: boolean;
}

// ─── Stop Session ─────────────────────────────────────────────────────────────

/**
 * Stop a terminal session gracefully or immediately
 *
 * Graceful shutdown:
 * 1. Send Ctrl+C to interrupt Claude
 * 2. Wait for cleanup (max 5 seconds)
 * 3. Call handleSessionEnd hook to save memory
 * 4. Update Datahaven status to idle
 */
export async function stopSession(options: SessionStopOptions): Promise<SessionActionResult> {
  const { terminal, fromTerminal, graceful = true, reason = 'manual', summary } = options;
  const timestamp = new Date().toISOString();

  // Resolve terminal
  const canonical = resolveTerminal(terminal);

  if (!canonical) {
    const result: SessionActionResult = {
      success: false,
      message: `Invalid terminal: ${terminal}`,
      action: 'stop_session',
      terminal,
      timestamp,
      fromTerminal,
    };
    logSessionAction(result);
    return result;
  }

  // Check permission
  if (!hasPermission(fromTerminal, canonical)) {
    const resolvedFrom = resolveTerminal(fromTerminal || '');
    const result: SessionActionResult = {
      success: false,
      message: `Permission denied: ${resolvedFrom || fromTerminal} cannot stop ${canonical}`,
      action: 'stop_session',
      terminal: canonical,
      timestamp,
      fromTerminal,
      details: { reason: 'permission_denied' },
    };
    logSessionAction(result);
    return result;
  }

  const session = sessionName(canonical);

  // Check if session exists
  if (!sessionExists(canonical)) {
    const result: SessionActionResult = {
      success: true, // Idempotent - session already stopped
      message: `Session ${session} not running (already stopped)`,
      action: 'stop_session',
      terminal: canonical,
      timestamp,
      fromTerminal,
      details: { alreadyStopped: true },
    };
    logSessionAction(result);
    return result;
  }

  try {
    if (graceful && isClaudeRunning(canonical)) {
      // 1. Send Ctrl+C to interrupt Claude gracefully
      execSync(`tmux -S ${TMUX_SOCKET} send-keys -t ${session} C-c`);

      // 2. Wait for Claude to exit (max 5 seconds)
      let waited = 0;
      while (isClaudeRunning(canonical) && waited < 5000) {
        await new Promise(resolve => setTimeout(resolve, 500));
        waited += 500;
      }

      // 3. Call session end hook to save memory
      const endReason = reason === 'manual' ? 'done' : reason;
      const endContext: SessionEndContext = {
        terminal: canonical,
        endReason,
        summary,
      };

      try {
        await handleSessionEnd(endContext);
      } catch (hookError) {
        console.error(`[SessionManager] Session end hook failed: ${hookError}`);
      }
    }

    // 4. Kill the tmux session
    execSync(`tmux -S ${TMUX_SOCKET} kill-session -t ${session} 2>/dev/null || true`);

    const result: SessionActionResult = {
      success: true,
      message: `Stopped session ${session}${graceful ? ' (graceful)' : ' (immediate)'}`,
      action: 'stop_session',
      terminal: canonical,
      timestamp,
      fromTerminal,
      details: { graceful, reason },
    };
    logSessionAction(result);
    return result;
  } catch (error) {
    const result: SessionActionResult = {
      success: false,
      message: `Failed to stop session: ${error}`,
      action: 'stop_session',
      terminal: canonical,
      timestamp,
      fromTerminal,
    };
    logSessionAction(result);
    return result;
  }
}

// ─── Stop All Sessions ────────────────────────────────────────────────────────

/**
 * Stop all terminal sessions (except priority if specified)
 */
export async function stopAllSessions(options: SessionStopAllOptions = {}): Promise<SessionActionResult> {
  const { fromTerminal, excludePriority = true, graceful = true } = options;
  const timestamp = new Date().toISOString();

  // Only root can stop all sessions
  if (fromTerminal) {
    const resolved = resolveTerminal(fromTerminal);
    if (resolved !== 'root') {
      const result: SessionActionResult = {
        success: false,
        message: `Permission denied: only root can stop all sessions`,
        action: 'stop_all_sessions',
        terminal: 'all',
        timestamp,
        fromTerminal,
        details: { reason: 'permission_denied' },
      };
      logSessionAction(result);
      return result;
    }
  }

  const priorityTerminals = ['root', 'conductor'];
  const allTerminals = getAllTerminalNames();

  const terminalsToStop = excludePriority
    ? allTerminals.filter(t => !priorityTerminals.includes(t))
    : allTerminals;

  const results: { terminal: string; stopped: boolean; message: string }[] = [];

  for (const terminal of terminalsToStop) {
    try {
      const stopResult = await stopSession({
        terminal,
        fromTerminal,
        graceful,
        reason: 'manual',
      });
      results.push({
        terminal,
        stopped: stopResult.success,
        message: stopResult.message,
      });
    } catch (error) {
      results.push({
        terminal,
        stopped: false,
        message: String(error),
      });
    }
  }

  const stoppedCount = results.filter(r => r.stopped).length;

  const result: SessionActionResult = {
    success: true,
    message: `Stopped ${stoppedCount}/${terminalsToStop.length} sessions`,
    action: 'stop_all_sessions',
    terminal: 'all',
    timestamp,
    fromTerminal,
    details: {
      excludePriority,
      graceful,
      results,
    },
  };
  logSessionAction(result);
  return result;
}
