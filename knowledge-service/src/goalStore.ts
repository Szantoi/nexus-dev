/**
 * Goal Store - Monitor-Driven Goal Progression (ADR-059)
 *
 * Manages goals that Monitor watches for completion.
 * When completion criteria are met, Monitor triggers Conductor.
 *
 * 2026-07-04: Initial implementation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { log } from './pipeline/common';
import { TERMINALS_PATH, SPACEOS_ROOT, GOALS_DIR, getEpicsPath, getTerminalsPath } from './config/paths';
import { logger } from './core/logger';

const GOALS_LOG = path.join(SPACEOS_ROOT, 'logs', 'dispatcher', 'goals.log');

// ─── Types ────────────────────────────────────────────────────────────────────

export type GoalStatus = 'watching' | 'triggered' | 'completed' | 'expired';

export type CriteriaType =
  | 'done_outbox'
  | 'checkpoint_status'
  | 'message_status'
  | 'terminal_idle'
  | 'all_of'
  | 'any_of';

export interface Criterion {
  type: CriteriaType;
  // done_outbox
  terminal?: string;
  message_pattern?: string;
  // checkpoint_status
  checkpoint_id?: string;
  expected_status?: string;
  // message_status
  message_id?: string;
  // terminal_idle
  min_idle_minutes?: number;
  // all_of / any_of
  criteria?: Criterion[];
}

export interface CriterionResult {
  criterion: Criterion;
  met: boolean;
  details: string;
  checked_at: string;
}

export interface Goal {
  id: string;
  created: string;
  created_by: string;
  epic_id?: string;

  goal: {
    description: string;
    checkpoint_id?: string;
  };

  completion_criteria: Criterion[];

  on_complete: {
    trigger_terminal: string;
    next_goal?: string;
    prompt: string;
  };

  status: GoalStatus;
  expires_at?: string;
  triggered_at?: string;
  completed_at?: string;
  trigger_message_id?: string;
  criteria_results?: CriterionResult[];
}

export interface CreateGoalParams {
  created_by: string;
  epic_id?: string;
  description: string;
  checkpoint_id?: string;
  completion_criteria: Criterion[];
  trigger_terminal: string;
  next_goal?: string;
  prompt: string;
  expires_in_hours?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Max attempts to claim a unique goal ID before giving up (cross-process EEXIST races). */
const MAX_ID_ALLOCATION_ATTEMPTS = 5;

/**
 * In-process serialization of ID allocation (TASK-QC-012): concurrent
 * createGoal() calls must not observe the same on-disk state and pick the
 * same sequence number. The queue chains allocations one after another.
 */
let idAllocationQueue: Promise<unknown> = Promise.resolve();

function withIdAllocationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = idAllocationQueue.then(fn, fn);
  // Keep the chain alive even if this allocation fails.
  idAllocationQueue = run.catch(() => undefined);
  return run;
}

/**
 * Next collision-free goal ID for today: a monotonic counter derived from the
 * files already present in GOALS_DIR (the store's persistent layer), replacing
 * the old `Date.now().slice(-3)` suffix that repeated every 1000 ms.
 * Format is preserved: GOAL-YYYY-MM-DD-NNN (NNN grows past 999 if needed).
 */
async function nextGoalId(): Promise<string> {
  const date = new Date().toISOString().split('T')[0];
  const prefix = `GOAL-${date}-`;

  let maxSeq = -1;
  try {
    const files = await fs.readdir(GOALS_DIR);
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith('.yaml')) continue;
      const seq = Number.parseInt(file.slice(prefix.length, -'.yaml'.length), 10);
      if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
    }
  } catch (err) {
    // Directory not created yet — this is the store's first goal.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
}

async function logGoalEvent(event: string, goalId: string, details?: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${event}] ${goalId}${details ? ` - ${details}` : ''}\n`;

  try {
    await fs.mkdir(path.dirname(GOALS_LOG), { recursive: true });
    await fs.appendFile(GOALS_LOG, line);
  } catch (err) {
    logger.error('[GoalStore] Failed to log:', err);
  }

  await log(`[GoalStore] ${event}: ${goalId}${details ? ` - ${details}` : ''}`);
}

// ─── CRUD Operations ──────────────────────────────────────────────────────────

/**
 * Create a new goal
 */
export async function createGoal(params: CreateGoalParams): Promise<Goal> {
  const now = new Date().toISOString();

  const goal: Goal = {
    id: '', // allocated below, under the ID-allocation lock
    created: now,
    created_by: params.created_by,
    epic_id: params.epic_id,

    goal: {
      description: params.description,
      checkpoint_id: params.checkpoint_id,
    },

    completion_criteria: params.completion_criteria,

    on_complete: {
      trigger_terminal: params.trigger_terminal,
      next_goal: params.next_goal,
      prompt: params.prompt,
    },

    status: 'watching',
  };

  if (params.expires_in_hours) {
    const expiresAt = new Date(Date.now() + params.expires_in_hours * 60 * 60 * 1000);
    goal.expires_at = expiresAt.toISOString();
  }

  await fs.mkdir(GOALS_DIR, { recursive: true });

  // Allocate the ID and create the YAML file atomically: 'wx' fails with
  // EEXIST instead of silently overwriting an existing goal, and the lock
  // serializes concurrent in-process allocations (TASK-QC-012).
  await withIdAllocationLock(async () => {
    for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt++) {
      goal.id = await nextGoalId();
      const filepath = path.join(GOALS_DIR, `${goal.id}.yaml`);
      try {
        await fs.writeFile(filepath, yaml.dump(goal), { encoding: 'utf-8', flag: 'wx' });
        return;
      } catch (err) {
        // EEXIST: another process claimed this ID between readdir and write — retry.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error(
      `[GoalStore] Could not allocate a unique goal ID after ${MAX_ID_ALLOCATION_ATTEMPTS} attempts`
    );
  });

  await logGoalEvent('CREATED', goal.id, `by ${params.created_by}: ${params.description}`);

  return goal;
}

/**
 * List goals by status
 */
export async function listGoals(status?: GoalStatus): Promise<Goal[]> {
  const goals: Goal[] = [];

  try {
    const files = await fs.readdir(GOALS_DIR);

    for (const file of files) {
      if (!file.endsWith('.yaml') || file === 'README.md') continue;

      const filepath = path.join(GOALS_DIR, file);
      const content = await fs.readFile(filepath, 'utf-8');
      const goal = yaml.load(content) as Goal;

      if (!status || goal.status === status) {
        goals.push(goal);
      }
    }
  } catch (err) {
    // Directory might not exist yet
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('[GoalStore] Error listing goals:', err);
    }
  }

  // Sort by created date (newest first)
  return goals.sort((a, b) => b.created.localeCompare(a.created));
}

/**
 * Get a specific goal by ID
 */
export async function getGoal(goalId: string): Promise<Goal | null> {
  const filepath = path.join(GOALS_DIR, `${goalId}.yaml`);

  try {
    const content = await fs.readFile(filepath, 'utf-8');
    return yaml.load(content) as Goal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Update a goal
 */
export async function updateGoal(goal: Goal): Promise<void> {
  const filepath = path.join(GOALS_DIR, `${goal.id}.yaml`);
  await fs.writeFile(filepath, yaml.dump(goal), 'utf-8');
}

/**
 * Mark goal as triggered (criteria met, Conductor notified)
 */
export async function triggerGoal(
  goalId: string,
  triggerMessageId: string,
  criteriaResults: CriterionResult[]
): Promise<Goal | null> {
  const goal = await getGoal(goalId);
  if (!goal) return null;

  goal.status = 'triggered';
  goal.triggered_at = new Date().toISOString();
  goal.trigger_message_id = triggerMessageId;
  goal.criteria_results = criteriaResults;

  await updateGoal(goal);
  await logGoalEvent('TRIGGERED', goalId, `msg=${triggerMessageId}`);

  return goal;
}

/**
 * Mark goal as completed
 */
export async function completeGoal(goalId: string): Promise<Goal | null> {
  const goal = await getGoal(goalId);
  if (!goal) return null;

  goal.status = 'completed';
  goal.completed_at = new Date().toISOString();

  await updateGoal(goal);
  await logGoalEvent('COMPLETED', goalId);

  return goal;
}

/**
 * Mark goal as expired
 */
export async function expireGoal(goalId: string): Promise<Goal | null> {
  const goal = await getGoal(goalId);
  if (!goal) return null;

  goal.status = 'expired';

  await updateGoal(goal);
  await logGoalEvent('EXPIRED', goalId);

  return goal;
}

// ─── Criteria Checking ────────────────────────────────────────────────────────

/**
 * Check if a DONE outbox exists matching pattern
 */
async function checkDoneOutbox(terminal: string, pattern: string): Promise<{ met: boolean; details: string }> {
  const outboxPath = path.join(TERMINALS_PATH, terminal, 'outbox');

  try {
    const files = await fs.readdir(outboxPath);

    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(regexPattern, 'i');

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      // Check if file matches pattern
      if (regex.test(file)) {
        // Check if it's a DONE type
        const filepath = path.join(outboxPath, file);
        const content = await fs.readFile(filepath, 'utf-8');

        if (content.includes('type: done') || file.toLowerCase().includes('done')) {
          return { met: true, details: `Found: ${file}` };
        }
      }
    }

    return { met: false, details: `No match for pattern: ${pattern}` };
  } catch (err) {
    return { met: false, details: `Error: ${(err as Error).message}` };
  }
}

/**
 * Check checkpoint status in EPICS.yaml
 */
async function checkCheckpointStatus(
  checkpointId: string,
  expectedStatus: string
): Promise<{ met: boolean; details: string }> {
  const epicsPath = getEpicsPath();

  try {
    const content = await fs.readFile(epicsPath, 'utf-8');
    const epics = yaml.load(content) as { epics: Array<{ checkpoints?: Array<{ id: string; status: string }> }> };

    for (const epic of epics.epics) {
      if (!epic.checkpoints) continue;

      for (const cp of epic.checkpoints) {
        if (cp.id === checkpointId) {
          if (cp.status === expectedStatus) {
            return { met: true, details: `Checkpoint ${checkpointId} is ${expectedStatus}` };
          } else {
            return { met: false, details: `Checkpoint ${checkpointId} is ${cp.status}, expected ${expectedStatus}` };
          }
        }
      }
    }

    return { met: false, details: `Checkpoint ${checkpointId} not found` };
  } catch (err) {
    return { met: false, details: `Error: ${(err as Error).message}` };
  }
}

/**
 * Check message status
 */
async function checkMessageStatus(
  messageId: string,
  expectedStatus: string
): Promise<{ met: boolean; details: string }> {
  // Search in all terminal inboxes and outboxes
  const terminalsPath = getTerminalsPath();

  try {
    const terminals = await fs.readdir(terminalsPath);

    for (const terminal of terminals) {
      if (terminal.startsWith('.') || terminal.startsWith('_')) continue;

      for (const box of ['inbox', 'outbox']) {
        const boxPath = path.join(terminalsPath, terminal, box);

        try {
          const files = await fs.readdir(boxPath);

          for (const file of files) {
            if (!file.endsWith('.md')) continue;

            const filepath = path.join(boxPath, file);
            const content = await fs.readFile(filepath, 'utf-8');

            if (content.includes(`id: ${messageId}`)) {
              const statusMatch = content.match(/status:\s*(\w+)/);
              if (statusMatch) {
                const currentStatus = statusMatch[1];
                if (currentStatus.toLowerCase() === expectedStatus.toLowerCase()) {
                  return { met: true, details: `${messageId} is ${currentStatus}` };
                } else {
                  return { met: false, details: `${messageId} is ${currentStatus}, expected ${expectedStatus}` };
                }
              }
            }
          }
        } catch {
          // Box doesn't exist
        }
      }
    }

    return { met: false, details: `Message ${messageId} not found` };
  } catch (err) {
    return { met: false, details: `Error: ${(err as Error).message}` };
  }
}

/**
 * Check single criterion
 */
export async function checkCriterion(criterion: Criterion): Promise<CriterionResult> {
  const now = new Date().toISOString();

  let result: { met: boolean; details: string };

  switch (criterion.type) {
    case 'done_outbox':
      result = await checkDoneOutbox(
        criterion.terminal || '',
        criterion.message_pattern || '*'
      );
      break;

    case 'checkpoint_status':
      result = await checkCheckpointStatus(
        criterion.checkpoint_id || '',
        criterion.expected_status || 'done'
      );
      break;

    case 'message_status':
      result = await checkMessageStatus(
        criterion.message_id || '',
        criterion.expected_status || 'DONE'
      );
      break;

    case 'all_of':
      if (criterion.criteria && criterion.criteria.length > 0) {
        const results = await Promise.all(criterion.criteria.map(c => checkCriterion(c)));
        const allMet = results.every(r => r.met);
        result = {
          met: allMet,
          details: `${results.filter(r => r.met).length}/${results.length} criteria met`,
        };
      } else {
        result = { met: true, details: 'Empty all_of (vacuous truth)' };
      }
      break;

    case 'any_of':
      if (criterion.criteria && criterion.criteria.length > 0) {
        const results = await Promise.all(criterion.criteria.map(c => checkCriterion(c)));
        const anyMet = results.some(r => r.met);
        result = {
          met: anyMet,
          details: `${results.filter(r => r.met).length}/${results.length} criteria met`,
        };
      } else {
        result = { met: false, details: 'Empty any_of' };
      }
      break;

    default:
      result = { met: false, details: `Unknown criterion type: ${criterion.type}` };
  }

  return {
    criterion,
    met: result.met,
    details: result.details,
    checked_at: now,
  };
}

/**
 * Check all criteria for a goal
 */
export async function checkGoalCriteria(goal: Goal): Promise<{
  allMet: boolean;
  results: CriterionResult[];
}> {
  const results: CriterionResult[] = [];

  for (const criterion of goal.completion_criteria) {
    const result = await checkCriterion(criterion);
    results.push(result);
  }

  const allMet = results.every(r => r.met);

  return { allMet, results };
}

// ─── Goal Expiration Check ────────────────────────────────────────────────────

/**
 * Check and expire overdue goals
 */
export async function checkExpiredGoals(): Promise<string[]> {
  const expired: string[] = [];
  const now = new Date();

  const goals = await listGoals('watching');

  for (const goal of goals) {
    if (goal.expires_at) {
      const expiresAt = new Date(goal.expires_at);
      if (now > expiresAt) {
        await expireGoal(goal.id);
        expired.push(goal.id);
      }
    }
  }

  return expired;
}

// ─── Prompt Template Rendering ────────────────────────────────────────────────

/**
 * Render the on_complete prompt with variables
 */
export function renderPrompt(goal: Goal, criteriaResults: CriterionResult[]): string {
  let prompt = goal.on_complete.prompt;

  // Replace variables
  prompt = prompt.replace(/\{\{goal\.description\}\}/g, goal.goal.description);
  prompt = prompt.replace(/\{\{on_complete\.next_goal\}\}/g, goal.on_complete.next_goal || '');

  // Format criteria results
  const criteriaText = criteriaResults
    .map(r => `- ${r.met ? '✓' : '✗'} ${r.criterion.type}: ${r.details}`)
    .join('\n');
  prompt = prompt.replace(/\{\{completed_criteria\}\}/g, criteriaText);

  return prompt;
}
