/**
 * pane-state.ts — Detailed tmux pane state detection
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Detects 7 possible states for Claude Code sessions:
 * - idle: waiting for input (bypass permissions prompt)
 * - busy: actively processing (spinner, token counter)
 * - typing: user has typed but not submitted
 * - error: API error, rate limit, connection issue
 * - model_select: waiting for model selection
 * - queued: queued messages prompt
 * - unknown: cannot determine state
 */

import { capturePane } from './common';

export type PaneState =
  | 'idle'
  | 'busy'
  | 'typing'
  | 'error'
  | 'model_select'
  | 'queued'
  | 'unknown';

export interface PaneStateResult {
  state: PaneState;
  confidence: 'high' | 'medium' | 'low';
  details?: string;
  lastLines?: string;
}

// ─── Detection Patterns ─────────────────────────────────────────────────────

// Spinner characters (Claude Code uses these while thinking)
const SPINNER_RX = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

// Token counter pattern: "(5s · ↓123)" or "(12s · ↓1.2k)"
const TOKEN_COUNTER_RX = /\(\d+s\s*·\s*↓[\d.]+k?\)/;

// Idle footer patterns
const IDLE_FOOTER_RX = /bypass permissions on|shift\+tab to cycle/i;

// Esc to interrupt (actively processing)
const ESC_INTERRUPT_RX = /esc to interrupt/i;

// Error patterns
const ERROR_PATTERNS = [
  /API error/i,
  /rate limit/i,
  /overloaded/i,
  /Error:/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /socket hang up/i,
  /529|503|502|500/,  // HTTP error codes
  /exceeded.*quota/i,
  /invalid.*api.*key/i,
];

// Model selector patterns
const MODEL_SELECT_RX = /Choose a model|Select model|which model|Default model|claude opus|claude sonnet|claude haiku/i;

// Queued messages pattern
const QUEUED_MSG_RX = /Press up to edit queued messages/i;

// Paste placeholder (temporary busy state)
const PASTE_PLACEHOLDER_RX = /\[Pasted text #\d+\]/;

// Thinking block indicator
const THINKING_RX = /thinking|reasoning/i;

// Tool use indicator
const TOOL_USE_RX = /Read|Write|Edit|Bash|Glob|Grep|Task|TodoWrite/;

// ─── Detection Logic ─────────────────────────────────────────────────────────

/**
 * Detect the current state of a Claude Code session
 */
export async function detectPaneState(sessionName: string, lines = 30): Promise<PaneStateResult> {
  const output = await capturePane(sessionName, lines);

  // No output or very short - unknown state
  if (!output || output.trim().length < 10) {
    return {
      state: 'unknown',
      confidence: 'low',
      details: 'Empty or minimal pane output',
    };
  }

  // Get last N lines for pattern matching
  const allLines = output.split('\n');
  const lastLines = allLines.slice(-15).join('\n');
  const last5Lines = allLines.slice(-5).join('\n');

  // ─── Priority 1: Error Detection ─────────────────────────────────────────
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(lastLines)) {
      return {
        state: 'error',
        confidence: 'high',
        details: `Matched error pattern: ${pattern.source}`,
        lastLines: last5Lines,
      };
    }
  }

  // ─── Priority 2: Model Selection ─────────────────────────────────────────
  if (MODEL_SELECT_RX.test(lastLines)) {
    return {
      state: 'model_select',
      confidence: 'high',
      details: 'Model selection prompt detected',
      lastLines: last5Lines,
    };
  }

  // ─── Priority 3: Queued Messages ─────────────────────────────────────────
  if (QUEUED_MSG_RX.test(lastLines)) {
    return {
      state: 'queued',
      confidence: 'high',
      details: 'Queued messages prompt detected',
      lastLines: last5Lines,
    };
  }

  // ─── Priority 4: Busy Indicators ─────────────────────────────────────────
  // Check for spinner in the last 5 lines
  if (SPINNER_RX.test(last5Lines)) {
    return {
      state: 'busy',
      confidence: 'high',
      details: 'Spinner character detected',
      lastLines: last5Lines,
    };
  }

  // Check for token counter
  if (TOKEN_COUNTER_RX.test(last5Lines)) {
    return {
      state: 'busy',
      confidence: 'high',
      details: 'Token counter detected',
      lastLines: last5Lines,
    };
  }

  // Check for "esc to interrupt" - actively processing
  if (ESC_INTERRUPT_RX.test(last5Lines)) {
    return {
      state: 'busy',
      confidence: 'high',
      details: 'Esc to interrupt prompt detected',
      lastLines: last5Lines,
    };
  }

  // Paste placeholder (temporary busy)
  if (PASTE_PLACEHOLDER_RX.test(last5Lines)) {
    return {
      state: 'busy',
      confidence: 'medium',
      details: 'Paste placeholder detected',
      lastLines: last5Lines,
    };
  }

  // Tool use in progress
  if (TOOL_USE_RX.test(last5Lines) && !IDLE_FOOTER_RX.test(last5Lines)) {
    return {
      state: 'busy',
      confidence: 'medium',
      details: 'Tool use detected without idle footer',
      lastLines: last5Lines,
    };
  }

  // ─── Priority 5: Idle Detection ──────────────────────────────────────────
  if (IDLE_FOOTER_RX.test(last5Lines)) {
    // Check if there's typed text before the prompt
    // Look for ">" prompt followed by text
    const promptWithText = />.*[a-zA-Z0-9]/;
    if (promptWithText.test(last5Lines)) {
      return {
        state: 'typing',
        confidence: 'medium',
        details: 'Text detected after prompt',
        lastLines: last5Lines,
      };
    }

    return {
      state: 'idle',
      confidence: 'high',
      details: 'Idle footer detected',
      lastLines: last5Lines,
    };
  }

  // ─── Priority 6: Fallback ────────────────────────────────────────────────
  // If we see thinking/reasoning blocks, likely busy
  if (THINKING_RX.test(lastLines)) {
    return {
      state: 'busy',
      confidence: 'low',
      details: 'Thinking/reasoning keywords detected',
      lastLines: last5Lines,
    };
  }

  return {
    state: 'unknown',
    confidence: 'low',
    details: 'No matching patterns found',
    lastLines: last5Lines,
  };
}

/**
 * Quick check if session is idle (for nudging decisions)
 */
export async function isIdle(sessionName: string): Promise<boolean> {
  const result = await detectPaneState(sessionName);
  return result.state === 'idle';
}

/**
 * Quick check if session is busy (for skip decisions)
 */
export async function isBusy(sessionName: string): Promise<boolean> {
  const result = await detectPaneState(sessionName);
  return result.state === 'busy';
}

/**
 * Quick check if session has error (for alert decisions)
 */
export async function hasError(sessionName: string): Promise<boolean> {
  const result = await detectPaneState(sessionName);
  return result.state === 'error';
}

/**
 * Get human-readable state description
 */
export function stateDescription(state: PaneState): string {
  const descriptions: Record<PaneState, string> = {
    idle: 'Waiting for input',
    busy: 'Processing request',
    typing: 'User is typing',
    error: 'Error state',
    model_select: 'Model selection prompt',
    queued: 'Messages queued',
    unknown: 'Unknown state',
  };
  return descriptions[state];
}
