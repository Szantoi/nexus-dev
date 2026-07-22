/**
 * Workflow Manager - Manages YAML-based workflow definitions
 *
 * Features:
 * - List all workflows
 * - Get workflow state
 * - Advance workflow steps
 * - Generate tasks from workflow steps
 * - Epic/Task management integration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  saveWorkflow as saveWorkflowToDb,
  saveState as saveStateToDb,
  getStateFromDb,
  addHistory,
  trackTask,
  saveEpic,
  getAllEpicsFromDb,
  getEpicFromDb,
  updateEpicStatusInDb,
  getEpicStats,
  getWorkflowStats,
  importEpicsFromYaml,
  hasPendingOrRecentTask,
} from './workflowDb';
import { logger } from './core/logger';

import { WORKFLOWS_DIR as WORKFLOW_DIR, EPICS_PATH as EPICS_FILE } from './config/paths';

// Types
export interface WorkflowStep {
  id: string;
  name: string;
  terminal: string;
  island: string;
  model: string;
  prompt: string;
  next_step: string;
  depends_on?: string;
  timeout_hours?: number;
  condition?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  focus: string;
  priority: string;
  enabled: boolean;
  state_file: string;
  steps: WorkflowStep[];
  metadata?: {
    created: string;
    author: string;
    version: string;
    cycle_interval_hours?: number;
  };
}

export interface WorkflowState {
  workflow_id: string;
  current_step: string;
  last_updated: string;
  history: Array<{
    step: string;
    started_at: string;
    completed_at?: string;
    status: 'pending' | 'active' | 'done' | 'failed';
  }>;
}

export interface Epic {
  id: string;
  name: string;
  description?: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  depends_on?: string[];
  parallel_with?: string[];
  target_date?: string;
  assignee?: string;
  tasks?: string[];
}

// Helper: Parse YAML file
function parseYamlFile<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return yaml.load(content) as T;
  } catch (error) {
    logger.error(`Failed to parse YAML: ${filePath}`, error);
    return null;
  }
}

// Helper: Get state file path
function getStateFilePath(workflowId: string): string {
  return path.join(WORKFLOW_DIR, `.${workflowId}-state`);
}

/**
 * List all available workflows
 */
export function listWorkflows(): Array<{
  id: string;
  name: string;
  enabled: boolean;
  current_step: string;
  focus: string;
}> {
  const workflows: Array<{
    id: string;
    name: string;
    enabled: boolean;
    current_step: string;
    focus: string;
  }> = [];

  try {
    const files = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.yaml'));

    for (const file of files) {
      const filePath = path.join(WORKFLOW_DIR, file);
      const wf = parseYamlFile<Workflow>(filePath);

      if (wf?.id) {
        const state = getWorkflowState(wf.id);
        workflows.push({
          id: wf.id,
          name: wf.name,
          enabled: wf.enabled,
          current_step: state?.current_step || wf.steps[0]?.id || 'unknown',
          focus: wf.focus,
        });
      }
    }
  } catch (error) {
    logger.error('Failed to list workflows:', error);
  }

  return workflows;
}

/**
 * Get detailed workflow information
 */
export function getWorkflowDetails(workflowId: string): Workflow | null {
  try {
    const files = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.yaml'));

    for (const file of files) {
      const filePath = path.join(WORKFLOW_DIR, file);
      const wf = parseYamlFile<Workflow>(filePath);

      if (wf?.id === workflowId) {
        return wf;
      }
    }
  } catch (error) {
    logger.error('Failed to get workflow:', error);
  }

  return null;
}

/**
 * Get workflow state
 */
export function getWorkflowState(workflowId: string): WorkflowState | null {
  const stateFile = getStateFilePath(workflowId);

  try {
    if (fs.existsSync(stateFile)) {
      const content = fs.readFileSync(stateFile, 'utf-8').trim();

      // Simple state (just step name)
      if (!content.startsWith('{')) {
        return {
          workflow_id: workflowId,
          current_step: content,
          last_updated: new Date().toISOString(),
          history: [],
        };
      }

      // JSON state
      return JSON.parse(content) as WorkflowState;
    }
  } catch (error) {
    logger.error('Failed to get workflow state:', error);
  }

  return null;
}

/** Result of a state write — on failure the error is propagated, not swallowed (TASK-QC-011) */
export interface SetWorkflowStateResult {
  success: boolean;
  error?: string;
}

/**
 * Set workflow state (file + DB)
 */
export function setWorkflowState(
  workflowId: string,
  step: string,
  saveHistory: boolean = false
): SetWorkflowStateResult {
  const stateFile = getStateFilePath(workflowId);

  try {
    const existingState = getWorkflowState(workflowId);

    // Save to DB
    saveStateToDb(workflowId, step, existingState?.current_step, 'active');

    // Add history to DB if transitioning
    if (saveHistory && existingState?.current_step && existingState.current_step !== step) {
      addHistory({
        workflow_id: workflowId,
        step_id: existingState.current_step,
        notes: `Transitioned to ${step}`,
      });
    }

    // Also save to file for backward compatibility
    if (saveHistory) {
      const newState: WorkflowState = {
        workflow_id: workflowId,
        current_step: step,
        last_updated: new Date().toISOString(),
        history: existingState?.history || [],
      };

      if (existingState?.current_step && existingState.current_step !== step) {
        newState.history.push({
          step: existingState.current_step,
          started_at: existingState.last_updated,
          completed_at: new Date().toISOString(),
          status: 'done',
        });
      }

      fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));
    } else {
      fs.writeFileSync(stateFile, step);
    }

    return { success: true };
  } catch (error) {
    // Distinguish a programming (logic) error — e.g. a bad named param in a
    // prepared statement — from runtime I/O failures (DB lock, fs write), and
    // propagate the message instead of a bare false (TASK-QC-011).
    const kind = error instanceof RangeError || error instanceof TypeError ? 'logic' : 'io';
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logger.error(`Failed to set workflow state (${kind} error):`, error);
    return { success: false, error: message };
  }
}

/**
 * Advance workflow to next step
 */
export function advanceWorkflow(workflowId: string): {
  success: boolean;
  previous_step?: string;
  current_step?: string;
  error?: string;
} {
  const workflow = getWorkflowDetails(workflowId);
  if (!workflow) {
    return { success: false, error: 'Workflow not found' };
  }

  const state = getWorkflowState(workflowId);
  const currentStep = state?.current_step || workflow.steps[0]?.id;

  // Find current step and get next
  const stepIndex = workflow.steps.findIndex(s => s.id === currentStep);
  if (stepIndex === -1) {
    return { success: false, error: `Step not found: ${currentStep}` };
  }

  const nextStepId = workflow.steps[stepIndex]?.next_step;
  if (!nextStepId) {
    return { success: false, error: 'No next step defined' };
  }

  // Set new state (propagates the write error, if any — TASK-QC-011)
  const result = setWorkflowState(workflowId, nextStepId, true);

  return {
    success: result.success,
    previous_step: currentStep,
    current_step: nextStepId,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/**
 * Generate task from workflow step
 */
export function generateWorkflowTask(
  workflowId: string,
  stepId?: string,
  options?: { force?: boolean }
): {
  success: boolean;
  task_file?: string;
  skipped?: boolean;
  existing_task?: string;
  error?: string;
} {
  const workflow = getWorkflowDetails(workflowId);
  if (!workflow) {
    return { success: false, error: 'Workflow not found' };
  }

  const state = getWorkflowState(workflowId);
  const targetStep = stepId || state?.current_step || workflow.steps[0]?.id;

  const step = workflow.steps.find(s => s.id === targetStep);
  if (!step) {
    return { success: false, error: `Step not found: ${targetStep}` };
  }

  // Check for duplicate tasks (pending or recently completed)
  if (!options?.force) {
    const existingTask = hasPendingOrRecentTask(workflowId, targetStep);
    if (existingTask) {
      logger.info(`[WorkflowManager] Skipping duplicate task generation for ${workflowId}:${targetStep} - existing task: ${existingTask.task_file} (${existingTask.status})`);
      return {
        success: true,
        skipped: true,
        existing_task: existingTask.task_file,
        error: `Task already exists (${existingTask.status}): ${existingTask.task_file}`,
      };
    }
  }

  const island = step.island || 'spaceos';
  const terminal = step.terminal || 'conductor';
  const model = step.model || 'sonnet';

  const date = new Date().toISOString().split('T')[0];
  const inboxDir = `/opt/${island}/terminals/${terminal}/inbox`;

  // Get next message number
  let msgNum = '001';
  try {
    const files = fs.readdirSync(inboxDir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}_\d{3}/));
    if (files.length > 0) {
      const lastNum = parseInt(files.sort().pop()?.split('_')[1] || '0', 10);
      msgNum = String(lastNum + 1).padStart(3, '0');
    }
  } catch {}

  const slug = step.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const filename = `${date}_${msgNum}_wf-${slug}.md`;
  const filepath = path.join(inboxDir, filename);

  const content = `---
id: MSG-WF-${workflowId}-${targetStep.toUpperCase()}-${msgNum}
from: nexus-workflow-manager
to: ${island}-${terminal}
type: task
priority: high
status: UNREAD
model: ${model}
workflow_id: ${workflowId}
workflow_step: ${targetStep}
next_step: ${step.next_step || 'none'}
created: ${date}
---

# ${workflow.name} — ${step.name}

${step.prompt || 'No prompt defined'}

---

**Workflow:** \`${workflowId}\` | **Lépés:** \`${targetStep}\` → \`${step.next_step || 'END'}\`

_Generated by Nexus Workflow Manager — ${date}_
`;

  try {
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(filepath, content);

    // Track task in DB for duplicate prevention
    trackTask({
      workflow_id: workflowId,
      step_id: targetStep,
      task_file: filepath,
      terminal,
      island,
      model,
    });

    logger.info(`[WorkflowManager] Generated task: ${filepath}`);
    return { success: true, task_file: filepath };
  } catch (error) {
    return { success: false, error: `Failed to write task: ${error}` };
  }
}

/**
 * List epics from EPICS.yaml
 */
export function listEpics(): Epic[] {
  try {
    const content = parseYamlFile<{ epics: Epic[] }>(EPICS_FILE);
    return content?.epics || [];
  } catch (error) {
    logger.error('Failed to list epics:', error);
    return [];
  }
}

/**
 * Get epic by ID
 */
export function getEpic(epicId: string): Epic | null {
  const epics = listEpics();
  return epics.find(e => e.id === epicId) || null;
}

/**
 * Update epic status
 */
export function updateEpicStatus(
  epicId: string,
  status: 'pending' | 'active' | 'done' | 'blocked'
): boolean {
  try {
    const content = parseYamlFile<{ epics: Epic[] }>(EPICS_FILE);
    if (!content?.epics) return false;

    const epic = content.epics.find(e => e.id === epicId);
    if (!epic) return false;

    epic.status = status;

    const yamlContent = yaml.dump(content, { lineWidth: -1 });
    fs.writeFileSync(EPICS_FILE, yamlContent);

    return true;
  } catch (error) {
    logger.error('Failed to update epic:', error);
    return false;
  }
}

/**
 * Get workflow summary for all workflows
 */
export function getWorkflowSummary(): {
  total: number;
  enabled: number;
  workflows: Array<{
    id: string;
    name: string;
    enabled: boolean;
    current_step: string;
    step_index: number;
    total_steps: number;
    focus: string;
  }>;
} {
  const workflows = listWorkflows();
  const detailed = workflows.map(wf => {
    const details = getWorkflowDetails(wf.id);
    const stepIndex = details?.steps.findIndex(s => s.id === wf.current_step) ?? 0;
    return {
      ...wf,
      step_index: stepIndex + 1,
      total_steps: details?.steps.length || 0,
    };
  });

  return {
    total: workflows.length,
    enabled: workflows.filter(w => w.enabled).length,
    workflows: detailed,
  };
}

// MCP Tool Definitions
export const WORKFLOW_TOOLS = [
  {
    name: 'list_workflows',
    description: 'List all available workflows with their current state',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    // Named get_workflow_details to avoid colliding with the legacy
    // get_workflow tool in mcp.ts (which returns WORKFLOW.md).
    name: 'get_workflow_details',
    description: 'Get detailed information about a specific workflow',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'The workflow ID (e.g., WF-NEXUS-DEV)',
        },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'get_workflow_state',
    description: 'Get the current state of a workflow',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'The workflow ID',
        },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'advance_workflow',
    description: 'Advance a workflow to its next step',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'The workflow ID to advance',
        },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'generate_workflow_task',
    description: 'Generate an inbox task from the current workflow step. Skips if a pending/recent task exists unless force=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'The workflow ID',
        },
        step_id: {
          type: 'string',
          description: 'Optional: specific step ID (defaults to current step)',
        },
        force: {
          type: 'boolean',
          description: 'Force generation even if a task already exists (default: false)',
        },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'set_workflow_step',
    description: 'Manually set the workflow to a specific step',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'The workflow ID',
        },
        step_id: {
          type: 'string',
          description: 'The step ID to set',
        },
      },
      required: ['workflow_id', 'step_id'],
    },
  },
  {
    name: 'list_epics',
    description: 'List all epics from EPICS.yaml',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status_filter: {
          type: 'string',
          enum: ['all', 'pending', 'active', 'done', 'blocked'],
          description: 'Filter by status (default: all)',
        },
      },
      required: [] as string[],
    },
  },
  {
    name: 'update_epic',
    description: 'Update an epic status',
    inputSchema: {
      type: 'object' as const,
      properties: {
        epic_id: {
          type: 'string',
          description: 'The epic ID',
        },
        status: {
          type: 'string',
          enum: ['pending', 'active', 'done', 'blocked'],
          description: 'New status',
        },
      },
      required: ['epic_id', 'status'],
    },
  },
  {
    name: 'workflow_summary',
    description: 'Get a summary of all workflows and their progress',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
  },
];

// MCP Response type
interface McpResponse {
  content: Array<{ type: 'text'; text: string }>;
}

// Helper to format MCP response
function mcpResponse(data: unknown): McpResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Handle MCP tool calls
 */
export function handleWorkflowTool(
  toolName: string,
  args: Record<string, unknown>
): McpResponse {
  switch (toolName) {
    case 'list_workflows':
      return mcpResponse(listWorkflows());

    case 'get_workflow_details':
      return mcpResponse(getWorkflowDetails(args.workflow_id as string));

    case 'get_workflow_state':
      return mcpResponse(getWorkflowState(args.workflow_id as string));

    case 'advance_workflow':
      return mcpResponse(advanceWorkflow(args.workflow_id as string));

    case 'generate_workflow_task':
      return mcpResponse(generateWorkflowTask(
        args.workflow_id as string,
        args.step_id as string | undefined,
        { force: args.force as boolean | undefined }
      ));

    case 'set_workflow_step':
      // { success, error? } — the write error is surfaced to the MCP caller
      return mcpResponse(setWorkflowState(
        args.workflow_id as string,
        args.step_id as string,
        true
      ));

    case 'list_epics': {
      const epics = listEpics();
      const filter = args.status_filter as string;
      if (filter && filter !== 'all') {
        return mcpResponse(epics.filter(e => e.status === filter));
      }
      return mcpResponse(epics);
    }

    case 'update_epic':
      return mcpResponse({
        success: updateEpicStatus(
          args.epic_id as string,
          args.status as 'pending' | 'active' | 'done' | 'blocked'
        ),
      });

    case 'workflow_summary':
      return mcpResponse(getWorkflowSummary());

    default:
      return mcpResponse({ error: `Unknown workflow tool: ${toolName}` });
  }
}
