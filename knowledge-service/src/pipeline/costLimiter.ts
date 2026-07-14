// Cost Limiter - Budget-based dynamic limits for parallel workers
// Part of ADR-049 Phase 3: Parallel Workers

import { getActiveWorkers, type WorkerState } from './workerRegistry';

// Model costs per minute (approximate, in USD)
const MODEL_COSTS: Record<string, number> = {
  haiku: 0.002, // $0.12/hour
  sonnet: 0.02, // $1.20/hour
  opus: 0.1, // $6.00/hour
};

// Budget limits (USD per hour)
export const SOFT_LIMIT_PER_HOUR = 3; // Log warning
export const HARD_LIMIT_PER_HOUR = 5; // Telegram alert
export const CRITICAL_LIMIT_PER_HOUR = 10; // Auto-kill + escalate

export const HARD_MAX_PARALLEL = 5; // Absolute maximum workers

export interface CostState {
  terminal: string;
  currentHourlyCost: number;
  activeWorkers: Array<{ id: string; model: string; startedAt: Date; runningMinutes: number }>;
  maxParallel: number;
  alertLevel: 'ok' | 'soft' | 'hard' | 'critical';
}

/**
 * Get current cost state for a terminal
 */
export function getCostState(terminal: string): CostState {
  const workers = getActiveWorkers(terminal);
  const currentHourlyCost = getCurrentHourlyCost(terminal);
  const maxParallel = calculateMaxParallel(terminal);
  const alertLevel = checkCostAlerts(terminal);

  const activeWorkers = workers.map((w) => {
    const startedAt = new Date(w.startedAt);
    const runningMinutes = (Date.now() - startedAt.getTime()) / 60000;

    return {
      id: w.id,
      model: w.model,
      startedAt,
      runningMinutes,
    };
  });

  return {
    terminal,
    currentHourlyCost,
    activeWorkers,
    maxParallel,
    alertLevel,
  };
}

/**
 * Calculate current hourly cost rate for a terminal
 * Returns the projected cost per hour if all active workers continue running
 */
export function getCurrentHourlyCost(terminal: string): number {
  const workers = getActiveWorkers(terminal);
  let hourlyCost = 0;

  for (const worker of workers) {
    const costPerMinute = MODEL_COSTS[worker.model] || MODEL_COSTS.sonnet;
    hourlyCost += costPerMinute * 60; // Convert to hourly rate
  }

  return hourlyCost;
}

/**
 * Calculate maximum parallel workers allowed based on budget
 */
export function calculateMaxParallel(terminal: string): number {
  const currentCost = getCurrentHourlyCost(terminal);
  const workers = getActiveWorkers(terminal);

  // If no workers running, allow up to HARD_MAX_PARALLEL
  if (workers.length === 0) {
    return HARD_MAX_PARALLEL;
  }

  // Average model cost (assume Sonnet by default)
  const avgModelCost = 0.02;
  const projectedHourlyCost = currentCost + avgModelCost * 60;

  // Critical: no more workers
  if (projectedHourlyCost >= CRITICAL_LIMIT_PER_HOUR) {
    return 0;
  }

  // Hard limit: only 1 more worker allowed
  if (projectedHourlyCost >= HARD_LIMIT_PER_HOUR) {
    return Math.min(1, HARD_MAX_PARALLEL - workers.length);
  }

  // Dynamic calculation based on budget headroom
  const headroom = HARD_LIMIT_PER_HOUR - currentCost;
  const maxByBudget = Math.floor(headroom / (avgModelCost * 60));

  return Math.min(maxByBudget, HARD_MAX_PARALLEL);
}

/**
 * Check cost alert level
 */
export function checkCostAlerts(terminal: string): 'ok' | 'soft' | 'hard' | 'critical' {
  const hourlyCost = getCurrentHourlyCost(terminal);

  if (hourlyCost >= CRITICAL_LIMIT_PER_HOUR) return 'critical';
  if (hourlyCost >= HARD_LIMIT_PER_HOUR) return 'hard';
  if (hourlyCost >= SOFT_LIMIT_PER_HOUR) return 'soft';
  return 'ok';
}

/**
 * Get cost per minute for a model
 */
export function getModelCostPerMinute(model: string): number {
  return MODEL_COSTS[model] || MODEL_COSTS.sonnet;
}

/**
 * Estimate cost for a task duration
 */
export function estimateTaskCost(model: string, estimatedMinutes: number): number {
  const costPerMinute = getModelCostPerMinute(model);
  return costPerMinute * estimatedMinutes;
}

/**
 * Check if terminal can spawn another worker
 */
export function canSpawnWorker(terminal: string, model: string = 'sonnet'): {
  allowed: boolean;
  reason?: string;
  currentCost: number;
  maxParallel: number;
} {
  const currentCost = getCurrentHourlyCost(terminal);
  const maxParallel = calculateMaxParallel(terminal);
  const workers = getActiveWorkers(terminal);

  if (workers.length >= HARD_MAX_PARALLEL) {
    return {
      allowed: false,
      reason: `Reached max parallel workers (${HARD_MAX_PARALLEL})`,
      currentCost,
      maxParallel,
    };
  }

  // Check if adding this specific model would exceed budget
  const modelCostPerHour = getModelCostPerMinute(model) * 60;
  const projectedCost = currentCost + modelCostPerHour;

  if (projectedCost >= CRITICAL_LIMIT_PER_HOUR) {
    return {
      allowed: false,
      reason: `Adding ${model} worker would exceed critical cost limit ($${projectedCost.toFixed(2)}/hour)`,
      currentCost,
      maxParallel,
    };
  }

  if (maxParallel === 0) {
    return {
      allowed: false,
      reason: `Budget limit reached ($${currentCost.toFixed(2)}/hour)`,
      currentCost,
      maxParallel,
    };
  }

  return {
    allowed: true,
    currentCost,
    maxParallel,
  };
}

/**
 * Get human-readable cost alert message
 */
export function getCostAlertMessage(terminal: string): string | null {
  const alertLevel = checkCostAlerts(terminal);
  const cost = getCurrentHourlyCost(terminal);

  switch (alertLevel) {
    case 'soft':
      return `⚠️  Soft limit reached: $${cost.toFixed(2)}/hour (limit: $${SOFT_LIMIT_PER_HOUR})`;
    case 'hard':
      return `🚨 Hard limit reached: $${cost.toFixed(2)}/hour (limit: $${HARD_LIMIT_PER_HOUR})`;
    case 'critical':
      return `💀 CRITICAL: $${cost.toFixed(2)}/hour (limit: $${CRITICAL_LIMIT_PER_HOUR}) - Auto-kill initiated`;
    default:
      return null;
  }
}
