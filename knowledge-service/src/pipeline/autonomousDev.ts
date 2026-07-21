/**
 * autonomousDev.ts — Autonóm Fejlesztési Ciklus
 *
 * "Folyamatosan fejleszt a UI terv alapján"
 *
 * Működés:
 * 1. Minden N percben (alapértelmezett: 20) új fejlesztési ciklust indít
 * 2. Tartós feladat kerül a Conductor inboxába
 * 3. Conductor a docs/planning/ vagy design dokumentumok alapján kiválaszt egy feladatot
 * 4. Terminálnak inbox üzenetet küld
 * 5. Csak akkor kér döntést, ha a dokumentumokban nincs elegendő információ
 *
 * Konfiguráció (.env):
 *   ENABLE_AUTONOMOUS_DEV=true
 *   AUTONOMOUS_DEV_INTERVAL_MINUTES=20
 *   AUTONOMOUS_DEV_FOCUS_FILE=/opt/spaceos/docs/joinerytech/uploads/PROJECT_MANAGEMENT_MODEL-frontend-designes-v3.md
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  hasSession,
  log,
  telegram,
} from './common';
import { detectPaneState } from './paneState';
import { env } from '../config/env';
import { AUTONOMOUS_DEV_FOCUS_FILE, TERMINALS_PATH } from '../config/paths';
import { createTask } from '../mailbox';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Control Mode — Manual vs Autonomous Development
 *
 * - manual: AutonomousDev does NOT start sessions (manual control only)
 * - autonomous: Normal operation (auto-starts Conductor every N minutes)
 * - hybrid: Skip if UNREAD inbox exists (respects manual tasks)
 */
export type ControlMode = 'manual' | 'autonomous' | 'hybrid';

export interface AutonomousDevConfig {
  enabled: boolean;
  intervalMinutes: number;
  focusFile: string;
  coldStart: boolean;         // Mindig hideg indítás
  skipIfBusy: boolean;        // Ne indítson ha már fut munka
  maxConcurrentTasks: number; // Max párhuzamos terminál
  conductorModel: string;     // Conductor modell (sonnet/opus)
  controlMode: ControlMode;   // Manual vs autonomous control

  // Token optimization
  tokenBudget: number;
  includeArchitectGuidance: 'auto' | 'always' | 'never';
  includeMcpExamples: 'first-3' | 'always' | 'never';
  includeQueueGuidance: 'auto' | 'always' | 'never';
  promptTemplate: 'base' | 'verbose' | 'minimal';
}

export interface DevCycleResult {
  timestamp: string;
  cycleId: number;
  conductorStarted: boolean;
  taskDispatched: boolean;
  targetTerminal?: string;
  taskSummary?: string;
  launchRequestId?: string;
  skipped?: string;
  error?: string;

  // Token tracking
  promptTokenCount?: number;
  tokenBudget?: number;
  templatesUsed?: string[];
}

interface PromptContext {
  includeArchitectGuidance: boolean;
  includeMcpExamples: boolean;
  includeQueueGuidance: boolean;
  tokenBudget: number;
  templatesUsed: string[];
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AutonomousDevConfig = {
  enabled: env.ENABLE_AUTONOMOUS_DEV,
  intervalMinutes: env.AUTONOMOUS_DEV_INTERVAL_MINUTES,
  focusFile: AUTONOMOUS_DEV_FOCUS_FILE,
  coldStart: true,
  skipIfBusy: true,
  maxConcurrentTasks: 2,
  conductorModel: 'sonnet',
  controlMode: env.AUTONOMOUS_DEV_CONTROL_MODE,

  // Token optimization defaults
  tokenBudget: env.AUTONOMOUS_DEV_TOKEN_BUDGET,
  includeArchitectGuidance: env.AUTONOMOUS_DEV_INCLUDE_ARCHITECT_GUIDANCE,
  includeMcpExamples: env.AUTONOMOUS_DEV_INCLUDE_MCP_EXAMPLES,
  includeQueueGuidance: env.AUTONOMOUS_DEV_INCLUDE_QUEUE_GUIDANCE,
  promptTemplate: env.AUTONOMOUS_DEV_PROMPT_TEMPLATE,
};

// ─── State ───────────────────────────────────────────────────────────────────

let cycleCount = 0;
let lastCycleAt: string | null = null;
let intervalId: NodeJS.Timeout | null = null;
let currentControlMode: ControlMode = DEFAULT_CONFIG.controlMode;

// ─── Core Logic ──────────────────────────────────────────────────────────────

/**
 * Estimate token count from text (rough approximation: 1 token ≈ 4 chars)
 * (exported for testing)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Read a prompt template file
 */
async function readTemplate(filename: string): Promise<string> {
  // Use process.cwd() to ensure we find prompts/ from project root
  // Works in both dev (ts-node) and production (compiled)
  const PROMPTS_DIR = path.join(process.cwd(), 'prompts');
  const filePath = path.join(PROMPTS_DIR, filename);
  return fs.readFile(filePath, 'utf-8');
}

/**
 * Determine which prompt sections to include based on config and context
 * (exported for testing)
 */
export function determinePromptContext(
  config: AutonomousDevConfig,
  cycleId: number
): PromptContext {
  const templatesUsed: string[] = ['autonomous-dev-base.txt'];

  // Auto-detect if Architect guidance needed
  let includeArchitectGuidance = false;
  if (config.includeArchitectGuidance === 'always') {
    includeArchitectGuidance = true;
  } else if (config.includeArchitectGuidance === 'auto') {
    // Include every 5th cycle (assumes periodic complex tasks)
    includeArchitectGuidance = cycleId % 5 === 0;
  }

  if (includeArchitectGuidance) {
    templatesUsed.push('autonomous-dev-architect.txt');
  }

  // MCP examples only for first 3 cycles
  let includeMcpExamples = false;
  if (config.includeMcpExamples === 'always') {
    includeMcpExamples = true;
  } else if (config.includeMcpExamples === 'first-3') {
    includeMcpExamples = cycleId <= 3;
  }

  if (includeMcpExamples) {
    templatesUsed.push('autonomous-dev-mcp.txt');
  }

  // Queue guidance - auto means include every 10th cycle
  let includeQueueGuidance = false;
  if (config.includeQueueGuidance === 'always') {
    includeQueueGuidance = true;
  } else if (config.includeQueueGuidance === 'auto') {
    // Include every 10th cycle (assumes queue occasionally empty)
    includeQueueGuidance = cycleId % 10 === 0;
  }

  if (includeQueueGuidance) {
    templatesUsed.push('autonomous-dev-queue.txt');
  }

  return {
    includeArchitectGuidance,
    includeMcpExamples,
    includeQueueGuidance,
    tokenBudget: config.tokenBudget,
    templatesUsed,
  };
}

/**
 * Build smart prompt with conditional sections (token-optimized)
 */
async function buildSmartPrompt(
  config: AutonomousDevConfig,
  cycleId: number,
  context: PromptContext
): Promise<string> {
  // Start with base template
  let prompt = await readTemplate('autonomous-dev-base.txt');
  prompt = prompt
    .replace('{{cycleId}}', cycleId.toString())
    .replace('{{focusFile}}', config.focusFile);

  let tokenCount = estimateTokens(prompt);

  // Add sections only if needed and within budget
  if (context.includeArchitectGuidance && tokenCount < context.tokenBudget - 100) {
    prompt += '\n\n' + await readTemplate('autonomous-dev-architect.txt');
    tokenCount += 100;
  }

  if (context.includeMcpExamples && tokenCount < context.tokenBudget - 80) {
    prompt += '\n\n' + await readTemplate('autonomous-dev-mcp.txt');
    tokenCount += 80;
  }

  if (context.includeQueueGuidance && tokenCount < context.tokenBudget - 70) {
    prompt += '\n\n' + await readTemplate('autonomous-dev-queue.txt');
    tokenCount += 70;
  }

  return prompt;
}

/**
 * Check if any worker terminal is busy
 */
async function countBusyTerminals(): Promise<number> {
  const workerTerminals = ['spaceos-backend', 'spaceos-frontend', 'spaceos-designer'];
  let busy = 0;

  for (const session of workerTerminals) {
    if (await hasSession(session)) {
      const state = await detectPaneState(session);
      if (state.state === 'busy') {
        busy++;
      }
    }
  }

  return busy;
}

/**
 * Check if any terminal has UNREAD inbox messages (for hybrid mode)
 */
async function hasUnreadInbox(): Promise<boolean> {
  const terminals = ['root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer', 'monitor'];

  for (const terminal of terminals) {
    const inboxPath = path.join(TERMINALS_PATH, terminal, 'inbox');

    try {
      const files = await fs.readdir(inboxPath);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filepath = path.join(inboxPath, file);
        const content = await fs.readFile(filepath, 'utf-8');

        if (content.includes('status: UNREAD')) {
          await log(`[AutonomousDev] Found UNREAD inbox: ${terminal}/${file}`);
          return true;
        }
      }
    } catch (err) {
      // Inbox directory might not exist
      continue;
    }
  }

  return false;
}

/**
 * Submit a durable Conductor task. The mailbox watcher emits SSE only; the
 * outbound runner owns the actual CLI process launch and deduplication.
 */
async function enqueueConductorTask(
  config: AutonomousDevConfig,
  cycleId: number,
  prompt: string,
  tokenCount: number
): Promise<{ success: boolean; id?: string; error?: string }> {
  await log(`[AutonomousDev] Cycle ${cycleId}: Queueing Conductor task (prompt tokens: ${tokenCount})`);
  const legacyModel = ['haiku', 'sonnet', 'opus'].includes(config.conductorModel)
    ? (config.conductorModel as 'haiku' | 'sonnet' | 'opus')
    : undefined;
  const result = await createTask({
    from: 'root',
    to: 'conductor',
    title: `Autonomous development cycle ${cycleId}`,
    description: prompt,
    acceptance_criteria: [
      'Set one precise goal and measurable success criteria before implementation.',
      'Stop on completion, a documented blocker, or exhausted retry/budget limits.',
      'Run the relevant quality gates and record their evidence.',
      'Update task execution notes, state.md, todo.md and MEMORY.md before completion.',
    ],
    priority: 'high',
    model: legacyModel,
    context: 'System-generated request. The runner is the only component allowed to launch the CLI process.',
  });

  if (result.success) {
    await log(`[AutonomousDev] Cycle ${cycleId}: Launch request queued as ${result.id}`);
  } else {
    await log(`[AutonomousDev] Cycle ${cycleId}: Queue failed: ${result.error || 'unknown error'}`);
  }
  return result;
}

/**
 * DEPRECATED: Legacy verbose prompt - kept for reference
 * Use buildSmartPrompt() instead for token-optimized prompts
 */
// function buildAutonomousPrompt(config: AutonomousDevConfig, cycleId: number): string { ... }

/**
 * Run one autonomous development cycle
 */
export async function runAutonomousCycle(
  config: AutonomousDevConfig = DEFAULT_CONFIG
): Promise<DevCycleResult> {
  const timestamp = new Date().toISOString();
  cycleCount++;
  const cycleId = cycleCount;

  await log(`[AutonomousDev] Starting cycle ${cycleId} (control mode: ${currentControlMode})`);

  // Control Mode Check #1: MANUAL mode - never start sessions
  if (currentControlMode === 'manual') {
    await log(`[AutonomousDev] Cycle ${cycleId}: Skipped - control mode is MANUAL`);
    return {
      timestamp,
      cycleId,
      conductorStarted: false,
      taskDispatched: false,
      skipped: 'Control mode is MANUAL (autonomous development disabled)',
    };
  }

  // Control Mode Check #2: HYBRID mode - skip if UNREAD inbox exists
  if (currentControlMode === 'hybrid') {
    const unread = await hasUnreadInbox();
    if (unread) {
      await log(`[AutonomousDev] Cycle ${cycleId}: Skipped - HYBRID mode detected UNREAD inbox (respecting manual tasks)`);
      return {
        timestamp,
        cycleId,
        conductorStarted: false,
        taskDispatched: false,
        skipped: 'HYBRID mode: UNREAD inbox detected (manual task has priority)',
      };
    }
  }

  // Check if skip needed
  if (config.skipIfBusy) {
    const busy = await countBusyTerminals();
    if (busy >= config.maxConcurrentTasks) {
      await log(`[AutonomousDev] Cycle ${cycleId}: Skipped - ${busy} terminals busy`);
      return {
        timestamp,
        cycleId,
        conductorStarted: false,
        taskDispatched: false,
        skipped: `${busy} terminals already busy`,
      };
    }
  }

  // Build optimized prompt
  try {
    const promptContext = determinePromptContext(config, cycleId);
    const prompt = await buildSmartPrompt(config, cycleId, promptContext);
    const promptTokenCount = estimateTokens(prompt);

    await log(
      `[AutonomousDev] Cycle ${cycleId}: Prompt tokens=${promptTokenCount}/${config.tokenBudget} ` +
      `(templates: ${promptContext.templatesUsed.join(', ')})`
    );

    // Warn if over budget
    if (promptTokenCount > config.tokenBudget) {
      await log(
        `[AutonomousDev] WARNING: Cycle ${cycleId} prompt exceeds budget ` +
        `(${promptTokenCount} > ${config.tokenBudget})`
      );
    }

    const queued = await enqueueConductorTask(config, cycleId, prompt, promptTokenCount);
    if (!queued.success) throw new Error(queued.error || 'failed to queue conductor task');

    lastCycleAt = timestamp;

    return {
      timestamp,
      cycleId,
      conductorStarted: false,
      taskDispatched: true,
      taskSummary: 'Conductor launch request queued for the autonomous runner',
      launchRequestId: queued.id,
      promptTokenCount,
      tokenBudget: config.tokenBudget,
      templatesUsed: promptContext.templatesUsed,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await log(`[AutonomousDev] Cycle ${cycleId} error: ${error}`);
    return {
      timestamp,
      cycleId,
      conductorStarted: false,
      taskDispatched: false,
      error,
    };
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Start the autonomous development scheduler
 */
export function startAutonomousDevScheduler(config: AutonomousDevConfig = DEFAULT_CONFIG): void {
  if (!config.enabled) {
    logger.info('[AutonomousDev] Scheduler disabled (set ENABLE_AUTONOMOUS_DEV=true)');
    return;
  }

  if (intervalId) {
    logger.info('[AutonomousDev] Scheduler already running');
    return;
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;

  logger.info(`[AutonomousDev] Scheduler starting (every ${config.intervalMinutes} minutes)`);
  logger.info(`   📄 Focus file: ${config.focusFile}`);
  logger.info(`   🔄 Cold start: ${config.coldStart}`);
  logger.info(`   ⏸️ Skip if busy: ${config.skipIfBusy}`);

  // Run first cycle after initial delay (give system time to stabilize)
  setTimeout(async () => {
    try {
      const result = await runAutonomousCycle(config);
      logger.info(`[AutonomousDev] Initial cycle: ${result.taskDispatched ? 'queued' : 'skipped'}`);

      if (result.taskDispatched) {
        await telegram(`🤖 Autonóm fejlesztés #${result.cycleId} sorba állítva (${result.launchRequestId})`);
      }
    } catch (err) {
      logger.error('[AutonomousDev] Initial cycle error:', err);
    }
  }, 30000); // 30 sec initial delay

  // Then run on interval
  intervalId = setInterval(async () => {
    try {
      const result = await runAutonomousCycle(config);

      if (result.taskDispatched) {
        logger.info(`[AutonomousDev] Cycle ${result.cycleId}: Launch request queued (${result.launchRequestId})`);
      } else if (result.skipped) {
        logger.info(`[AutonomousDev] Cycle ${result.cycleId}: Skipped - ${result.skipped}`);
      } else if (result.error) {
        logger.info(`[AutonomousDev] Cycle ${result.cycleId}: Error - ${result.error}`);
      }
    } catch (err) {
      logger.error('[AutonomousDev] Cycle error:', err);
    }
  }, intervalMs);

  // Log config summary
  logger.info(`   🔁 Auto-Restart: ENABLED (every ${config.intervalMinutes}min)`);
}

/**
 * Stop the autonomous development scheduler
 */
export function stopAutonomousDevScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[AutonomousDev] Scheduler stopped');
  }
}

/**
 * Get current status
 */
export function getAutonomousDevStatus(): {
  enabled: boolean;
  running: boolean;
  cycleCount: number;
  lastCycleAt: string | null;
  controlMode: ControlMode;
  config: AutonomousDevConfig;
} {
  return {
    enabled: DEFAULT_CONFIG.enabled,
    running: intervalId !== null,
    cycleCount,
    lastCycleAt,
    controlMode: currentControlMode,
    config: DEFAULT_CONFIG,
  };
}

/**
 * Get current control mode
 */
export function getControlMode(): ControlMode {
  return currentControlMode;
}

/**
 * Set control mode (manual | autonomous | hybrid)
 */
export function setControlMode(mode: ControlMode): void {
  currentControlMode = mode;
  logger.info(`[AutonomousDev] Control mode changed to: ${mode}`);
}

/**
 * Trigger a manual cycle (for testing)
 */
export async function triggerManualCycle(): Promise<DevCycleResult> {
  return runAutonomousCycle(DEFAULT_CONFIG);
}

// ─── Express Router ──────────────────────────────────────────────────────────

import { Router } from 'express';
import { logger } from '../core/logger';

export function createAutonomousDevRouter(): Router {
  const router = Router();

  // Get status
  router.get('/status', (_req, res) => {
    res.json(getAutonomousDevStatus());
  });

  // Get control mode
  router.get('/mode', (_req, res) => {
    res.json({ mode: getControlMode() });
  });

  // Set control mode
  router.post('/mode', (req, res) => {
    const { mode } = req.body;

    if (!mode || !['manual', 'autonomous', 'hybrid'].includes(mode)) {
      return res.status(400).json({
        error: 'Invalid mode. Must be one of: manual, autonomous, hybrid',
      });
    }

    setControlMode(mode as ControlMode);
    res.json({
      success: true,
      mode: getControlMode(),
      message: `Control mode set to: ${mode}`,
    });
  });

  // Trigger manual cycle
  router.post('/trigger', async (_req, res) => {
    try {
      const result = await triggerManualCycle();
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Start scheduler
  router.post('/start', (_req, res) => {
    startAutonomousDevScheduler();
    res.json({ success: true, message: 'Scheduler started' });
  });

  // Stop scheduler
  router.post('/stop', (_req, res) => {
    stopAutonomousDevScheduler();
    res.json({ success: true, message: 'Scheduler stopped' });
  });

  return router;
}

// ─── Run standalone ──────────────────────────────────────────────────────────

if (require.main === module) {
  logger.info('=== Autonomous Development Module ===');
  logger.info(`Enabled: ${DEFAULT_CONFIG.enabled}`);
  logger.info(`Interval: ${DEFAULT_CONFIG.intervalMinutes} minutes`);
  logger.info(`Focus file: ${DEFAULT_CONFIG.focusFile}`);
  logger.info(`Cold start: ${DEFAULT_CONFIG.coldStart}`);

  if (process.argv.includes('--trigger')) {
    logger.info('\nTriggering manual cycle...');
    triggerManualCycle()
      .then(result => {
        logger.info('\nResult:', JSON.stringify(result, null, 2));
      })
      .catch(err => {
        logger.error('Error:', err);
      });
  }
}
