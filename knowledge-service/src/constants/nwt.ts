// nwt.ts — Nightwatch Tick (NWT) Time Unit System
// SpaceOS unified time measurement based on Nightwatch cycles
//
// 1 NWT = 2 minutes = 1 Nightwatch cycle (the system's "heartbeat")
//
// WHY: Agent work is much faster than human estimates.
// "3 days" in human terms might be 120 NWT (4 hours) in agent time.
// NWT provides realistic, measurable time units for the autonomous system.

// ─── Base Unit ───────────────────────────────────────────────────────────────

/**
 * 1 Nightwatch Tick = 2 minutes (120,000 ms)
 * This is the fundamental time unit of SpaceOS.
 */
export const NWT_MS = 120_000; // 2 minutes in milliseconds
export const NWT_SECONDS = 120; // 2 minutes in seconds
export const NWT_MINUTES = 2; // 2 minutes

// ─── Conversion Helpers ──────────────────────────────────────────────────────

/** Convert NWT to milliseconds */
export const nwtToMs = (nwt: number): number => nwt * NWT_MS;

/** Convert NWT to minutes */
export const nwtToMinutes = (nwt: number): number => nwt * NWT_MINUTES;

/** Convert NWT to hours */
export const nwtToHours = (nwt: number): number => (nwt * NWT_MINUTES) / 60;

/** Convert minutes to NWT (rounded up) */
export const minutesToNwt = (minutes: number): number => Math.ceil(minutes / NWT_MINUTES);

/** Convert hours to NWT */
export const hoursToNwt = (hours: number): number => Math.ceil((hours * 60) / NWT_MINUTES);

/** Convert milliseconds to NWT (rounded up) */
export const msToNwt = (ms: number): number => Math.ceil(ms / NWT_MS);

// ─── Human-Readable Format ───────────────────────────────────────────────────

/**
 * Format NWT as human-readable string
 * Examples:
 *   5 NWT → "5 NWT (10 min)"
 *   30 NWT → "30 NWT (1h)"
 *   120 NWT → "120 NWT (4h)"
 *   720 NWT → "720 NWT (24h / 1 day)"
 */
export function formatNwt(nwt: number): string {
  const minutes = nwt * NWT_MINUTES;

  if (minutes < 60) {
    return `${nwt} NWT (${minutes} min)`;
  }

  const hours = minutes / 60;
  if (hours < 24) {
    return `${nwt} NWT (${hours}h)`;
  }

  const days = hours / 24;
  return `${nwt} NWT (${hours}h / ${days.toFixed(1)} days)`;
}

// ─── Standard Time Scales ────────────────────────────────────────────────────

/**
 * Named NWT constants for common durations
 */
export const NWT_SCALES = {
  // Micro tasks (immediate)
  TICK: 1,                    // 2 min - single heartbeat

  // Short tasks
  QUICK_CHECK: 3,             // 6 min - status check, small fix
  MONITOR_CYCLE: 5,           // 10 min - Monitor health check interval
  SHORT_TASK: 15,             // 30 min - review, documentation update

  // Standard tasks
  STANDARD_TASK: 30,          // 1 hour - typical task
  MEDIUM_FEATURE: 60,         // 2 hours - medium feature
  LARGE_FEATURE: 120,         // 4 hours - large feature

  // Project scale
  HALF_DAY: 180,              // 6 hours
  WORK_DAY: 240,              // 8 hours (1 agent work day)
  WORK_WEEK: 1200,            // 40 hours (1 agent work week)

  // Sprint scale (agent sprints are faster!)
  AGENT_SPRINT: 2400,         // 80 hours (2 weeks human = 1 agent sprint)
} as const;

// ─── Timeout/Escalation Thresholds ───────────────────────────────────────────

/**
 * System timeouts in NWT
 * All timeout constants should reference these values
 */
export const NWT_TIMEOUTS = {
  // Session management
  STUCK_NUDGE: 2,             // 4 min - nudge stuck session
  INBOX_NUDGE: 3,             // 6 min - nudge for unread inbox
  IDLE_WARNING: 5,            // 10 min - idle session warning
  IDLE_SHUTDOWN: 8,           // 16 min - idle session shutdown

  // Task escalation
  TASK_WARNING: 15,           // 30 min - task taking too long
  TASK_RETRY: 30,             // 1 hour - first retry attempt
  TASK_ESCALATE: 60,          // 2 hours - escalate to higher level
  TASK_CRITICAL: 120,         // 4 hours - critical escalation

  // Review pipeline
  REVIEW_TIMEOUT: 15,         // 30 min - review should complete
  PIPELINE_TIMEOUT: 30,       // 1 hour - full pipeline timeout

  // Context saturation (Goal Persistence)
  CONTEXT_WARNING: 15,        // 30 turns ≈ 15 NWT
  CONTEXT_CRITICAL: 25,       // 50 turns ≈ 25 NWT
  CONTEXT_REANCHOR: 25,       // Auto re-anchor threshold
} as const;

// ─── Task Estimation Guidelines ──────────────────────────────────────────────

/**
 * Standard task size estimates in NWT
 * Use these for Conductor task assignment
 */
export const NWT_ESTIMATES = {
  // Code tasks
  BUGFIX_TRIVIAL: 5,          // 10 min - typo, one-liner
  BUGFIX_SIMPLE: 15,          // 30 min - simple bug
  BUGFIX_MEDIUM: 30,          // 1 hour - medium complexity
  BUGFIX_COMPLEX: 60,         // 2 hours - complex bug

  FEATURE_TINY: 15,           // 30 min - add field, small UI change
  FEATURE_SMALL: 30,          // 1 hour - small feature
  FEATURE_MEDIUM: 60,         // 2 hours - medium feature
  FEATURE_LARGE: 120,         // 4 hours - large feature
  FEATURE_EPIC: 240,          // 8 hours - epic-level feature

  // Non-code tasks
  REVIEW_SIMPLE: 5,           // 10 min - quick review
  REVIEW_THOROUGH: 15,        // 30 min - thorough review

  DOCUMENTATION: 15,          // 30 min - doc update
  ARCHITECTURE_REVIEW: 30,    // 1 hour - arch review
  SPIKE_RESEARCH: 60,         // 2 hours - research spike

  // Integration tasks
  API_ENDPOINT: 30,           // 1 hour - single endpoint
  API_MODULE: 120,            // 4 hours - full module
  INTEGRATION_TEST: 30,       // 1 hour - integration tests
  E2E_TEST: 60,               // 2 hours - E2E test suite
} as const;

// ─── Type Definitions ────────────────────────────────────────────────────────

/** NWT value type (positive integer) */
export type NwtValue = number;

/** Task estimate with NWT */
export interface NwtEstimate {
  nwt: NwtValue;
  confidence: 'high' | 'medium' | 'low';
  breakdown?: Record<string, NwtValue>;
}

/** Checkpoint with NWT tracking */
export interface NwtCheckpoint {
  id: string;
  estimated_nwt: NwtValue;
  actual_nwt?: NwtValue;
  started_at?: string;
  completed_at?: string;
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Calculate elapsed NWT since a timestamp
 */
export function elapsedNwt(since: Date | string): number {
  const start = typeof since === 'string' ? new Date(since) : since;
  const elapsed = Date.now() - start.getTime();
  return Math.floor(elapsed / NWT_MS);
}

/**
 * Check if NWT threshold exceeded
 */
export function isNwtExceeded(since: Date | string, thresholdNwt: number): boolean {
  return elapsedNwt(since) >= thresholdNwt;
}

/**
 * Get deadline from NWT estimate
 */
export function nwtDeadline(nwt: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + nwtToMs(nwt));
}

/**
 * Compare actual vs estimated NWT
 */
export function nwtVariance(estimated: number, actual: number): {
  variance: number;
  percentDiff: number;
  status: 'on_track' | 'ahead' | 'behind' | 'critical';
} {
  const variance = actual - estimated;
  const percentDiff = estimated > 0 ? (variance / estimated) * 100 : 0;

  let status: 'on_track' | 'ahead' | 'behind' | 'critical';
  if (percentDiff <= -10) {
    status = 'ahead';
  } else if (percentDiff <= 20) {
    status = 'on_track';
  } else if (percentDiff <= 50) {
    status = 'behind';
  } else {
    status = 'critical';
  }

  return { variance, percentDiff, status };
}
