// Worker Registry - Track parallel work session states
// Part of ADR-049 Phase 3: Parallel Workers

export interface WorkerState {
  id: string;
  terminal: string;
  taskId: string;
  status: 'running' | 'done' | 'failed' | 'queued';
  startedAt: string;
  completedAt?: string;
  failureReason?: string;
  depends_on: string[];
  model: string;
  sessionName: string;
}

export interface WorkSessionConfig {
  terminal: string;
  taskId: string;
  prompt?: string; // Optional prompt to inject into session
  model: 'haiku' | 'sonnet' | 'opus';
  depends_on?: string[];
}

// In-memory worker registry
const workers: Map<string, WorkerState> = new Map();

/**
 * Register a new worker session
 */
export function registerWorker(id: string, config: WorkSessionConfig, sessionName: string): void {
  workers.set(id, {
    id,
    terminal: config.terminal,
    taskId: config.taskId,
    status: 'running',
    startedAt: new Date().toISOString(),
    depends_on: config.depends_on || [],
    model: config.model,
    sessionName,
  });

  console.log(`[WorkerRegistry] Registered worker: ${id} (${config.model}, task: ${config.taskId})`);
}

/**
 * Get all active workers for a terminal
 */
export function getActiveWorkers(terminal: string): WorkerState[] {
  return Array.from(workers.values()).filter(
    (w) => w.terminal === terminal && w.status === 'running'
  );
}

/**
 * Get all worker IDs for a terminal
 */
export function getActiveWorkerIds(terminal: string): string[] {
  return getActiveWorkers(terminal).map((w) => w.id);
}

/**
 * Get worker by ID
 */
export function getWorker(id: string): WorkerState | undefined {
  return workers.get(id);
}

/**
 * Get all workers (for status reporting)
 */
export function getAllWorkers(): WorkerState[] {
  return Array.from(workers.values());
}

/**
 * Mark worker as done and trigger dependent workers
 */
export function markWorkerDone(id: string): void {
  const worker = workers.get(id);
  if (!worker) {
    console.warn(`[WorkerRegistry] Worker not found: ${id}`);
    return;
  }

  worker.status = 'done';
  worker.completedAt = new Date().toISOString();
  console.log(`[WorkerRegistry] Worker ${id} marked as DONE`);

  // Trigger dependent workers (workers that depend on this one)
  triggerDependentWorkers(id);
}

/**
 * Mark worker as failed
 */
export function markWorkerFailed(id: string, reason?: string): void {
  const worker = workers.get(id);
  if (!worker) {
    console.warn(`[WorkerRegistry] Worker not found: ${id}`);
    return;
  }

  worker.status = 'failed';
  worker.completedAt = new Date().toISOString();
  worker.failureReason = reason;
  console.error(`[WorkerRegistry] Worker ${id} marked as FAILED: ${reason || 'Unknown error'}`);
}

/**
 * Trigger workers that depend on the completed worker
 */
function triggerDependentWorkers(completedWorkerId: string): void {
  const queuedWorkers = Array.from(workers.values()).filter(
    (w) => w.status === 'queued' && w.depends_on.includes(completedWorkerId)
  );

  for (const worker of queuedWorkers) {
    // Check if all dependencies are done
    const allDone = worker.depends_on.every((depId) => {
      const dep = workers.get(depId);
      return dep?.status === 'done';
    });

    if (allDone) {
      console.log(`[WorkerRegistry] All dependencies done for ${worker.id}, ready to start`);
      // TODO: Trigger session start (will be implemented in sessionStarter.ts)
    }
  }
}

/**
 * Check if dependencies are satisfied
 * Takes task IDs (not worker IDs) and returns task IDs that are not yet done
 */
export async function checkDependencies(depends_on: string[]): Promise<string[]> {
  const unfinished: string[] = [];

  for (const taskId of depends_on) {
    // Find worker by taskId
    const worker = Array.from(workers.values()).find(w => w.taskId === taskId);

    if (!worker || worker.status !== 'done') {
      unfinished.push(taskId);
    }
  }

  return unfinished;
}

/**
 * Queue a worker for later execution
 */
export function queueWorker(id: string, config: WorkSessionConfig): void {
  workers.set(id, {
    id,
    terminal: config.terminal,
    taskId: config.taskId,
    status: 'queued',
    startedAt: new Date().toISOString(),
    depends_on: config.depends_on || [],
    model: config.model,
    sessionName: '', // Will be set when actually started
  });

  console.log(`[WorkerRegistry] Worker ${id} queued, waiting for dependencies: ${config.depends_on?.join(', ')}`);
}

/**
 * Remove worker from registry (cleanup after completion)
 */
export function removeWorker(id: string): void {
  workers.delete(id);
  console.log(`[WorkerRegistry] Worker ${id} removed from registry`);
}

/**
 * Clear all workers (for testing)
 */
export function clearRegistry(): void {
  workers.clear();
  console.log('[WorkerRegistry] Registry cleared');
}

/**
 * Process queued workers - start any workers whose dependencies are complete
 * Returns list of workers that were started
 */
export async function processQueue(
  spawner: (config: WorkSessionConfig) => Promise<{ success: boolean; sessionName?: string }>
): Promise<string[]> {
  const started: string[] = [];
  const queuedWorkers = Array.from(workers.values()).filter(w => w.status === 'queued');

  for (const worker of queuedWorkers) {
    // Check if all dependencies are done
    const unfinished = await checkDependencies(worker.depends_on);

    if (unfinished.length === 0) {
      // All dependencies complete, start worker
      const config: WorkSessionConfig = {
        terminal: worker.terminal,
        taskId: worker.taskId,
        model: worker.model as 'haiku' | 'sonnet' | 'opus',
        depends_on: worker.depends_on,
      };

      const result = await spawner(config);

      if (result.success && result.sessionName) {
        worker.status = 'running';
        worker.sessionName = result.sessionName;
        worker.startedAt = new Date().toISOString();
        started.push(worker.id);
        console.log(`[WorkerRegistry] Queued worker ${worker.id} started (dependencies complete)`);
      }
    }
  }

  return started;
}
