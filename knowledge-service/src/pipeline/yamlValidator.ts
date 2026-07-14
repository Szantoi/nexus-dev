/**
 * YAML Schema Validator (Track A)
 *
 * Validates TASKS.yaml files against the Project Automation schema v1.0.
 *
 * Validation Rules (from architecture spec):
 * - V1: version field required
 * - V2: All task IDs unique within project
 * - V3: blocked_by references exist
 * - V4: triggers_on_done references exist
 * - V5: No circular dependencies (DAG validation)
 * - V6: Terminal names valid
 * - V7: Model names valid (sonnet, opus, haiku)
 */

import { TaskChain, Task } from './projectDispatcher';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  path?: string;
}

/**
 * Valid terminal names (from 7-terminal architecture)
 */
const VALID_TERMINALS = [
  'root',
  'conductor',
  'architect',
  'librarian',
  'explorer',
  'backend',
  'frontend',
  'designer',
];

/**
 * Valid model names
 */
const VALID_MODELS = ['sonnet', 'opus', 'haiku'];

/**
 * Valid task statuses
 */
const VALID_TASK_STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'escalated'];

/**
 * Valid milestone statuses
 */
const VALID_MILESTONE_STATUSES = ['pending', 'in_progress', 'done'];

/**
 * Valid priority levels
 */
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];

/**
 * Validate TASKS.yaml schema
 *
 * @param tasks Parsed TASKS.yaml content
 * @returns Validation result
 */
export function validateTasksYaml(tasks: any): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // V1: Version field required
  if (!tasks.version) {
    errors.push({
      code: 'V1_MISSING_VERSION',
      message: 'Missing required field: version',
      path: 'version',
    });
  } else if (tasks.version !== '1.0') {
    warnings.push({
      code: 'V1_VERSION_MISMATCH',
      message: `Expected version 1.0, got ${tasks.version}`,
      path: 'version',
    });
  }

  // Required top-level fields
  if (!tasks.project) {
    errors.push({
      code: 'MISSING_PROJECT',
      message: 'Missing required field: project',
      path: 'project',
    });
  }

  if (!tasks.created) {
    errors.push({
      code: 'MISSING_CREATED',
      message: 'Missing required field: created',
      path: 'created',
    });
  }

  if (!tasks.updated) {
    errors.push({
      code: 'MISSING_UPDATED',
      message: 'Missing required field: updated',
      path: 'updated',
    });
  }

  if (!tasks.config) {
    errors.push({
      code: 'MISSING_CONFIG',
      message: 'Missing required field: config',
      path: 'config',
    });
  }

  if (!tasks.milestones || !Array.isArray(tasks.milestones)) {
    errors.push({
      code: 'MISSING_MILESTONES',
      message: 'Missing or invalid field: milestones (must be array)',
      path: 'milestones',
    });
    // Can't continue without milestones
    return { valid: false, errors, warnings };
  }

  // Collect all task IDs for V2 validation
  const allTaskIds = new Set<string>();
  const taskMap = new Map<string, Task>();

  // Validate each milestone
  tasks.milestones.forEach((milestone: any, mIndex: number) => {
    const mPath = `milestones[${mIndex}]`;

    // Milestone required fields
    if (!milestone.id) {
      errors.push({
        code: 'MISSING_MILESTONE_ID',
        message: 'Missing milestone.id',
        path: `${mPath}.id`,
      });
    }

    if (!milestone.name) {
      errors.push({
        code: 'MISSING_MILESTONE_NAME',
        message: 'Missing milestone.name',
        path: `${mPath}.name`,
      });
    }

    if (!milestone.status) {
      errors.push({
        code: 'MISSING_MILESTONE_STATUS',
        message: 'Missing milestone.status',
        path: `${mPath}.status`,
      });
    } else if (!VALID_MILESTONE_STATUSES.includes(milestone.status)) {
      errors.push({
        code: 'INVALID_MILESTONE_STATUS',
        message: `Invalid milestone.status: ${milestone.status}. Must be one of: ${VALID_MILESTONE_STATUSES.join(', ')}`,
        path: `${mPath}.status`,
      });
    }

    if (!Array.isArray(milestone.tasks)) {
      errors.push({
        code: 'MISSING_MILESTONE_TASKS',
        message: 'Missing or invalid milestone.tasks (must be array)',
        path: `${mPath}.tasks`,
      });
      return;
    }

    // Validate each task
    milestone.tasks.forEach((task: any, tIndex: number) => {
      const tPath = `${mPath}.tasks[${tIndex}]`;

      // V2: Unique task IDs
      if (!task.id) {
        errors.push({
          code: 'MISSING_TASK_ID',
          message: 'Missing task.id',
          path: `${tPath}.id`,
        });
      } else {
        if (allTaskIds.has(task.id)) {
          errors.push({
            code: 'V2_DUPLICATE_TASK_ID',
            message: `Duplicate task ID: ${task.id}`,
            path: `${tPath}.id`,
          });
        }
        allTaskIds.add(task.id);
        taskMap.set(task.id, task);
      }

      // Required task fields
      if (!task.name) {
        errors.push({
          code: 'MISSING_TASK_NAME',
          message: 'Missing task.name',
          path: `${tPath}.name`,
        });
      }

      if (!task.terminal) {
        errors.push({
          code: 'MISSING_TASK_TERMINAL',
          message: 'Missing task.terminal',
          path: `${tPath}.terminal`,
        });
      } else if (!VALID_TERMINALS.includes(task.terminal)) {
        errors.push({
          code: 'V6_INVALID_TERMINAL',
          message: `Invalid terminal: ${task.terminal}. Must be one of: ${VALID_TERMINALS.join(', ')}`,
          path: `${tPath}.terminal`,
        });
      }

      // V7: Model validation
      if (task.model && !VALID_MODELS.includes(task.model)) {
        errors.push({
          code: 'V7_INVALID_MODEL',
          message: `Invalid model: ${task.model}. Must be one of: ${VALID_MODELS.join(', ')}`,
          path: `${tPath}.model`,
        });
      }

      // Priority validation
      if (task.priority && !VALID_PRIORITIES.includes(task.priority)) {
        warnings.push({
          code: 'INVALID_PRIORITY',
          message: `Invalid priority: ${task.priority}. Recommended: ${VALID_PRIORITIES.join(', ')}`,
          path: `${tPath}.priority`,
        });
      }

      // Status validation
      if (!task.status) {
        errors.push({
          code: 'MISSING_TASK_STATUS',
          message: 'Missing task.status',
          path: `${tPath}.status`,
        });
      } else if (!VALID_TASK_STATUSES.includes(task.status)) {
        errors.push({
          code: 'INVALID_TASK_STATUS',
          message: `Invalid task.status: ${task.status}. Must be one of: ${VALID_TASK_STATUSES.join(', ')}`,
          path: `${tPath}.status`,
        });
      }

      // blocked_by must be array
      if (!Array.isArray(task.blocked_by)) {
        errors.push({
          code: 'INVALID_BLOCKED_BY',
          message: 'task.blocked_by must be an array',
          path: `${tPath}.blocked_by`,
        });
      }

      // triggers_on_done must be array
      if (!Array.isArray(task.triggers_on_done)) {
        errors.push({
          code: 'INVALID_TRIGGERS',
          message: 'task.triggers_on_done must be an array',
          path: `${tPath}.triggers_on_done`,
        });
      }
    });
  });

  // V3: blocked_by references exist
  taskMap.forEach((task, taskId) => {
    if (Array.isArray(task.blocked_by)) {
      task.blocked_by.forEach((blockerId: string) => {
        if (!taskMap.has(blockerId)) {
          errors.push({
            code: 'V3_INVALID_BLOCKER',
            message: `Task ${taskId} blocked by non-existent task: ${blockerId}`,
            path: `task.${taskId}.blocked_by`,
          });
        }
      });
    }
  });

  // V4: triggers_on_done references exist
  taskMap.forEach((task, taskId) => {
    if (Array.isArray(task.triggers_on_done)) {
      task.triggers_on_done.forEach((triggerId: string) => {
        if (!taskMap.has(triggerId)) {
          errors.push({
            code: 'V4_INVALID_TRIGGER',
            message: `Task ${taskId} triggers non-existent task: ${triggerId}`,
            path: `task.${taskId}.triggers_on_done`,
          });
        }
      });
    }
  });

  // V5: No circular dependencies (DAG validation)
  const circularDeps = detectCircularDependencies(taskMap);
  circularDeps.forEach(cycle => {
    errors.push({
      code: 'V5_CIRCULAR_DEPENDENCY',
      message: `Circular dependency detected: ${cycle.join(' → ')}`,
      path: 'tasks',
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Detect circular dependencies using DFS
 *
 * @param taskMap Map of task ID to task
 * @returns Array of circular dependency cycles
 */
function detectCircularDependencies(taskMap: Map<string, Task>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(taskId: string): void {
    visited.add(taskId);
    recursionStack.add(taskId);
    path.push(taskId);

    const task = taskMap.get(taskId);
    if (!task) return;

    // Follow blocked_by edges (if A blocks B, then B depends on A)
    if (Array.isArray(task.blocked_by)) {
      for (const blockerId of task.blocked_by) {
        if (!visited.has(blockerId)) {
          dfs(blockerId);
        } else if (recursionStack.has(blockerId)) {
          // Cycle detected
          const cycleStart = path.indexOf(blockerId);
          const cycle = path.slice(cycleStart);
          cycle.push(blockerId); // Close the cycle
          cycles.push(cycle);
        }
      }
    }

    path.pop();
    recursionStack.delete(taskId);
  }

  // Run DFS from each unvisited task
  taskMap.forEach((_, taskId) => {
    if (!visited.has(taskId)) {
      dfs(taskId);
    }
  });

  return cycles;
}

/**
 * Validate task chain at runtime (for dispatcher)
 *
 * @param tasks Task chain
 * @returns Validation result
 */
export function validateTaskChainRuntime(tasks: TaskChain): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Check for orphaned in_progress tasks (task started but no inbox_path)
  tasks.milestones.forEach((milestone, mIndex) => {
    milestone.tasks.forEach((task, tIndex) => {
      if (task.status === 'in_progress' && !task.inbox_path) {
        warnings.push({
          code: 'ORPHANED_IN_PROGRESS',
          message: `Task ${task.id} is in_progress but has no inbox_path`,
          path: `milestones[${mIndex}].tasks[${tIndex}]`,
        });
      }

      if (task.status === 'in_progress' && !task.msg_id) {
        warnings.push({
          code: 'MISSING_MSG_ID',
          message: `Task ${task.id} is in_progress but has no msg_id`,
          path: `milestones[${mIndex}].tasks[${tIndex}]`,
        });
      }

      // Check for high retry count
      if (task.retry_count && task.retry_count >= 2) {
        warnings.push({
          code: 'HIGH_RETRY_COUNT',
          message: `Task ${task.id} has high retry count: ${task.retry_count}`,
          path: `milestones[${mIndex}].tasks[${tIndex}]`,
        });
      }
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Format validation result as human-readable string
 *
 * @param result Validation result
 * @returns Formatted string
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push('✅ Validation passed');
  } else {
    lines.push('❌ Validation failed');
  }

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('Errors:');
    result.errors.forEach((error, i) => {
      lines.push(`  ${i + 1}. [${error.code}] ${error.message}${error.path ? ` (${error.path})` : ''}`);
    });
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    result.warnings.forEach((warning, i) => {
      lines.push(`  ${i + 1}. [${warning.code}] ${warning.message}${warning.path ? ` (${warning.path})` : ''}`);
    });
  }

  return lines.join('\n');
}
