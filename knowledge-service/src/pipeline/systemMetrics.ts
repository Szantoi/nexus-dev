/**
 * System Metrics Collection - ADR-046 Monitoring
 *
 * Collects system load metrics (CPU, memory, disk) and API rate limit events.
 * Token usage can only be tracked via OpenTelemetry (external to this service).
 *
 * Usage:
 *   - GET /api/metrics/system - Current system metrics
 *   - GET /api/metrics/history - Historical metrics (last N hours)
 *   - POST /api/metrics/rate-limit - Log rate limit event (called by API handlers)
 */

import { execSync } from 'child_process';
import { log } from './common';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SystemMetrics {
  timestamp: string;
  cpu: {
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    cores: number;
  };
  memory: {
    totalMb: number;
    usedMb: number;
    freeMb: number;
    usedPercent: number;
    buffersCacheMb: number;
    availableMb: number;
  };
  disk: {
    totalGb: number;
    usedGb: number;
    freeGb: number;
    usedPercent: number;
  };
  processes: {
    running: number;
    total: number;
  };
}

export interface RateLimitEvent {
  timestamp: string;
  terminal: string;
  errorCode: number;
  retryAfter?: number;
  endpoint?: string;
}

export interface MetricsSnapshot {
  system: SystemMetrics;
  rateLimits: {
    last24h: number;
    lastHour: number;
    events: RateLimitEvent[];
  };
  uptime: {
    serverStartedAt: string;
    uptimeSeconds: number;
  };
}

// ─── State ─────────────────────────────────────────────────────────────────────

const serverStartedAt = new Date().toISOString();
const rateLimitEvents: RateLimitEvent[] = [];
const MAX_RATE_LIMIT_EVENTS = 1000;

const metricsHistory: SystemMetrics[] = [];
const MAX_HISTORY_SIZE = 720; // 12 hours at 1 per minute

// ─── Prometheus Metrics (MSG-NEXUS-007) ────────────────────────────────────────

interface PrometheusMetrics {
  nightwatch_cycle_count: number;
  pipeline_task_processed: { [type: string]: number };
  terminal_session_active: { [terminal: string]: number };
  mcp_tool_calls_total: number;
  mcp_response_time_sum: number;
  mcp_response_time_count: number;
}

const prometheusMetrics: PrometheusMetrics = {
  nightwatch_cycle_count: 0,
  pipeline_task_processed: {},
  terminal_session_active: {},
  mcp_tool_calls_total: 0,
  mcp_response_time_sum: 0,
  mcp_response_time_count: 0,
};

// ─── Collectors ────────────────────────────────────────────────────────────────

/**
 * Collect current system metrics
 */
export function collectSystemMetrics(): SystemMetrics {
  const timestamp = new Date().toISOString();

  // CPU load averages from /proc/loadavg
  let loadAvg1 = 0, loadAvg5 = 0, loadAvg15 = 0, runningProcs = 0, totalProcs = 0;
  try {
    const loadavg = execSync('cat /proc/loadavg', { encoding: 'utf-8' }).trim();
    const parts = loadavg.split(' ');
    loadAvg1 = parseFloat(parts[0]) || 0;
    loadAvg5 = parseFloat(parts[1]) || 0;
    loadAvg15 = parseFloat(parts[2]) || 0;
    const procParts = (parts[3] || '0/0').split('/');
    runningProcs = parseInt(procParts[0]) || 0;
    totalProcs = parseInt(procParts[1]) || 0;
  } catch (e) {
    // Fallback to os module if /proc not available
    const os = require('os');
    const loadAvgArr = os.loadavg();
    loadAvg1 = loadAvgArr[0];
    loadAvg5 = loadAvgArr[1];
    loadAvg15 = loadAvgArr[2];
  }

  // CPU cores
  let cores = 1;
  try {
    const os = require('os');
    cores = os.cpus().length;
  } catch (e) { /* fallback to 1 */ }

  // Memory from free -m
  let totalMb = 0, usedMb = 0, freeMb = 0, buffersCacheMb = 0, availableMb = 0;
  try {
    const memInfo = execSync('free -m', { encoding: 'utf-8' });
    const memLine = memInfo.split('\n').find(l => l.startsWith('Mem:'));
    if (memLine) {
      const parts = memLine.split(/\s+/);
      totalMb = parseInt(parts[1]) || 0;
      usedMb = parseInt(parts[2]) || 0;
      freeMb = parseInt(parts[3]) || 0;
      // parts[4] is shared, parts[5] is buff/cache, parts[6] is available
      buffersCacheMb = parseInt(parts[5]) || 0;
      availableMb = parseInt(parts[6]) || freeMb;
    }
  } catch (e) {
    // Fallback
    const os = require('os');
    totalMb = Math.round(os.totalmem() / 1024 / 1024);
    freeMb = Math.round(os.freemem() / 1024 / 1024);
    usedMb = totalMb - freeMb;
    availableMb = freeMb;
  }

  // Disk from df
  let totalGb = 0, usedGb = 0, freeGb = 0, diskUsedPercent = 0;
  try {
    const dfInfo = execSync('df -BG / | tail -1', { encoding: 'utf-8' });
    const parts = dfInfo.trim().split(/\s+/);
    totalGb = parseInt(parts[1]?.replace('G', '')) || 0;
    usedGb = parseInt(parts[2]?.replace('G', '')) || 0;
    freeGb = parseInt(parts[3]?.replace('G', '')) || 0;
    diskUsedPercent = parseInt(parts[4]?.replace('%', '')) || 0;
  } catch (e) { /* leave zeros */ }

  const memUsedPercent = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;

  return {
    timestamp,
    cpu: {
      loadAvg1,
      loadAvg5,
      loadAvg15,
      cores,
    },
    memory: {
      totalMb,
      usedMb,
      freeMb,
      usedPercent: memUsedPercent,
      buffersCacheMb,
      availableMb,
    },
    disk: {
      totalGb,
      usedGb,
      freeGb,
      usedPercent: diskUsedPercent,
    },
    processes: {
      running: runningProcs,
      total: totalProcs,
    },
  };
}

/**
 * Record a rate limit event
 */
export function recordRateLimitEvent(event: Omit<RateLimitEvent, 'timestamp'>): void {
  const fullEvent: RateLimitEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };

  rateLimitEvents.push(fullEvent);

  // Keep only last N events
  if (rateLimitEvents.length > MAX_RATE_LIMIT_EVENTS) {
    rateLimitEvents.shift();
  }

  log(`Rate limit event: ${event.terminal} - ${event.errorCode} (retry: ${event.retryAfter || 'unknown'}s)`);
}

/**
 * Get rate limit events from last N hours
 */
export function getRateLimitEvents(hours: number = 24): RateLimitEvent[] {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return rateLimitEvents.filter(e => new Date(e.timestamp).getTime() > cutoff);
}

/**
 * Get full metrics snapshot
 */
export function getMetricsSnapshot(): MetricsSnapshot {
  const system = collectSystemMetrics();
  const last24h = getRateLimitEvents(24);
  const lastHour = getRateLimitEvents(1);

  const startTime = new Date(serverStartedAt).getTime();
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  return {
    system,
    rateLimits: {
      last24h: last24h.length,
      lastHour: lastHour.length,
      events: lastHour.slice(-10), // Last 10 events in last hour
    },
    uptime: {
      serverStartedAt,
      uptimeSeconds,
    },
  };
}

/**
 * Store metrics in history (called every minute by scheduler)
 */
export function storeMetricsHistory(): void {
  const metrics = collectSystemMetrics();
  metricsHistory.push(metrics);

  // Keep only last N
  if (metricsHistory.length > MAX_HISTORY_SIZE) {
    metricsHistory.shift();
  }
}

/**
 * Get metrics history
 */
export function getMetricsHistory(hours: number = 1): SystemMetrics[] {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return metricsHistory.filter(m => new Date(m.timestamp).getTime() > cutoff);
}

// ─── Alert Thresholds ──────────────────────────────────────────────────────────

export interface AlertThresholds {
  cpuLoadPercent: number;   // Alert if load/cores > this
  memoryPercent: number;    // Alert if used% > this
  diskPercent: number;      // Alert if used% > this
  rateLimitsPerHour: number; // Alert if rate limits > this
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  cpuLoadPercent: 80,
  memoryPercent: 90,
  diskPercent: 85,
  rateLimitsPerHour: 5,
};

/**
 * Check if any thresholds are exceeded
 */
export function checkAlerts(thresholds: AlertThresholds = DEFAULT_THRESHOLDS): string[] {
  const metrics = collectSystemMetrics();
  const alerts: string[] = [];

  // CPU load as percentage of cores
  const cpuPercent = (metrics.cpu.loadAvg1 / metrics.cpu.cores) * 100;
  if (cpuPercent > thresholds.cpuLoadPercent) {
    alerts.push(`CPU load high: ${cpuPercent.toFixed(1)}% (threshold: ${thresholds.cpuLoadPercent}%)`);
  }

  // Memory
  if (metrics.memory.usedPercent > thresholds.memoryPercent) {
    alerts.push(`Memory usage high: ${metrics.memory.usedPercent}% (threshold: ${thresholds.memoryPercent}%)`);
  }

  // Disk
  if (metrics.disk.usedPercent > thresholds.diskPercent) {
    alerts.push(`Disk usage high: ${metrics.disk.usedPercent}% (threshold: ${thresholds.diskPercent}%)`);
  }

  // Rate limits in last hour
  const rateLimitsLastHour = getRateLimitEvents(1).length;
  if (rateLimitsLastHour > thresholds.rateLimitsPerHour) {
    alerts.push(`Rate limit events high: ${rateLimitsLastHour} in last hour (threshold: ${thresholds.rateLimitsPerHour})`);
  }

  return alerts;
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────

let metricsIntervalId: NodeJS.Timeout | null = null;

/**
 * Start metrics collection scheduler (collects every minute)
 */
export function startMetricsScheduler(intervalMs: number = 60000): void {
  if (metricsIntervalId) {
    console.log('[SystemMetrics] Scheduler already running');
    return;
  }

  console.log(`[SystemMetrics] Scheduler starting (interval: ${intervalMs}ms)`);

  // Collect immediately
  storeMetricsHistory();

  // Then on interval
  metricsIntervalId = setInterval(() => {
    storeMetricsHistory();

    // Check alerts
    const alerts = checkAlerts();
    if (alerts.length > 0) {
      console.log(`[SystemMetrics] ⚠️ Alerts: ${alerts.join(', ')}`);
    }
  }, intervalMs);
}

/**
 * Stop metrics collection scheduler
 */
export function stopMetricsScheduler(): void {
  if (metricsIntervalId) {
    clearInterval(metricsIntervalId);
    metricsIntervalId = null;
    console.log('[SystemMetrics] Scheduler stopped');
  }
}

// ─── Express Router ────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';

export function createMetricsRouter(): Router {
  const router = Router();

  // Current system metrics
  router.get('/system', (_req: Request, res: Response) => {
    try {
      const metrics = collectSystemMetrics();
      res.json(metrics);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Full metrics snapshot (system + rate limits + uptime)
  router.get('/snapshot', (_req: Request, res: Response) => {
    try {
      const snapshot = getMetricsSnapshot();
      res.json(snapshot);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Metrics history
  router.get('/history', (req: Request, res: Response) => {
    try {
      const hours = parseInt(req.query.hours as string) || 1;
      const history = getMetricsHistory(hours);
      res.json({
        hours,
        count: history.length,
        history,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Rate limit events
  router.get('/rate-limits', (req: Request, res: Response) => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const events = getRateLimitEvents(hours);
      res.json({
        hours,
        count: events.length,
        events,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Check alerts
  router.get('/alerts', (_req: Request, res: Response) => {
    try {
      const alerts = checkAlerts();
      res.json({
        alertCount: alerts.length,
        alerts,
        thresholds: DEFAULT_THRESHOLDS,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Log rate limit event (called by API handlers when they hit 429)
  router.post('/rate-limit', (req: Request, res: Response) => {
    try {
      const { terminal, errorCode, retryAfter, endpoint } = req.body;

      if (!terminal || !errorCode) {
        return res.status(400).json({ error: 'terminal and errorCode required' });
      }

      recordRateLimitEvent({
        terminal,
        errorCode,
        retryAfter,
        endpoint,
      });

      res.json({ success: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Prometheus metrics endpoint (MSG-NEXUS-007)
  router.get('/', (_req: Request, res: Response) => {
    try {
      const prometheusFormat = generatePrometheusMetrics();
      console.log(`[SystemMetrics] Prometheus metrics requested`);
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(prometheusFormat);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SystemMetrics] Error generating Prometheus metrics:`, err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

// ─── Prometheus Metrics Functions (MSG-NEXUS-007) ──────────────────────────────

/**
 * Increment Nightwatch cycle counter
 */
export function incrementNightwatchCycle(): void {
  prometheusMetrics.nightwatch_cycle_count++;
  console.log(`[SystemMetrics] Nightwatch cycle: ${prometheusMetrics.nightwatch_cycle_count}`);
}

/**
 * Increment pipeline task processed counter
 */
export function incrementTaskProcessed(type: 'done' | 'blocked'): void {
  if (!prometheusMetrics.pipeline_task_processed[type]) {
    prometheusMetrics.pipeline_task_processed[type] = 0;
  }
  prometheusMetrics.pipeline_task_processed[type]++;
  console.log(`[SystemMetrics] Task processed (${type}): ${prometheusMetrics.pipeline_task_processed[type]}`);
}

/**
 * Set terminal session active state
 */
export function setTerminalSessionActive(terminal: string, active: boolean): void {
  prometheusMetrics.terminal_session_active[terminal] = active ? 1 : 0;
  console.log(`[SystemMetrics] Terminal session ${terminal}: ${active ? 'active' : 'inactive'}`);
}

/**
 * Record MCP tool call with response time
 */
export function recordMcpToolCall(responseTimeMs: number): void {
  prometheusMetrics.mcp_tool_calls_total++;
  prometheusMetrics.mcp_response_time_sum += responseTimeMs;
  prometheusMetrics.mcp_response_time_count++;
  console.log(`[SystemMetrics] MCP tool call #${prometheusMetrics.mcp_tool_calls_total} (${responseTimeMs}ms)`);
}

/**
 * Generate Prometheus-compatible metrics format
 */
export function generatePrometheusMetrics(): string {
  const lines: string[] = [];

  // Nightwatch cycle count
  lines.push('# HELP nightwatch_cycle_count Total Nightwatch cycles executed');
  lines.push('# TYPE nightwatch_cycle_count counter');
  lines.push(`nightwatch_cycle_count ${prometheusMetrics.nightwatch_cycle_count}`);
  lines.push('');

  // Pipeline tasks processed
  lines.push('# HELP pipeline_task_processed Total tasks processed by pipeline');
  lines.push('# TYPE pipeline_task_processed counter');
  for (const [type, count] of Object.entries(prometheusMetrics.pipeline_task_processed)) {
    lines.push(`pipeline_task_processed{type="${type}"} ${count}`);
  }
  lines.push('');

  // Terminal sessions
  lines.push('# HELP terminal_session_active Active terminal sessions (1=active, 0=inactive)');
  lines.push('# TYPE terminal_session_active gauge');
  for (const [terminal, active] of Object.entries(prometheusMetrics.terminal_session_active)) {
    lines.push(`terminal_session_active{terminal="${terminal}"} ${active}`);
  }
  lines.push('');

  // MCP tool calls
  lines.push('# HELP mcp_tool_calls_total Total MCP tool calls');
  lines.push('# TYPE mcp_tool_calls_total counter');
  lines.push(`mcp_tool_calls_total ${prometheusMetrics.mcp_tool_calls_total}`);
  lines.push('');

  // MCP average response time
  lines.push('# HELP mcp_response_time_seconds Average MCP tool call response time in seconds');
  lines.push('# TYPE mcp_response_time_seconds gauge');
  const avgResponseTime = prometheusMetrics.mcp_response_time_count > 0
    ? (prometheusMetrics.mcp_response_time_sum / prometheusMetrics.mcp_response_time_count) / 1000
    : 0;
  lines.push(`mcp_response_time_seconds ${avgResponseTime.toFixed(4)}`);
  lines.push('');

  // System metrics
  const system = collectSystemMetrics();

  lines.push('# HELP system_cpu_load_avg CPU load average (1 minute)');
  lines.push('# TYPE system_cpu_load_avg gauge');
  lines.push(`system_cpu_load_avg ${system.cpu.loadAvg1}`);
  lines.push('');

  lines.push('# HELP system_memory_used_percent Memory usage percentage');
  lines.push('# TYPE system_memory_used_percent gauge');
  lines.push(`system_memory_used_percent ${system.memory.usedPercent}`);
  lines.push('');

  lines.push('# HELP system_disk_used_percent Disk usage percentage');
  lines.push('# TYPE system_disk_used_percent gauge');
  lines.push(`system_disk_used_percent ${system.disk.usedPercent}`);
  lines.push('');

  // Uptime
  const startTime = new Date(serverStartedAt).getTime();
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  lines.push('# HELP service_uptime_seconds Service uptime in seconds');
  lines.push('# TYPE service_uptime_seconds counter');
  lines.push(`service_uptime_seconds ${uptimeSeconds}`);
  lines.push('');

  return lines.join('\n');
}

// ─── Run standalone ────────────────────────────────────────────────────────────

if (require.main === module) {
  const metrics = collectSystemMetrics();
  console.log('=== System Metrics ===');
  console.log(`Timestamp: ${metrics.timestamp}`);
  console.log(`\nCPU:`);
  console.log(`  Load avg: ${metrics.cpu.loadAvg1} / ${metrics.cpu.loadAvg5} / ${metrics.cpu.loadAvg15}`);
  console.log(`  Cores: ${metrics.cpu.cores}`);
  console.log(`  Load %: ${((metrics.cpu.loadAvg1 / metrics.cpu.cores) * 100).toFixed(1)}%`);
  console.log(`\nMemory:`);
  console.log(`  Total: ${metrics.memory.totalMb} MB`);
  console.log(`  Used: ${metrics.memory.usedMb} MB (${metrics.memory.usedPercent}%)`);
  console.log(`  Available: ${metrics.memory.availableMb} MB`);
  console.log(`\nDisk:`);
  console.log(`  Total: ${metrics.disk.totalGb} GB`);
  console.log(`  Used: ${metrics.disk.usedGb} GB (${metrics.disk.usedPercent}%)`);
  console.log(`  Free: ${metrics.disk.freeGb} GB`);
  console.log(`\nProcesses:`);
  console.log(`  Running: ${metrics.processes.running}/${metrics.processes.total}`);

  const alerts = checkAlerts();
  if (alerts.length > 0) {
    console.log(`\n⚠️ Alerts:`);
    alerts.forEach(a => console.log(`  - ${a}`));
  } else {
    console.log(`\n✅ No alerts`);
  }
}
