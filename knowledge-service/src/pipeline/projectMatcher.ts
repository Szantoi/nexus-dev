/**
 * Project Task Matcher (Track A)
 *
 * Matches DONE outbox messages to tasks in project TASKS.yaml files.
 *
 * Matching strategy:
 * 1. Exact match by msg_id
 * 2. Match by ref (if DONE has ref field)
 * 3. Fuzzy match: same terminal + status in_progress
 */

import { Task, TaskChain, DoneMessage } from './projectDispatcher';

/**
 * Match DONE message to a task in the task chain
 *
 * @param tasks Task chain from TASKS.yaml
 * @param done DONE message from outbox
 * @returns Matched task or null
 */
export function matchDoneToTask(tasks: TaskChain, done: DoneMessage): Task | null {
  // 1. Exact match by msg_id
  const exactMatch = tasks.milestones
    .flatMap(m => m.tasks)
    .find(t => t.msg_id === done.task_id);

  if (exactMatch) {
    console.log(`[ProjectMatcher] Exact match by msg_id: ${done.task_id}`);
    return exactMatch;
  }

  // 2. Match by ref (if the DONE message has a ref field)
  if (done.ref) {
    const refMatch = tasks.milestones
      .flatMap(m => m.tasks)
      .find(t => t.msg_id === done.ref);

    if (refMatch) {
      console.log(`[ProjectMatcher] Match by ref: ${done.ref}`);
      return refMatch;
    }
  }

  // 3. Fuzzy match: same terminal + status in_progress
  // This is a fallback for cases where msg_id wasn't tracked properly
  const fuzzyMatch = tasks.milestones
    .flatMap(m => m.tasks)
    .find(t =>
      t.terminal === done.from &&
      t.status === 'in_progress'
    );

  if (fuzzyMatch) {
    console.log(`[ProjectMatcher] Fuzzy match for terminal ${done.from}: task ${fuzzyMatch.id}`);
    return fuzzyMatch;
  }

  // No match found
  console.log(`[ProjectMatcher] No match found for ${done.task_id} from ${done.from}`);
  return null;
}

/**
 * Match DONE message to task with additional validation
 *
 * This variant performs stricter validation to avoid false positives.
 *
 * @param tasks Task chain
 * @param done DONE message
 * @param options Matching options
 * @returns Matched task or null
 */
export function matchDoneToTaskStrict(
  tasks: TaskChain,
  done: DoneMessage,
  options: {
    allowFuzzy?: boolean;
    requireInProgress?: boolean;
  } = {}
): Task | null {
  const {
    allowFuzzy = true,
    requireInProgress = true,
  } = options;

  // 1. Exact match by msg_id
  const exactMatch = tasks.milestones
    .flatMap(m => m.tasks)
    .find(t => t.msg_id === done.task_id);

  if (exactMatch) {
    // Verify status if required
    if (requireInProgress && exactMatch.status !== 'in_progress') {
      console.warn(
        `[ProjectMatcher] Task ${exactMatch.id} found but status is ${exactMatch.status}, expected in_progress`
      );
      return null;
    }
    return exactMatch;
  }

  // 2. Match by ref
  if (done.ref) {
    const refMatch = tasks.milestones
      .flatMap(m => m.tasks)
      .find(t => t.msg_id === done.ref);

    if (refMatch) {
      if (requireInProgress && refMatch.status !== 'in_progress') {
        console.warn(
          `[ProjectMatcher] Ref task ${refMatch.id} found but status is ${refMatch.status}, expected in_progress`
        );
        return null;
      }
      return refMatch;
    }
  }

  // 3. Fuzzy match (if allowed)
  if (allowFuzzy) {
    const fuzzyMatch = tasks.milestones
      .flatMap(m => m.tasks)
      .find(t =>
        t.terminal === done.from &&
        t.status === 'in_progress'
      );

    if (fuzzyMatch) {
      return fuzzyMatch;
    }
  }

  return null;
}

/**
 * Find all tasks for a specific terminal
 *
 * @param tasks Task chain
 * @param terminal Terminal name
 * @returns Array of tasks
 */
export function findTasksByTerminal(tasks: TaskChain, terminal: string): Task[] {
  return tasks.milestones
    .flatMap(m => m.tasks)
    .filter(t => t.terminal === terminal);
}

/**
 * Find all tasks with a specific status
 *
 * @param tasks Task chain
 * @param status Task status
 * @returns Array of tasks
 */
export function findTasksByStatus(
  tasks: TaskChain,
  status: Task['status']
): Task[] {
  return tasks.milestones
    .flatMap(m => m.tasks)
    .filter(t => t.status === status);
}

/**
 * Find task by ID
 *
 * @param tasks Task chain
 * @param taskId Task ID
 * @returns Task or null
 */
export function findTaskById(tasks: TaskChain, taskId: string): Task | null {
  for (const milestone of tasks.milestones) {
    const task = milestone.tasks.find(t => t.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

/**
 * Get all in-progress tasks (useful for detecting stuck tasks)
 *
 * @param tasks Task chain
 * @returns Array of in-progress tasks
 */
export function getInProgressTasks(tasks: TaskChain): Task[] {
  return findTasksByStatus(tasks, 'in_progress');
}

/**
 * Get all blocked tasks
 *
 * @param tasks Task chain
 * @returns Array of blocked tasks
 */
export function getBlockedTasks(tasks: TaskChain): Task[] {
  return findTasksByStatus(tasks, 'blocked');
}

/**
 * Check if a task is unblocked (all dependencies done)
 *
 * @param tasks Task chain
 * @param task Task to check
 * @returns True if unblocked
 */
export function isTaskUnblocked(tasks: TaskChain, task: Task): boolean {
  return task.blocked_by.every(blockerId => {
    const blocker = findTaskById(tasks, blockerId);
    return blocker && blocker.status === 'done';
  });
}

/**
 * Get all tasks that would be unblocked if a specific task completes
 *
 * @param tasks Task chain
 * @param completedTaskId ID of the completed task
 * @returns Array of tasks that would become unblocked
 */
export function getTasksUnblockedBy(
  tasks: TaskChain,
  completedTaskId: string
): Task[] {
  return tasks.milestones
    .flatMap(m => m.tasks)
    .filter(t =>
      t.status === 'pending' &&
      t.blocked_by.includes(completedTaskId) &&
      isTaskUnblocked(tasks, t)
    );
}

/**
 * Validate task chain for circular dependencies
 *
 * @param tasks Task chain
 * @returns Validation result
 */
export function validateTaskChain(tasks: TaskChain): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (const milestone of tasks.milestones) {
    for (const task of milestone.tasks) {
      // Check for self-blocking
      if (task.blocked_by.includes(task.id)) {
        errors.push(`Task ${task.id} blocks itself`);
      }

      // Check for non-existent blockers
      for (const blockerId of task.blocked_by) {
        if (!findTaskById(tasks, blockerId)) {
          errors.push(`Task ${task.id} blocked by non-existent task ${blockerId}`);
        }
      }

      // Check for non-existent triggers
      for (const triggerId of task.triggers_on_done) {
        if (!findTaskById(tasks, triggerId)) {
          errors.push(`Task ${task.id} triggers non-existent task ${triggerId}`);
        }
      }
    }
  }

  // TODO: Add circular dependency detection (DFS/BFS cycle detection)

  return {
    valid: errors.length === 0,
    errors,
  };
}
