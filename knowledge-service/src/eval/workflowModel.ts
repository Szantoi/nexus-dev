/**
 * Workflow model (DDD domain module) — the DECLARED expected lifecycle per
 * canonical message type, loaded from config/workflows.yaml (env-overridable via
 * WORKFLOWS_CONFIG_PATH).
 *
 * WHY: golden paths are RECORDED references ("a known-good run looked like this");
 * workflows are PRESCRIBED expectations ("a task is supposed to go read →
 * in_progress → completed, and shouldn't sit unread for more than 24h"). Declaring
 * them in config makes the expectation itself reviewable and identical across
 * islands — the "workflow-meghatározás, amit el kell várni a szerveren,
 * konfigurálhatóan" requirement (Gábor, 2026-07-12).
 */
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { WORKFLOWS_CONFIG_PATH } from '../config/paths';
import { logger } from '../core/logger';

const log = (msg: string) => logger.info(`[WorkflowModel] ${msg}`);
const warn = (msg: string) => logger.warn(`[WorkflowModel] ⚠️ ${msg}`);

export interface WorkflowDefinition {
  expected_trajectory: string[];
  max_hours_in?: Record<string, number>;
}

interface WorkflowsConfig {
  version: string;
  workflows: Record<string, WorkflowDefinition>;
  default_workflow: WorkflowDefinition;
}

let cached: WorkflowsConfig | null = null;

const FALLBACK: WorkflowsConfig = {
  version: '0-fallback',
  workflows: {},
  default_workflow: { expected_trajectory: ['read', 'completed'] },
};

function loadConfig(): WorkflowsConfig {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(WORKFLOWS_CONFIG_PATH, 'utf-8');
    const cfg = yaml.load(raw) as WorkflowsConfig;
    if (!cfg || typeof cfg.workflows !== 'object' || !cfg.default_workflow) {
      throw new Error('workflows.yaml missing "workflows" map or "default_workflow"');
    }
    cached = cfg;
    log(`Loaded workflow definitions v${cfg.version}: ${Object.keys(cfg.workflows).length} type(s) from ${WORKFLOWS_CONFIG_PATH}`);
    return cfg;
  } catch (err) {
    warn(`Could not load ${WORKFLOWS_CONFIG_PATH}: ${(err as Error).message}. Using built-in fallback.`);
    cached = FALLBACK;
    return cached;
  }
}

/** For tests / hot-reload. */
export function reloadWorkflows(): void { cached = null; }

/**
 * The workflow definition for a message type. Falls back to default_workflow
 * (with a warning) for unknown types — never throws, the expectation always exists.
 */
export function getWorkflow(type: string): WorkflowDefinition {
  const cfg = loadConfig();
  const wf = cfg.workflows[type];
  if (!wf) {
    warn(`No workflow declared for type '${type}' — using default_workflow.`);
    return cfg.default_workflow;
  }
  return wf;
}

/** The declared expected lifecycle steps for a message type. */
export function expectedTrajectory(type: string): string[] {
  return getWorkflow(type).expected_trajectory;
}

/**
 * Config-driven stuck threshold: how many hours may a message of this type sit
 * in the given status before it counts as stuck. Undefined = no limit declared.
 */
export function maxHoursIn(type: string, status: string): number | undefined {
  return getWorkflow(type).max_hours_in?.[status];
}
