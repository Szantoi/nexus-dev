/**
 * rootMonitor.ts — Root Óránkénti Monitoring Loop
 *
 * "A Root figyeli a rendszert és beavatkozik ha kell"
 *
 * Működés:
 * 1. Óránként ellenőrzi:
 *    - Nexus teljesítmény (CPU, memória, response time)
 *    - Minőségi fejlesztés folyik-e (DONE-ok száma, build státusz)
 *    - Elakadt-e valaki (stuck sessions >30 perc)
 *    - Elfogyott-e a tervdoksi (planning queue üres?)
 * 2. Ha probléma van → Telegram értesítés + beavatkozás
 * 3. Ha minden OK → rövid státusz log
 *
 * Konfiguráció (.env):
 *   ENABLE_ROOT_MONITOR=true
 *   ROOT_MONITOR_INTERVAL_MINUTES=60
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  SESSIONS,
  hasSession,
  capturePane,
  log,
  telegram,
} from './common';
import { detectPaneState, PaneStateResult } from './paneState';
import { getMetricsSnapshot, checkAlerts } from './systemMetrics';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RootMonitorConfig {
  enabled: boolean;
  intervalMinutes: number;
  stuckThresholdMinutes: number;
  minPlanQueueSize: number;
  notifyOnIssues: boolean;
  autoNudgeStuck: boolean;
}

export interface MonitoringReport {
  timestamp: string;
  checkId: number;

  // System health
  system: {
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
    alerts: string[];
  };

  // Development quality
  quality: {
    activeSessions: number;
    workingSessions: string[];
    idleSessions: string[];
    stuckSessions: string[];
    doneCountLast1h: number;
    buildStatus: 'green' | 'red' | 'unknown';
  };

  // Planning pipeline
  planning: {
    queueSize: number;
    ideasCount: number;
    debateCount: number;
    consensusCount: number;
    planningHealthy: boolean;
  };

  // Overall assessment
  status: 'healthy' | 'warning' | 'critical';
  issues: string[];
  actions: string[];
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RootMonitorConfig = {
  enabled: process.env.ENABLE_ROOT_MONITOR === 'true',
  intervalMinutes: parseInt(process.env.ROOT_MONITOR_INTERVAL_MINUTES || '60', 10),
  stuckThresholdMinutes: 30,
  minPlanQueueSize: 2,
  notifyOnIssues: true,
  autoNudgeStuck: true,
};

// ─── State ───────────────────────────────────────────────────────────────────

let checkCount = 0;
let lastCheckAt: string | null = null;
let intervalId: NodeJS.Timeout | null = null;
let lastReport: MonitoringReport | null = null;

// ─── Helper Functions ────────────────────────────────────────────────────────

const projectRoot = process.env.SPACEOS_ROOT || '/opt/spaceos';

async function countFilesInDir(dirPath: string): Promise<number> {
  try {
    const files = await fs.readdir(dirPath);
    return files.filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

async function countDirsInDir(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function countDoneInLastHour(): Promise<number> {
  const terminalsDir = path.join(projectRoot, 'terminals');
  const terminals = ['backend', 'frontend', 'designer', 'architect', 'conductor'];
  let count = 0;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  for (const terminal of terminals) {
    const outboxDir = path.join(terminalsDir, terminal, 'outbox');
    try {
      const files = await fs.readdir(outboxDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const stat = await fs.stat(path.join(outboxDir, file));
        if (stat.mtimeMs > oneHourAgo) {
          count++;
        }
      }
    } catch {
      // outbox doesn't exist
    }
  }

  return count;
}

async function detectStuckSessions(_thresholdMinutes: number): Promise<string[]> {
  const stuck: string[] = [];
  const workerTerminals = ['spaceos-backend', 'spaceos-frontend', 'spaceos-designer', 'spaceos-conductor'];

  for (const session of workerTerminals) {
    if (await hasSession(session)) {
      const state = await detectPaneState(session);
      // Only consider error state as stuck
      // Unknown/low confidence just means session exists but Claude isn't running - that's normal
      if (state.state === 'error') {
        stuck.push(session.replace('spaceos-', ''));
      }
    }
  }

  return stuck;
}

async function getWorkingAndIdleSessions(): Promise<{ working: string[], idle: string[] }> {
  const working: string[] = [];
  const idle: string[] = [];
  const terminals = ['spaceos-backend', 'spaceos-frontend', 'spaceos-designer', 'spaceos-conductor', 'spaceos-architect'];

  for (const session of terminals) {
    if (await hasSession(session)) {
      const state = await detectPaneState(session);
      const name = session.replace('spaceos-', '');
      if (state.state === 'busy') {
        working.push(name);
      } else if (state.state === 'idle') {
        idle.push(name);
      }
    }
  }

  return { working, idle };
}

async function checkBuildStatus(): Promise<'green' | 'red' | 'unknown'> {
  // Check recent build logs or CI status
  const buildLogPath = path.join(projectRoot, 'logs', 'build.log');
  try {
    const content = await fs.readFile(buildLogPath, 'utf-8');
    const lines = content.split('\n').slice(-20);
    const lastLine = lines.join('\n');
    if (lastLine.includes('BUILD SUCCESSFUL') || lastLine.includes('0 Error')) {
      return 'green';
    } else if (lastLine.includes('BUILD FAILED') || lastLine.includes('error')) {
      return 'red';
    }
  } catch {
    // No build log
  }
  return 'unknown';
}

// ─── Core Monitoring Logic ───────────────────────────────────────────────────

export async function runMonitoringCheck(
  config: RootMonitorConfig = DEFAULT_CONFIG
): Promise<MonitoringReport> {
  const timestamp = new Date().toISOString();
  checkCount++;
  const checkId = checkCount;

  await log(`[RootMonitor] Starting check #${checkId}`);

  const issues: string[] = [];
  const actions: string[] = [];

  // 1. System health
  const metrics = getMetricsSnapshot();
  const alerts = checkAlerts();

  // CPU load as percentage of cores
  const cpuPercent = metrics.system.cpu.cores > 0
    ? Math.round((metrics.system.cpu.loadAvg1 / metrics.system.cpu.cores) * 100)
    : 0;

  const system = {
    cpuPercent,
    memoryPercent: metrics.system.memory.usedPercent,
    diskPercent: metrics.system.disk.usedPercent,
    alerts,
  };

  if (system.cpuPercent > 90) {
    issues.push(`CPU kritikus: ${system.cpuPercent}%`);
  }
  if (system.memoryPercent > 85) {
    issues.push(`Memória magas: ${system.memoryPercent}%`);
  }
  if (system.diskPercent > 90) {
    issues.push(`Disk kritikus: ${system.diskPercent}%`);
  }

  // 2. Session states
  const { working, idle } = await getWorkingAndIdleSessions();
  const stuck = await detectStuckSessions(config.stuckThresholdMinutes);
  const doneCount = await countDoneInLastHour();
  const buildStatus = await checkBuildStatus();

  const quality = {
    activeSessions: working.length + idle.length,
    workingSessions: working,
    idleSessions: idle,
    stuckSessions: stuck,
    doneCountLast1h: doneCount,
    buildStatus,
  };

  if (stuck.length > 0) {
    issues.push(`Elakadt session-ök: ${stuck.join(', ')}`);
    if (config.autoNudgeStuck) {
      actions.push(`Auto-nudge: ${stuck.join(', ')}`);
    }
  }

  if (working.length === 0 && idle.length > 0) {
    issues.push('Nincs aktívan dolgozó session');
  }

  if (buildStatus === 'red') {
    issues.push('Build FAILED státuszban');
  }

  // 3. Planning pipeline health
  const queueSize = await countFilesInDir(path.join(projectRoot, 'docs/planning/queue'));
  const ideasCount = await countFilesInDir(path.join(projectRoot, 'docs/planning/ideas'));
  const debateCount = await countFilesInDir(path.join(projectRoot, 'docs/planning/debate'));
  const consensusCount = await countFilesInDir(path.join(projectRoot, 'docs/planning/consensus'));

  // Also check docs/tasks/new for UI implementation tasks
  const tasksNewCount = await countDirsInDir(path.join(projectRoot, 'docs/tasks/new'));

  const planningHealthy = queueSize >= config.minPlanQueueSize || ideasCount > 0 || debateCount > 0 || tasksNewCount > 0;

  const planning = {
    queueSize,
    ideasCount,
    debateCount,
    consensusCount,
    planningHealthy,
  };

  if (queueSize === 0 && ideasCount === 0 && debateCount === 0) {
    issues.push('Planning pipeline ÜRES - nincs tervdoksi!');
    actions.push('Architect-nek új tervezési feladatot kell adni');
  } else if (queueSize < config.minPlanQueueSize) {
    issues.push(`Queue alacsony: ${queueSize} terv (min: ${config.minPlanQueueSize})`);
  }

  // 4. Overall status
  let status: 'healthy' | 'warning' | 'critical' = 'healthy';
  if (issues.length > 0) {
    status = issues.some(i =>
      i.includes('kritikus') ||
      i.includes('FAILED') ||
      i.includes('ÜRES')
    ) ? 'critical' : 'warning';
  }

  const report: MonitoringReport = {
    timestamp,
    checkId,
    system,
    quality,
    planning,
    status,
    issues,
    actions,
  };

  lastReport = report;
  lastCheckAt = timestamp;

  // Log and notify
  await log(`[RootMonitor] Check #${checkId} complete: ${status} (${issues.length} issues)`);

  if (status !== 'healthy' && config.notifyOnIssues) {
    const emoji = status === 'critical' ? '🚨' : '⚠️';
    const msg = [
      `${emoji} Root Monitor #${checkId}`,
      `Státusz: ${status.toUpperCase()}`,
      '',
      '**Problémák:**',
      ...issues.map(i => `- ${i}`),
      '',
      '**Metrikák:**',
      `- Working: ${working.join(', ') || 'nincs'}`,
      `- DONE/1h: ${doneCount}`,
      `- Queue: ${queueSize} terv`,
    ].join('\n');

    await telegram(msg);
  }

  return report;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function startRootMonitorScheduler(config: RootMonitorConfig = DEFAULT_CONFIG): void {
  if (!config.enabled) {
    console.log('[RootMonitor] Scheduler disabled (set ENABLE_ROOT_MONITOR=true)');
    return;
  }

  if (intervalId) {
    console.log('[RootMonitor] Scheduler already running');
    return;
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;

  console.log(`[RootMonitor] Scheduler starting (every ${config.intervalMinutes} minutes)`);

  // First check after 5 minutes (give system time to stabilize)
  setTimeout(async () => {
    try {
      const report = await runMonitoringCheck(config);
      console.log(`[RootMonitor] Initial check: ${report.status} (${report.issues.length} issues)`);
    } catch (err) {
      console.error('[RootMonitor] Initial check error:', err);
    }
  }, 5 * 60 * 1000);

  // Then run on interval
  intervalId = setInterval(async () => {
    try {
      const report = await runMonitoringCheck(config);

      if (report.status === 'healthy') {
        console.log(`[RootMonitor] Check #${report.checkId}: healthy`);
      } else {
        console.log(`[RootMonitor] Check #${report.checkId}: ${report.status} - ${report.issues.join('; ')}`);
      }
    } catch (err) {
      console.error('[RootMonitor] Check error:', err);
    }
  }, intervalMs);

  console.log(`   👁️ Root Monitor: ENABLED (every ${config.intervalMinutes}min)`);
}

export function stopRootMonitorScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[RootMonitor] Scheduler stopped');
  }
}

// ─── Status & API ────────────────────────────────────────────────────────────

export function getRootMonitorStatus(): {
  enabled: boolean;
  running: boolean;
  checkCount: number;
  lastCheckAt: string | null;
  lastReport: MonitoringReport | null;
  config: RootMonitorConfig;
} {
  return {
    enabled: DEFAULT_CONFIG.enabled,
    running: intervalId !== null,
    checkCount,
    lastCheckAt,
    lastReport,
    config: DEFAULT_CONFIG,
  };
}

export async function triggerManualCheck(): Promise<MonitoringReport> {
  return runMonitoringCheck(DEFAULT_CONFIG);
}

// ─── Express Router ──────────────────────────────────────────────────────────

import { Router } from 'express';

export function createRootMonitorRouter(): Router {
  const router = Router();

  // Get status
  router.get('/status', (_req, res) => {
    res.json(getRootMonitorStatus());
  });

  // Get last report
  router.get('/report', (_req, res) => {
    if (lastReport) {
      res.json(lastReport);
    } else {
      res.status(404).json({ error: 'No report yet' });
    }
  });

  // Trigger manual check
  router.post('/check', async (_req, res) => {
    try {
      const report = await triggerManualCheck();
      res.json(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Start scheduler
  router.post('/start', (_req, res) => {
    startRootMonitorScheduler();
    res.json({ success: true, message: 'Scheduler started' });
  });

  // Stop scheduler
  router.post('/stop', (_req, res) => {
    stopRootMonitorScheduler();
    res.json({ success: true, message: 'Scheduler stopped' });
  });

  return router;
}

// ─── Run standalone ──────────────────────────────────────────────────────────

if (require.main === module) {
  console.log('=== Root Monitor Module ===');
  console.log(`Enabled: ${DEFAULT_CONFIG.enabled}`);
  console.log(`Interval: ${DEFAULT_CONFIG.intervalMinutes} minutes`);

  if (process.argv.includes('--check')) {
    console.log('\nRunning manual check...');
    triggerManualCheck()
      .then(report => {
        console.log('\nReport:', JSON.stringify(report, null, 2));
      })
      .catch(err => {
        console.error('Error:', err);
      });
  }
}
