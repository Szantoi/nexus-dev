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

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const GOALS_DIR = process.env.GOALS_DIR || `${SPACEOS_ROOT}/store/goals`;
const GOALS_LOG = `${SPACEOS_ROOT}/logs/dispatcher/goals.log`;

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

function generateGoalId(): string {
  const date = new Date().toISOString().split('T')[0];
  const seq = Date.now().toString().slice(-3);
  return `GOAL-${date}-${seq}`;
}

async function logGoalEvent(event: string, goalId: string, details?: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${event}] ${goalId}${details ? ` - ${details}` : ''}\n`;

  try {
    await fs.mkdir(path.dirname(GOALS_LOG), { recursive: true });
    await fs.appendFile(GOALS_LOG, line);
  } catch (err) {
    console.error('[GoalStore] Failed to log:', err);
  }

  await log(`[GoalStore] ${event}: ${goalId}${details ? ` - ${details}` : ''}`);
}

// ─── CRUD Operations ──────────────────────────────────────────────────────────

/**
 * Create a new goal
 */
export async function createGoal(params: CreateGoalParams): Promise<Goal> {
  const id = generateGoalId();
  const now = new Date().toISOString();

  const goal: Goal = {
    id,
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

  // Write YAML file
  const filename = `${id}.yaml`;
  const filepath = path.join(GOALS_DIR, filename);

  await fs.mkdir(GOALS_DIR, { recursive: true });
  await fs.writeFile(filepath, yaml.dump(goal), 'utf-8');

  await logGoalEvent('CREATED', id, `by ${params.created_by}: ${params.description}`);

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
      console.error('[GoalStore] Error listing goals:', err);
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
  const outboxPath = `/opt/spaceos/terminals/${terminal}/outbox`;

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
  const epicsPath = process.env.EPICS_PATH || `${SPACEOS_ROOT}/docs/projects/EPICS.yaml`;

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
  const terminalsPath = process.env.TERMINALS_PATH || `${SPACEOS_ROOT}/terminals`;

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
