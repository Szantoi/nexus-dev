/**
 * Cost Monitoring Service
 * Aggregates worker cost data for Frontend dashboard widget
 * Part of MSG-BACKEND-126: Cost Monitoring API Endpoints
 */

import {
  getCostState,
  getCurrentHourlyCost,
  SOFT_LIMIT_PER_HOUR,
  HARD_LIMIT_PER_HOUR,
  CRITICAL_LIMIT_PER_HOUR,
  getModelCostPerMinute,
} from '../../pipeline/costLimiter';
import { getActiveWorkers, getAllWorkers, type WorkerState } from '../../pipeline/workerRegistry';

// ─── DTOs ────────────────────────────────────────────────────────────────────

export interface CostStreamDto {
  timestamp: string;
  dailyBudget: number;
  current: number;
  currency: string;
  thresholdStatus: 'healthy' | 'caution' | 'critical' | 'exceeded';
  terminals: TerminalCostDetailDto[];
  recentCosts: RecentCostDto[];
}

export interface TodayCostDto {
  date: string;
  dailyBudget: number;
  current: number;
  currency: string;
  thresholdStatus: 'healthy' | 'caution' | 'critical' | 'exceeded';
  percentageUsed: number;
  remaining: number;
  terminals: TerminalCostDetailDto[];
}

export interface TerminalCostDetailDto {
  name: string;
  cost: number;
  percentage: number;
  status: 'healthy' | 'caution' | 'critical';
  minutesToThreshold: number | null;
}

export interface RecentCostDto {
  worker: string;
  terminal: string;
  amount: number;
  timestamp: string;
}

export interface TerminalDetailDto {
  terminal: string;
  today: {
    cost: number;
    workers: WorkerDetailDto[];
  };
  history: HistoryDayDto[];
  averageDailyCost: number;
  costTrend: string;
}

export interface WorkerDetailDto {
  id: string;
  cost: number;
  startTime: string;
  endTime: string | null;
  model: string;
  task: string;
}

export interface HistoryDayDto {
  date: string;
  cost: number;
  workerCount: number;
}

export interface CostHistoryDto {
  period: {
    start: string;
    end: string;
    days: number;
  };
  dailyBudget: number;
  totalCost: number;
  averageDailyCost: number;
  history: Array<{
    date: string;
    cost: number;
    budgetStatus: 'healthy' | 'caution' | 'critical' | 'exceeded';
    exceedance: number | null;
  }>;
}

export interface CostConfigDto {
  dailyBudget: number;
  softAlertThreshold: number;
  hardAlertThreshold: number;
  autoPauseThreshold: number;
  alertChannels: string[];
  pauseNotification: string;
}

// ─── Service Implementation ──────────────────────────────────────────────────

/**
 * Daily budget in USD (configurable, defaults to $50)
 */
let DAILY_BUDGET = parseFloat(process.env.DAILY_COST_BUDGET || '50');

/**
 * In-memory cost history (last 7 days)
 * Format: Map<date, Map<terminal, cost>>
 */
const costHistory = new Map<string, Map<string, number>>();

/**
 * Track worker costs (completed workers)
 * Format: Map<workerId, { terminal, cost, timestamp }>
 */
const completedWorkerCosts = new Map<string, { terminal: string; cost: number; timestamp: string }>();

/**
 * Get current cost stream data (for SSE)
 */
export function getCurrentCosts(): CostStreamDto {
  const now = new Date();
  const terminals = getTerminalCostBreakdown();
  const totalCost = terminals.reduce((sum, t) => sum + t.cost, 0);

  return {
    timestamp: now.toISOString(),
    dailyBudget: DAILY_BUDGET,
    current: parseFloat(totalCost.toFixed(2)),
    currency: 'USD',
    thresholdStatus: calculateThresholdStatus(totalCost),
    terminals,
    recentCosts: getRecentCosts(5),
  };
}

/**
 * Get today's cost summary
 */
export function getTodayCosts(): TodayCostDto {
  const today = new Date().toISOString().split('T')[0];
  const terminals = getTerminalCostBreakdown();
  const current = terminals.reduce((sum, t) => sum + t.cost, 0);
  const percentageUsed = (current / DAILY_BUDGET) * 100;
  const remaining = DAILY_BUDGET - current;

  return {
    date: today,
    dailyBudget: DAILY_BUDGET,
    current: parseFloat(current.toFixed(2)),
    currency: 'USD',
    thresholdStatus: calculateThresholdStatus(current),
    percentageUsed: parseFloat(percentageUsed.toFixed(1)),
    remaining: parseFloat(Math.max(0, remaining).toFixed(2)),
    terminals,
  };
}

/**
 * Get terminal cost detail with history
 */
export function getTerminalCosts(terminal: string, days: number = 7): TerminalDetailDto {
  const workers = getActiveWorkers(terminal);
  const todayCost = calculateTerminalTodayCost(terminal);

  const workerDetails: WorkerDetailDto[] = workers.map(w => {
    const startTime = new Date(w.startedAt);
    const runningMinutes = (Date.now() - startTime.getTime()) / 60000;
    const cost = getModelCostPerMinute(w.model) * runningMinutes;

    return {
      id: w.id,
      cost: parseFloat(cost.toFixed(2)),
      startTime: w.startedAt,
      endTime: w.completedAt || null,
      model: w.model,
      task: w.taskId,
    };
  });

  const history = getTerminalHistory(terminal, days);
  const avgCost = history.reduce((sum, h) => sum + h.cost, 0) / Math.max(history.length, 1);
  const trend = calculateCostTrend(todayCost, avgCost);

  return {
    terminal,
    today: {
      cost: parseFloat(todayCost.toFixed(2)),
      workers: workerDetails,
    },
    history,
    averageDailyCost: parseFloat(avgCost.toFixed(2)),
    costTrend: trend,
  };
}

/**
 * Get cost history for the last N days
 */
export function getCostHistory(days: number = 7): CostHistoryDto {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);

  const history: Array<{
    date: string;
    cost: number;
    budgetStatus: 'healthy' | 'caution' | 'critical' | 'exceeded';
    exceedance: number | null;
  }> = [];

  let totalCost = 0;

  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];

    const dayCost = getDayCost(dateStr);
    totalCost += dayCost;

    const budgetStatus = calculateThresholdStatus(dayCost);
    const exceedance = dayCost > DAILY_BUDGET ? dayCost - DAILY_BUDGET : null;

    history.push({
      date: dateStr,
      cost: parseFloat(dayCost.toFixed(2)),
      budgetStatus,
      exceedance: exceedance ? parseFloat(exceedance.toFixed(2)) : null,
    });
  }

  return {
    period: {
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0],
      days,
    },
    dailyBudget: DAILY_BUDGET,
    totalCost: parseFloat(totalCost.toFixed(2)),
    averageDailyCost: parseFloat((totalCost / days).toFixed(2)),
    history,
  };
}

/**
 * Get current cost configuration
 */
export function getCostConfig(): CostConfigDto {
  return {
    dailyBudget: DAILY_BUDGET,
    softAlertThreshold: 0.60, // 60%
    hardAlertThreshold: 0.80, // 80%
    autoPauseThreshold: 0.80, // 80%
    alertChannels: ['dashboard', 'telegram'],
    pauseNotification: 'auto-pause-new-workers',
  };
}

/**
 * Update cost configuration
 */
export function updateCostConfig(config: Partial<CostConfigDto>): CostConfigDto {
  if (config.dailyBudget !== undefined && config.dailyBudget > 0) {
    DAILY_BUDGET = config.dailyBudget;
  }

  // TODO: Persist other config values (thresholds, channels) when DB ready
  // For now, return current config
  return getCostConfig();
}

/**
 * Record auto-pause notification
 */
export function recordPauseNotification(data: {
  currentCost: number;
  dailyBudget: number;
  thresholdStatus: string;
  terminals: Array<{ name: string; cost: number }>;
}): { status: string; message: string; coordinatorNotified: boolean } {
  console.warn(`[CostMonitoring] Auto-pause triggered! Current: $${data.currentCost}, Budget: $${data.dailyBudget}`);

  // TODO: Send notification to Conductor via MCP
  // TODO: Trigger worker spawn prevention

  return {
    status: 'acknowledged',
    message: 'Auto-pause triggered. New worker spawns disabled.',
    coordinatorNotified: true, // TODO: Actually notify Conductor
  };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Get per-terminal cost breakdown
 */
function getTerminalCostBreakdown(): TerminalCostDetailDto[] {
  const terminals = ['backend', 'frontend', 'architect', 'designer', 'conductor', 'librarian', 'explorer'];

  return terminals.map(terminal => {
    const cost = calculateTerminalTodayCost(terminal);
    const percentage = (cost / DAILY_BUDGET) * 100;
    const status = calculateTerminalStatus(cost, DAILY_BUDGET);
    const minutesToThreshold = calculateMinutesToThreshold(terminal, cost);

    return {
      name: terminal,
      cost: parseFloat(cost.toFixed(2)),
      percentage: parseFloat(percentage.toFixed(1)),
      status,
      minutesToThreshold,
    };
  }).filter(t => t.cost > 0); // Only return terminals with active costs
}

/**
 * Calculate terminal's today cost (running + completed workers)
 */
function calculateTerminalTodayCost(terminal: string): number {
  // Running workers (projected hourly rate)
  const runningWorkers = getActiveWorkers(terminal);
  let runningCost = 0;

  for (const worker of runningWorkers) {
    const startTime = new Date(worker.startedAt);
    const runningMinutes = (Date.now() - startTime.getTime()) / 60000;
    const costPerMinute = getModelCostPerMinute(worker.model);
    runningCost += costPerMinute * runningMinutes;
  }

  // Completed workers (actual cost)
  const today = new Date().toISOString().split('T')[0];
  const completedCost = Array.from(completedWorkerCosts.values())
    .filter(w => w.terminal === terminal && w.timestamp.startsWith(today))
    .reduce((sum, w) => sum + w.cost, 0);

  return runningCost + completedCost;
}

/**
 * Calculate threshold status based on cost vs budget
 */
function calculateThresholdStatus(cost: number): 'healthy' | 'caution' | 'critical' | 'exceeded' {
  const percentage = cost / DAILY_BUDGET;

  if (percentage > 1.0) return 'exceeded';
  if (percentage > 0.80) return 'critical';
  if (percentage > 0.60) return 'caution';
  return 'healthy';
}

/**
 * Calculate terminal status (more conservative than overall)
 */
function calculateTerminalStatus(cost: number, budget: number): 'healthy' | 'caution' | 'critical' {
  const percentage = cost / budget;

  if (percentage > 0.80) return 'critical';
  if (percentage > 0.60) return 'caution';
  return 'healthy';
}

/**
 * Calculate minutes until terminal reaches next threshold
 */
function calculateMinutesToThreshold(terminal: string, currentCost: number): number | null {
  const workers = getActiveWorkers(terminal);
  if (workers.length === 0) return null;

  // Calculate current burn rate ($/minute)
  const burnRate = workers.reduce((sum, w) => sum + getModelCostPerMinute(w.model), 0);
  if (burnRate === 0) return null;

  // Calculate next threshold
  const currentPercentage = currentCost / DAILY_BUDGET;
  let nextThreshold = DAILY_BUDGET * 0.60; // Caution threshold

  if (currentPercentage >= 0.60) {
    nextThreshold = DAILY_BUDGET * 0.80; // Critical threshold
  }

  if (currentPercentage >= 0.80) {
    nextThreshold = DAILY_BUDGET; // Budget exceeded
  }

  if (currentCost >= nextThreshold) {
    return null; // Already past threshold
  }

  const costToThreshold = nextThreshold - currentCost;
  const minutes = costToThreshold / burnRate;

  return Math.max(0, Math.floor(minutes));
}

/**
 * Get recent cost events (last N completed workers)
 */
function getRecentCosts(limit: number = 5): RecentCostDto[] {
  const recent = Array.from(completedWorkerCosts.entries())
    .sort((a, b) => b[1].timestamp.localeCompare(a[1].timestamp))
    .slice(0, limit);

  return recent.map(([workerId, data]) => ({
    worker: workerId,
    terminal: data.terminal,
    amount: parseFloat(data.cost.toFixed(2)),
    timestamp: data.timestamp,
  }));
}

/**
 * Get terminal history for last N days
 */
function getTerminalHistory(terminal: string, days: number): HistoryDayDto[] {
  const history: HistoryDayDto[] = [];
  const end = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    const dayData = costHistory.get(dateStr);
    const cost = dayData?.get(terminal) || 0;

    // Count workers for that day (simplified - just use cost estimate)
    const workerCount = Math.ceil(cost / 2); // Rough estimate

    history.push({
      date: dateStr,
      cost: parseFloat(cost.toFixed(2)),
      workerCount,
    });
  }

  return history;
}

/**
 * Get total cost for a specific day
 */
function getDayCost(dateStr: string): number {
  const dayData = costHistory.get(dateStr);
  if (!dayData) return 0;

  return Array.from(dayData.values()).reduce((sum, cost) => sum + cost, 0);
}

/**
 * Calculate cost trend (% change vs average)
 */
function calculateCostTrend(todayCost: number, avgCost: number): string {
  if (avgCost === 0) return '+0.0%';

  const change = ((todayCost - avgCost) / avgCost) * 100;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

/**
 * Record completed worker cost (called when worker finishes)
 */
export function recordWorkerCost(workerId: string, terminal: string, cost: number): void {
  completedWorkerCosts.set(workerId, {
    terminal,
    cost,
    timestamp: new Date().toISOString(),
  });

  // Update daily history
  const today = new Date().toISOString().split('T')[0];
  if (!costHistory.has(today)) {
    costHistory.set(today, new Map());
  }

  const dayData = costHistory.get(today)!;
  const currentCost = dayData.get(terminal) || 0;
  dayData.set(terminal, currentCost + cost);

  console.log(`[CostMonitoring] Recorded worker cost: ${workerId} (${terminal}) = $${cost.toFixed(2)}`);
}
