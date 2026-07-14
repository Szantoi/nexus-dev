// phaseCoordinator.ts - Project Phase Coordinator
//
// Connects the Project Automation system (TASKS.yaml) to the Conductor terminal.
// Automatically determines project phase and notifies Conductor.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Router } from 'express';
import {
  SPACEOS_ROOT,
  log,
  telegram,
} from './common';

// --- Types ---

export type ProjectPhase = 'planning' | 'execution' | 'blocked' | 'complete' | 'idle';

export interface PhaseConfig {
  enabled: boolean;
  intervalMinutes: number;
  projectsDir: string;
  planningDir: string;
  conductorInbox: string;
}

export interface ProjectStatus {
  slug: string;
  path: string;
  phase: ProjectPhase;
  totalTasks: number;
  pendingTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  doneTasks: number;
  lastUpdated: string;
}

export interface PhaseCoordinatorState {
  lastRun: string | null;
  lastPhase: ProjectPhase | null;
  projects: ProjectStatus[];
  config: PhaseConfig;
}

interface TaskItem {
  id: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'done';
  title?: string;
  assignee?: string;
  blockedBy?: string;
}

interface TasksYaml {
  project: string;
  tasks?: TaskItem[];
}

// --- Configuration ---

function getConfig(): PhaseConfig {
  return {
    enabled: process.env.ENABLE_PHASE_COORDINATOR === 'true',
    intervalMinutes: parseInt(process.env.PHASE_COORDINATOR_INTERVAL_MINUTES || '30', 10),
    projectsDir: path.join(SPACEOS_ROOT, 'docs', 'projects'),
    planningDir: path.join(SPACEOS_ROOT, 'docs', 'planning'),
    conductorInbox: path.join(SPACEOS_ROOT, 'terminals', 'conductor', 'inbox'),
  };
}

// --- State Management ---

let state: PhaseCoordinatorState = {
  lastRun: null,
  lastPhase: null,
  projects: [],
  config: getConfig(),
};

let schedulerInterval: NodeJS.Timeout | null = null;

// --- Core Functions ---

async function findTasksYamlFiles(projectsDir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const tasksPath = path.join(projectsDir, entry.name, 'TASKS.yaml');
        try {
          await fs.access(tasksPath);
          files.push(tasksPath);
        } catch {
          // TASKS.yaml not found in this project directory
        }
      }
    }
  } catch (error) {
    await log('[PhaseCoordinator] Error scanning projects dir: ' + String(error));
  }

  return files;
}

async function parseTasksYaml(filePath: string): Promise<TasksYaml | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = yaml.load(content) as TasksYaml;
    return parsed;
  } catch (error) {
    await log('[PhaseCoordinator] Error parsing ' + filePath + ': ' + String(error));
    return null;
  }
}

function determinePhase(tasks: TaskItem[]): ProjectPhase {
  if (!tasks || tasks.length === 0) {
    return 'idle';
  }

  const counts = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  };

  for (const task of tasks) {
    if (task.status in counts) {
      counts[task.status]++;
    }
  }

  if (counts.in_progress > 0) {
    return 'execution';
  }

  if (counts.done === tasks.length) {
    return 'complete';
  }

  if (counts.blocked > 0 && counts.pending === 0 && counts.in_progress === 0) {
    return 'blocked';
  }

  if (counts.pending > 0 || counts.blocked > 0) {
    return 'planning';
  }

  return 'idle';
}

async function analyzeProject(tasksPath: string): Promise<ProjectStatus | null> {
  const parsed = await parseTasksYaml(tasksPath);
  if (!parsed) {
    return null;
  }

  const tasks = parsed.tasks || [];
  const phase = determinePhase(tasks);

  const projectDir = path.dirname(tasksPath);
  const slug = path.basename(projectDir);

  let stat;
  try {
    stat = await fs.stat(tasksPath);
  } catch {
    stat = { mtime: new Date() };
  }

  return {
    slug,
    path: tasksPath,
    phase,
    totalTasks: tasks.length,
    pendingTasks: tasks.filter(t => t.status === 'pending').length,
    inProgressTasks: tasks.filter(t => t.status === 'in_progress').length,
    blockedTasks: tasks.filter(t => t.status === 'blocked').length,
    doneTasks: tasks.filter(t => t.status === 'done').length,
    lastUpdated: stat.mtime.toISOString(),
  };
}

function determineGlobalPhase(projects: ProjectStatus[]): ProjectPhase {
  if (projects.length === 0) {
    return 'idle';
  }

  const hasExecution = projects.some(p => p.phase === 'execution');
  if (hasExecution) {
    return 'execution';
  }

  const hasBlocked = projects.some(p => p.phase === 'blocked');
  if (hasBlocked) {
    return 'blocked';
  }

  const hasPlanning = projects.some(p => p.phase === 'planning');
  if (hasPlanning) {
    return 'planning';
  }

  const allComplete = projects.every(p => p.phase === 'complete' || p.phase === 'idle');
  if (allComplete && projects.some(p => p.phase === 'complete')) {
    return 'complete';
  }

  return 'idle';
}

async function sendConductorInbox(phase: ProjectPhase, projects: ProjectStatus[]): Promise<void> {
  const config = getConfig();
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  let nextNum = 1;
  try {
    const files = await fs.readdir(config.conductorInbox);
    const today = files.filter(f => f.startsWith(dateStr));
    nextNum = today.length + 1;
  } catch {
    // Directory might not exist
  }

  const numStr = String(nextNum).padStart(3, '0');
  const filename = dateStr + '_' + numStr + '_phase-' + phase + '.md';
  const filepath = path.join(config.conductorInbox, filename);

  const projectSummary = projects.map(p =>
    '- **' + p.slug + '**: ' + p.phase + ' (' + p.inProgressTasks + ' in_progress, ' + p.pendingTasks + ' pending, ' + p.blockedTasks + ' blocked, ' + p.doneTasks + ' done)'
  ).join('\n');

  const priority = phase === 'blocked' ? 'high' : 'medium';

  const content = `---
id: MSG-CONDUCTOR-PHASE-` + numStr + `
from: phaseCoordinator
to: conductor
type: phase-update
priority: ` + priority + `
status: UNREAD
model: sonnet
created: ` + dateStr + `
---

# Project Phase Update: ` + phase.toUpperCase() + `

## Current Phase: ` + phase + `

The Phase Coordinator detected a phase transition or check cycle.

## Project Summary

` + projectSummary + `

## Recommended Actions

` + getPhaseRecommendations(phase) + `

---

*Auto-generated by phaseCoordinator at ` + now.toISOString() + `*
`;

  try {
    await fs.mkdir(config.conductorInbox, { recursive: true });
    await fs.writeFile(filepath, content, 'utf-8');
    await log('[PhaseCoordinator] Created conductor inbox: ' + filename);
  } catch (error) {
    await log('[PhaseCoordinator] Error creating conductor inbox: ' + String(error));
  }
}

function getPhaseRecommendations(phase: ProjectPhase): string {
  switch (phase) {
    case 'planning':
      return '- Review pending tasks and assign to appropriate terminals\n- Check if any tasks need spec clarification\n- Consider breaking down large tasks';
    case 'execution':
      return '- Monitor in_progress tasks for completion\n- Check terminal sessions are active\n- Review any DONE outbox messages';
    case 'blocked':
      return '- Escalate blocked items to root if needed\n- Check blockedBy dependencies\n- Consider alternative approaches';
    case 'complete':
      return '- Verify all deliverables are complete\n- Update project documentation\n- Archive completed tasks';
    case 'idle':
      return '- Check planning queue for new work\n- Review idea backlog\n- Consider proactive improvements';
    default:
      return '- Review current state and take appropriate action';
  }
}

// --- Main Execution ---

export async function runPhaseCheck(): Promise<PhaseCoordinatorState> {
  const config = getConfig();
  await log('[PhaseCoordinator] Starting phase check...');

  const tasksFiles = await findTasksYamlFiles(config.projectsDir);
  await log('[PhaseCoordinator] Found ' + tasksFiles.length + ' project(s)');

  const projects: ProjectStatus[] = [];
  for (const file of tasksFiles) {
    const status = await analyzeProject(file);
    if (status) {
      projects.push(status);
    }
  }

  const globalPhase = determineGlobalPhase(projects);
  const previousPhase = state.lastPhase;

  await log('[PhaseCoordinator] Global phase: ' + globalPhase + ' (previous: ' + (previousPhase || 'none') + ')');

  state = {
    lastRun: new Date().toISOString(),
    lastPhase: globalPhase,
    projects,
    config,
  };

  if (globalPhase !== previousPhase || globalPhase === 'blocked') {
    if (previousPhase !== null) {
      await log('[PhaseCoordinator] Phase transition: ' + previousPhase + ' -> ' + globalPhase);
      await sendConductorInbox(globalPhase, projects);

      if (globalPhase === 'blocked' || globalPhase === 'complete') {
        const emoji = globalPhase === 'blocked' ? '\uD83D\uDEA8' : '\u2705';
        await telegram(
          emoji + ' *Phase Coordinator*\n' +
          'Phase: ' + previousPhase + ' -> ' + globalPhase + '\n' +
          'Projects: ' + projects.length
        );
      }
    }
  }

  await log('[PhaseCoordinator] Phase check complete');
  return state;
}

// --- Scheduler ---

export function startPhaseCoordinator(): void {
  const config = getConfig();

  if (!config.enabled) {
    log('[PhaseCoordinator] Phase Coordinator is disabled');
    return;
  }

  if (schedulerInterval) {
    log('[PhaseCoordinator] Phase Coordinator already running');
    return;
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;

  log('[PhaseCoordinator] Starting Phase Coordinator (every ' + config.intervalMinutes + ' minutes)');

  runPhaseCheck().catch(err => {
    log('[PhaseCoordinator] Initial run error: ' + String(err));
  });

  schedulerInterval = setInterval(() => {
    runPhaseCheck().catch(err => {
      log('[PhaseCoordinator] Scheduled run error: ' + String(err));
    });
  }, intervalMs);
}

export function stopPhaseCoordinator(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    log('[PhaseCoordinator] Phase Coordinator stopped');
  }
}

export function getPhaseCoordinatorStatus(): PhaseCoordinatorState {
  return { ...state, config: getConfig() };
}

// --- Express Router ---

export function createPhaseCoordinatorRouter(): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    res.json(getPhaseCoordinatorStatus());
  });

  router.post('/check', async (_req, res) => {
    try {
      const result = await runPhaseCheck();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  router.get('/projects', (_req, res) => {
    res.json(state.projects);
  });

  return router;
}

// --- Standalone Execution ---

if (require.main === module) {
  console.log('Running Phase Coordinator standalone...');
  runPhaseCheck()
    .then(result => {
      console.log('Phase check result:');
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}
