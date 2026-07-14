// DAG Validator - Validate task dependencies using Kahn's Algorithm
// Part of ADR-049 Phase 3: Parallel Workers

export interface WorkTask {
  id: string;
  depends_on: string[];
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  executionOrder?: string[];
}

/**
 * Validate task dependencies using Kahn's algorithm (topological sort)
 * Returns execution order or error if circular dependency detected
 */
export function validateDependencies(tasks: WorkTask[]): ValidationResult {
  if (tasks.length === 0) {
    return { valid: true, executionOrder: [] };
  }

  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Build graph and initialize in-degrees
  for (const task of tasks) {
    graph.set(task.id, task.depends_on || []);
    if (!inDegree.has(task.id)) {
      inDegree.set(task.id, 0);
    }
  }

  // Calculate in-degrees (number of dependencies each task has)
  for (const [taskId, deps] of graph) {
    inDegree.set(taskId, deps.length);

    // Ensure all dependency targets exist
    for (const dep of deps) {
      if (!graph.has(dep)) {
        return {
          valid: false,
          error: `Dependency not found: ${taskId} depends on ${dep}, but ${dep} does not exist`,
        };
      }
    }
  }

  // Kahn's algorithm - topological sort
  const queue: string[] = [];
  const executionOrder: string[] = [];

  // Start with tasks that have no dependencies
  for (const [taskId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(taskId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    executionOrder.push(current);

    // Find tasks that depend on current
    for (const [taskId, deps] of graph) {
      if (deps.includes(current)) {
        const newDegree = inDegree.get(taskId)! - 1;
        inDegree.set(taskId, newDegree);
        if (newDegree === 0) {
          queue.push(taskId);
        }
      }
    }
  }

  // Cycle detection - if not all tasks were processed, there's a cycle
  if (executionOrder.length !== tasks.length) {
    const cycleNodes = tasks
      .filter((t) => !executionOrder.includes(t.id))
      .map((t) => t.id);

    return {
      valid: false,
      error: `Circular dependency detected involving tasks: ${cycleNodes.join(', ')}`,
    };
  }

  return { valid: true, executionOrder };
}

/**
 * Identify tasks that can run in parallel (same "level" in DAG)
 * Returns batches of tasks that can execute concurrently
 */
export function getParallelBatches(tasks: WorkTask[]): string[][] {
  const result = validateDependencies(tasks);
  if (!result.valid) {
    throw new Error(result.error);
  }

  const levels = new Map<string, number>();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Calculate level for each task (max of dependency levels + 1)
  for (const taskId of result.executionOrder!) {
    const task = taskMap.get(taskId)!;
    const depLevels = (task.depends_on || []).map((dep) => levels.get(dep) || 0);
    const level = depLevels.length > 0 ? Math.max(...depLevels) + 1 : 0;
    levels.set(taskId, level);
  }

  // Group tasks by level
  const batches: Map<number, string[]> = new Map();
  for (const [taskId, level] of levels) {
    if (!batches.has(level)) {
      batches.set(level, []);
    }
    batches.get(level)!.push(taskId);
  }

  // Return batches in order
  return Array.from(batches.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([_, taskIds]) => taskIds);
}

/**
 * Get maximum parallel execution width (max tasks in a single batch)
 */
export function getMaxParallelWidth(tasks: WorkTask[]): number {
  try {
    const batches = getParallelBatches(tasks);
    return Math.max(...batches.map((b) => b.length));
  } catch {
    return 0;
  }
}

/**
 * Check if a task can start (all dependencies done)
 */
export function canTaskStart(
  taskId: string,
  tasks: WorkTask[],
  completedTasks: string[]
): boolean {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return false;
  }

  // Check if all dependencies are in completedTasks
  return (task.depends_on || []).every((dep) => completedTasks.includes(dep));
}
