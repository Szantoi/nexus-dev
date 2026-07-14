/**
 * epicProgressTracker.ts - Real-time epic completion visualization
 *
 * MCP Phase 2: Track epic progress with burndown estimation
 * MSG-NEXUS-005
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Epic {
  id: string;
  name: string;
  project: string;
  depends_on: string[];
  parallel_with?: string[];
  status: 'pending' | 'active' | 'done' | 'blocked';
  target_date: string;
  completed_date?: string;
  final_progress?: number;
  tasks_yaml?: string;
  description?: string;
}

export interface EpicProgress {
  epic_id: string;
  epic_name: string;
  status: string;
  progress_percent: number;
  tasks_done: number;
  tasks_total: number;
  blockers: string[];
  estimated_completion: string | null;
  target_date: string;
  days_remaining: number | null;
}

export interface TaskStatus {
  id: string;
  status: string;
  is_blocker: boolean;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const getSpaceOSRoot = () => process.env.SPACEOS_ROOT || '/opt/spaceos';
const getEpicsPath = () => path.join(getSpaceOSRoot(), 'docs/projects/EPICS.yaml');

// ─── EPICS.yaml Loading ──────────────────────────────────────────────────────

/**
 * Load EPICS.yaml file
 */
export async function loadEpics(): Promise<Epic[]> {
  try {
    const epicsPath = getEpicsPath();
    const content = await fs.readFile(epicsPath, 'utf-8');
    const data = yaml.load(content) as { epics: Epic[] };

    if (!data || !Array.isArray(data.epics)) {
      console.error('[EpicProgress] Invalid EPICS.yaml structure');
      return [];
    }

    return data.epics;
  } catch (error) {
    console.error('[EpicProgress] Error loading EPICS.yaml:', error);
    return [];
  }
}

/**
 * Find epic by ID
 */
export async function findEpic(epicId: string): Promise<Epic | null> {
  const epics = await loadEpics();
  return epics.find(e => e.id === epicId) || null;
}

// ─── Task Status Aggregation ─────────────────────────────────────────────────

/**
 * Scan terminal inboxes for tasks related to epic
 * (Simple implementation: checks all inbox messages for epic reference)
 */
async function scanTerminalTasks(epicId: string): Promise<TaskStatus[]> {
  const tasks: TaskStatus[] = [];
  const terminalsPath = path.join(getSpaceOSRoot(), 'terminals');

  try {
    const terminals = ['root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer', 'monitor'];

    for (const terminal of terminals) {
      const inboxPath = path.join(terminalsPath, terminal, 'inbox');
      const outboxPath = path.join(terminalsPath, terminal, 'outbox');

      // Scan inbox
      try {
        const inboxFiles = await fs.readdir(inboxPath);
        for (const file of inboxFiles.filter(f => f.endsWith('.md'))) {
          const content = await fs.readFile(path.join(inboxPath, file), 'utf-8');
          
          // Check if task references this epic
          if (content.includes(epicId)) {
            const idMatch = content.match(/^id:\s*(.+)$/m);
            const statusMatch = content.match(/^status:\s*(.+)$/m);
            const typeMatch = content.match(/^type:\s*(.+)$/m);

            if (idMatch) {
              const taskId = idMatch[1].trim();
              const status = statusMatch ? statusMatch[1].trim() : 'UNKNOWN';
              const type = typeMatch ? typeMatch[1].trim() : 'task';

              tasks.push({
                id: taskId,
                status,
                is_blocker: type === 'blocked' || status === 'BLOCKED',
              });
            }
          }
        }
      } catch {
        // Inbox doesn't exist or error reading - skip
      }

      // Scan outbox for DONE messages
      try {
        const outboxFiles = await fs.readdir(outboxPath);
        for (const file of outboxFiles.filter(f => f.endsWith('.md'))) {
          const content = await fs.readFile(path.join(outboxPath, file), 'utf-8');
          
          if (content.includes(epicId)) {
            const idMatch = content.match(/^id:\s*(.+)$/m);
            const typeMatch = content.match(/^type:\s*(.+)$/m);

            if (idMatch && typeMatch) {
              const taskId = idMatch[1].trim();
              const type = typeMatch[1].trim();

              if (type === 'done') {
                tasks.push({
                  id: taskId,
                  status: 'DONE',
                  is_blocker: false,
                });
              }
            }
          }
        }
      } catch {
        // Outbox doesn't exist or error reading - skip
      }
    }

    return tasks;
  } catch (error) {
    console.error('[EpicProgress] Error scanning terminal tasks:', error);
    return [];
  }
}

// ─── Progress Calculation ────────────────────────────────────────────────────

/**
 * Calculate days remaining until target date
 */
function calculateDaysRemaining(targetDate: string): number | null {
  try {
    const target = new Date(targetDate);
    const now = new Date();
    const diffMs = target.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return diffDays;
  } catch {
    return null;
  }
}

/**
 * Estimate completion date based on current velocity
 * Simple linear estimation: (tasks_remaining / tasks_done_rate) * days_elapsed
 */
function estimateCompletion(tasksDone: number, tasksTotal: number, targetDate: string, status: string): string | null {
  // If already done, return completed date
  if (status === 'done') {
    return targetDate; // Assume target date is completion date for done epics
  }

  // If no tasks done yet, can't estimate
  if (tasksDone === 0 || tasksTotal === 0) {
    return null;
  }

  // If all tasks done, return today
  if (tasksDone >= tasksTotal) {
    return new Date().toISOString().split('T')[0];
  }

  // Simple linear projection
  const progress = tasksDone / tasksTotal;
  const target = new Date(targetDate);
  const now = new Date();
  const daysElapsed = Math.max(1, Math.ceil((now.getTime() - (target.getTime() - (90 * 24 * 60 * 60 * 1000))) / (1000 * 60 * 60 * 24)));
  const daysPerTask = daysElapsed / tasksDone;
  const tasksRemaining = tasksTotal - tasksDone;
  const estimatedDaysRemaining = Math.ceil(tasksRemaining * daysPerTask);

  const estimatedDate = new Date(now.getTime() + (estimatedDaysRemaining * 24 * 60 * 60 * 1000));
  return estimatedDate.toISOString().split('T')[0];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get epic progress with real-time task aggregation
 *
 * @param epicId Epic ID (e.g., 'EPIC-CUTTING-Q3')
 * @returns Epic progress with completion estimate
 */
export async function getEpicProgress(epicId: string): Promise<EpicProgress | null> {
  try {
    // Load epic
    const epic = await findEpic(epicId);
    if (!epic) {
      console.warn(`[EpicProgress] Epic not found: ${epicId}`);
      return null;
    }

    // If epic is done and has final_progress, use that
    if (epic.status === 'done' && epic.final_progress !== undefined) {
      return {
        epic_id: epic.id,
        epic_name: epic.name,
        status: epic.status,
        progress_percent: epic.final_progress,
        tasks_done: epic.final_progress, // Use final_progress as proxy
        tasks_total: 100,
        blockers: [],
        estimated_completion: epic.completed_date || epic.target_date,
        target_date: epic.target_date,
        days_remaining: 0,
      };
    }

    // Scan for tasks
    const tasks = await scanTerminalTasks(epicId);

    // Calculate progress
    const tasksDone = tasks.filter(t => t.status === 'DONE' || t.status === 'PROCESSED' || t.status === 'READ').length;
    const tasksTotal = tasks.length || 1; // Avoid division by zero
    const progressPercent = Math.round((tasksDone / tasksTotal) * 100);

    // Find blockers
    const blockers = tasks
      .filter(t => t.is_blocker || t.status === 'BLOCKED')
      .map(t => t.id);

    // Calculate days remaining and estimate
    const daysRemaining = calculateDaysRemaining(epic.target_date);
    const estimatedCompletion = estimateCompletion(tasksDone, tasksTotal, epic.target_date, epic.status);

    return {
      epic_id: epic.id,
      epic_name: epic.name,
      status: epic.status,
      progress_percent: progressPercent,
      tasks_done: tasksDone,
      tasks_total: tasksTotal,
      blockers,
      estimated_completion: estimatedCompletion,
      target_date: epic.target_date,
      days_remaining: daysRemaining,
    };
  } catch (error) {
    console.error('[EpicProgress] Error calculating epic progress:', error);
    return null;
  }
}

/**
 * Get progress for all epics
 */
export async function getAllEpicsProgress(): Promise<EpicProgress[]> {
  const epics = await loadEpics();
  const results: EpicProgress[] = [];

  for (const epic of epics) {
    const progress = await getEpicProgress(epic.id);
    if (progress) {
      results.push(progress);
    }
  }

  return results;
}
