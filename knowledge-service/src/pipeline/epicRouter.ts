/**
 * Epic-Aware Task Router
 *
 * Intelligens task routing logika:
 * 1. Terminál csak akkor kap új taskot ha IDLE (várakozik)
 * 2. Az új task ugyanahhoz az epic-hez tartozik mint az előző
 * 3. Ha nincs ilyen, queue-ból az epic-en belüli következő
 * 4. Ha nincs ilyen sem → leállás (terminál idle marad)
 *
 * SQLite táblák:
 * - projects: Projektek nyilvántartása
 * - epics: Epic-ek projekt kapcsolattal
 * - terminal_context: Terminálonkénti aktuális kontextus (epic_id, project_id)
 * - task_queue: Epic-aware task várakozási sor
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { Terminal } from '../graph/types';
import { log } from './common';
import { emitOutboxEvent } from './eventBus';

// ─── Database Setup ─────────────────────────────────────────────────────────

import { DATA_DIR, getEpicsPath } from '../config/paths';
const DB_PATH = path.join(DATA_DIR, 'epic_router.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

/**
 * Accessor for the epic-router database so sibling domain modules (e.g. the
 * checkpoint store in src/projects/) can extend the SAME store additively —
 * one project/epic database, not a parallel source of truth.
 */
export function getEpicRouterDb(): Database.Database {
  return db;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

db.exec(`
  -- Projects table
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Epics table (linked to projects)
  CREATE TABLE IF NOT EXISTS epics (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'done', 'blocked')),
    priority INTEGER NOT NULL DEFAULT 2,
    depends_on TEXT,  -- JSON array of epic IDs
    target_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  -- Terminal context: tracks current epic/project for each terminal
  CREATE TABLE IF NOT EXISTS terminal_context (
    terminal TEXT PRIMARY KEY,
    current_epic_id TEXT,
    current_project_id TEXT,
    current_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'working', 'blocked')),
    last_task_completed_at TEXT,
    consecutive_epic_tasks INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (current_epic_id) REFERENCES epics(id),
    FOREIGN KEY (current_project_id) REFERENCES projects(id)
  );

  -- Task queue with epic awareness
  CREATE TABLE IF NOT EXISTS task_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE NOT NULL,
    terminal TEXT NOT NULL,
    epic_id TEXT,
    project_id TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    priority_order INTEGER NOT NULL DEFAULT 2,  -- 4=critical, 3=high, 2=medium, 1=low
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'dispatched', 'executing', 'completed', 'cancelled')),
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    dispatched_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (epic_id) REFERENCES epics(id),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  -- Indexes for efficient queries
  CREATE INDEX IF NOT EXISTS idx_epics_project ON epics(project_id);
  CREATE INDEX IF NOT EXISTS idx_epics_status ON epics(status);
  CREATE INDEX IF NOT EXISTS idx_queue_terminal ON task_queue(terminal, status);
  CREATE INDEX IF NOT EXISTS idx_queue_epic ON task_queue(epic_id, status);
  CREATE INDEX IF NOT EXISTS idx_queue_priority ON task_queue(priority_order DESC, queued_at ASC);
  CREATE INDEX IF NOT EXISTS idx_context_epic ON terminal_context(current_epic_id);
`);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface Epic {
  id: string;
  project_id: string;
  name: string;
  description?: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  priority: number;
  depends_on?: string[];
  target_date?: string;
  created_at: string;
  updated_at: string;
}

export interface TerminalContext {
  terminal: string;
  current_epic_id?: string;
  current_project_id?: string;
  current_task_id?: string;
  status: 'idle' | 'working' | 'blocked';
  last_task_completed_at?: string;
  consecutive_epic_tasks: number;
  updated_at: string;
}

export interface QueuedTask {
  id: number;
  message_id: string;
  terminal: string;
  epic_id?: string;
  project_id?: string;
  priority: number;
  priority_order: number;
  status: 'queued' | 'dispatched' | 'executing' | 'completed' | 'cancelled';
  queued_at: string;
  dispatched_at?: string;
  completed_at?: string;
}

export interface RoutingDecision {
  shouldDispatch: boolean;
  task?: QueuedTask;
  reason: string;
  nextAction: 'dispatch' | 'wait' | 'stop';
}

// ─── Project Management ─────────────────────────────────────────────────────

const insertProject = db.prepare(`
  INSERT INTO projects (id, name, description, status)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    status = excluded.status,
    updated_at = datetime('now')
`);

const getProject = db.prepare(`SELECT * FROM projects WHERE id = ?`);
const getAllProjects = db.prepare(`SELECT * FROM projects WHERE status = 'active' ORDER BY name`);

export function createProject(project: Omit<Project, 'created_at' | 'updated_at'>): Project {
  insertProject.run(project.id, project.name, project.description || null, project.status);
  return getProject.get(project.id) as Project;
}

export function getProjectById(id: string): Project | undefined {
  return getProject.get(id) as Project | undefined;
}

export function listActiveProjects(): Project[] {
  return getAllProjects.all() as Project[];
}

// ─── Epic Management ────────────────────────────────────────────────────────

const insertEpic = db.prepare(`
  INSERT INTO epics (id, project_id, name, description, status, priority, depends_on, target_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    status = excluded.status,
    priority = excluded.priority,
    depends_on = excluded.depends_on,
    target_date = excluded.target_date,
    updated_at = datetime('now')
`);

const getEpic = db.prepare(`SELECT * FROM epics WHERE id = ?`);
const getEpicsByProject = db.prepare(`SELECT * FROM epics WHERE project_id = ? ORDER BY priority DESC`);
const getActiveEpics = db.prepare(`SELECT * FROM epics WHERE status IN ('pending', 'active') ORDER BY priority DESC`);
const updateEpicStatus = db.prepare(`UPDATE epics SET status = ?, updated_at = datetime('now') WHERE id = ?`);

export function createEpic(epic: Omit<Epic, 'created_at' | 'updated_at'>): Epic {
  const dependsOnJson = epic.depends_on ? JSON.stringify(epic.depends_on) : null;
  insertEpic.run(
    epic.id,
    epic.project_id,
    epic.name,
    epic.description || null,
    epic.status,
    epic.priority,
    dependsOnJson,
    epic.target_date || null
  );
  return getEpicById(epic.id)!;
}

export function getEpicById(id: string): Epic | undefined {
  const row = getEpic.get(id) as any;
  if (!row) return undefined;
  return {
    ...row,
    depends_on: row.depends_on ? JSON.parse(row.depends_on) : undefined,
  };
}

export function getEpicsForProject(projectId: string): Epic[] {
  const rows = getEpicsByProject.all(projectId) as any[];
  return rows.map(row => ({
    ...row,
    depends_on: row.depends_on ? JSON.parse(row.depends_on) : undefined,
  }));
}

export function listActiveEpics(): Epic[] {
  const rows = getActiveEpics.all() as any[];
  return rows.map(row => ({
    ...row,
    depends_on: row.depends_on ? JSON.parse(row.depends_on) : undefined,
  }));
}

export function setEpicStatus(epicId: string, status: Epic['status']): void {
  updateEpicStatus.run(status, epicId);
}

// ─── Terminal Context ───────────────────────────────────────────────────────

const upsertContext = db.prepare(`
  INSERT INTO terminal_context (terminal, current_epic_id, current_project_id, current_task_id, status, consecutive_epic_tasks)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(terminal) DO UPDATE SET
    current_epic_id = excluded.current_epic_id,
    current_project_id = excluded.current_project_id,
    current_task_id = excluded.current_task_id,
    status = excluded.status,
    consecutive_epic_tasks = excluded.consecutive_epic_tasks,
    updated_at = datetime('now')
`);

const getContext = db.prepare(`SELECT * FROM terminal_context WHERE terminal = ?`);
const setContextStatus = db.prepare(`UPDATE terminal_context SET status = ?, updated_at = datetime('now') WHERE terminal = ?`);
const setContextTaskCompleted = db.prepare(`
  UPDATE terminal_context
  SET status = 'idle',
      last_task_completed_at = datetime('now'),
      current_task_id = NULL,
      updated_at = datetime('now')
  WHERE terminal = ?
`);

export function getTerminalContext(terminal: string): TerminalContext | undefined {
  return getContext.get(terminal) as TerminalContext | undefined;
}

export function setTerminalContext(
  terminal: string,
  epicId: string | null,
  projectId: string | null,
  taskId: string | null,
  status: TerminalContext['status'] = 'idle',
  consecutiveTasks: number = 0
): void {
  upsertContext.run(terminal, epicId, projectId, taskId, status, consecutiveTasks);
}

export function markTerminalWorking(terminal: string, taskId: string): void {
  const ctx = getTerminalContext(terminal);
  if (ctx) {
    setTerminalContext(
      terminal,
      ctx.current_epic_id || null,
      ctx.current_project_id || null,
      taskId,
      'working',
      ctx.consecutive_epic_tasks
    );
  }
}

export function markTerminalIdle(terminal: string): void {
  setContextTaskCompleted.run(terminal);
}

export function markTerminalBlocked(terminal: string): void {
  setContextStatus.run('blocked', terminal);
}

// ─── Task Queue ─────────────────────────────────────────────────────────────

const enqueue = db.prepare(`
  INSERT INTO task_queue (message_id, terminal, epic_id, project_id, priority, priority_order, status)
  VALUES (?, ?, ?, ?, ?, ?, 'queued')
`);

const dequeue = db.prepare(`
  UPDATE task_queue
  SET status = 'dispatched', dispatched_at = datetime('now')
  WHERE id = ?
`);

const completeTask = db.prepare(`
  UPDATE task_queue
  SET status = 'completed', completed_at = datetime('now')
  WHERE message_id = ?
`);

const cancelTask = db.prepare(`
  UPDATE task_queue
  SET status = 'cancelled'
  WHERE message_id = ?
`);

// Get next task for terminal - same epic first, then any from queue
const getNextTaskSameEpic = db.prepare(`
  SELECT * FROM task_queue
  WHERE terminal = ?
    AND epic_id = ?
    AND status = 'queued'
  ORDER BY priority_order DESC, queued_at ASC
  LIMIT 1
`);

const getNextTaskAnyEpic = db.prepare(`
  SELECT * FROM task_queue
  WHERE terminal = ?
    AND status = 'queued'
  ORDER BY priority_order DESC, queued_at ASC
  LIMIT 1
`);

const getQueuedTasksForTerminal = db.prepare(`
  SELECT * FROM task_queue
  WHERE terminal = ? AND status = 'queued'
  ORDER BY priority_order DESC, queued_at ASC
`);

const getQueuedTasksByEpic = db.prepare(`
  SELECT * FROM task_queue
  WHERE epic_id = ? AND status = 'queued'
  ORDER BY priority_order DESC, queued_at ASC
`);

export function queueTask(
  messageId: string,
  terminal: string,
  epicId: string | null,
  projectId: string | null,
  priority: 'critical' | 'high' | 'medium' | 'low' = 'medium'
): void {
  const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 }[priority];
  enqueue.run(messageId, terminal, epicId, projectId, priorityOrder, priorityOrder);
  log(`[EpicRouter] Queued task ${messageId} for ${terminal} (epic: ${epicId || 'none'})`);
}

export function markTaskDispatched(taskId: number): void {
  dequeue.run(taskId);
}

export function markTaskCompleted(messageId: string): void {
  completeTask.run(messageId);
}

export function cancelQueuedTask(messageId: string): void {
  cancelTask.run(messageId);
}

export function getQueueForTerminal(terminal: string): QueuedTask[] {
  return getQueuedTasksForTerminal.all(terminal) as QueuedTask[];
}

export function getQueueForEpic(epicId: string): QueuedTask[] {
  return getQueuedTasksByEpic.all(epicId) as QueuedTask[];
}

// ─── Epic-Aware Routing Logic ───────────────────────────────────────────────

/**
 * Decide what to do next for a terminal
 *
 * Logic:
 * 1. If terminal is not IDLE → wait
 * 2. If same-epic task in queue → dispatch it
 * 3. If no same-epic task but other tasks → check if should switch epics
 * 4. If no tasks → stop (terminal stays idle)
 */
export function getNextTaskForTerminal(terminal: string): RoutingDecision {
  const ctx = getTerminalContext(terminal);

  // 1. Terminal must be idle
  if (ctx && ctx.status !== 'idle') {
    return {
      shouldDispatch: false,
      reason: `Terminal ${terminal} is ${ctx.status}, not idle`,
      nextAction: 'wait',
    };
  }

  const currentEpicId = ctx?.current_epic_id;

  // 2. Try same-epic task first
  if (currentEpicId) {
    const sameEpicTask = getNextTaskSameEpic.get(terminal, currentEpicId) as QueuedTask | undefined;
    if (sameEpicTask) {
      return {
        shouldDispatch: true,
        task: sameEpicTask,
        reason: `Found task in same epic (${currentEpicId})`,
        nextAction: 'dispatch',
      };
    }
  }

  // 3. Check for any task in queue
  const anyTask = getNextTaskAnyEpic.get(terminal) as QueuedTask | undefined;

  if (anyTask) {
    // Switch epic if needed
    if (anyTask.epic_id && anyTask.epic_id !== currentEpicId) {
      log(`[EpicRouter] Terminal ${terminal} switching from epic ${currentEpicId || 'none'} to ${anyTask.epic_id}`);
      // Reset consecutive counter when switching epics
      setTerminalContext(terminal, anyTask.epic_id, anyTask.project_id || null, null, 'idle', 0);
    }

    return {
      shouldDispatch: true,
      task: anyTask,
      reason: anyTask.epic_id === currentEpicId
        ? `Found task in same epic (${currentEpicId})`
        : `Switching to new epic (${anyTask.epic_id || 'no epic'})`,
      nextAction: 'dispatch',
    };
  }

  // 4. No tasks available
  return {
    shouldDispatch: false,
    reason: `No queued tasks for ${terminal}`,
    nextAction: 'stop',
  };
}

/**
 * Process task completion and decide next action
 *
 * ADR-053: This is the AUTHORITATIVE source of task completion.
 * - Emits outbox:done event for subscription triggers
 * - Updates checkpoint status in EPICS.yaml if applicable
 * - File-based detection (inboxWatcher) is secondary/backup
 */
export function handleTaskCompletion(
  terminal: string,
  messageId: string,
  epicId: string | null
): RoutingDecision {
  // Mark task as completed
  markTaskCompleted(messageId);

  // Update terminal context
  const ctx = getTerminalContext(terminal);
  const consecutiveTasks = (ctx?.consecutive_epic_tasks || 0) + 1;

  // Update context - keep epic but mark idle
  setTerminalContext(
    terminal,
    epicId,
    ctx?.current_project_id || null,
    null, // clear current task
    'idle',
    epicId === ctx?.current_epic_id ? consecutiveTasks : 1
  );

  log(`[EpicRouter] Terminal ${terminal} completed task ${messageId} (epic: ${epicId || 'none'}, consecutive: ${consecutiveTasks})`);

  // ADR-053: Emit outbox:done event for subscription triggers
  // This is the DB-authoritative event, not file-based
  emitOutboxEvent('outbox:done', terminal, messageId, {
    epicId: epicId || undefined,
    source: 'mcp_complete_task',  // Mark as MCP-originated (not file-watcher)
    completedAt: new Date().toISOString(),
  });
  log(`[EpicRouter] Emitted outbox:done for ${messageId} (MCP-authoritative)`);

  // ADR-053: Update checkpoint status in EPICS.yaml if this task triggers one
  if (epicId) {
    updateCheckpointStatus(epicId, messageId);
  }

  // Get next task decision
  return getNextTaskForTerminal(terminal);
}

/**
 * ADR-053: Update checkpoint status in EPICS.yaml
 * Checks if the completed messageId matches any checkpoint condition
 */
function updateCheckpointStatus(epicId: string, messageId: string): void {
  const epicsPath = getEpicsPath();

  try {
    const content = fs.readFileSync(epicsPath, 'utf-8');

    // Check if this messageId is referenced in any checkpoint condition
    // Format: condition: "MSG-FRONTEND-084 status=DONE"
    const conditionPattern = new RegExp(`condition:\\s*["']${messageId}\\s+status=DONE["']`);

    if (!conditionPattern.test(content)) {
      return; // No checkpoint matches this messageId
    }

    log(`[EpicRouter] Checkpoint found for ${messageId} in ${epicId}`);

    // Find the checkpoint and update its status to done
    // We need to find the checkpoint block and change status: pending to status: done
    const lines = content.split('\n');
    const updatedLines: string[] = [];
    let inTargetCheckpoint = false;
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this line contains the condition for our messageId
      if (line.includes(`condition:`) && line.includes(messageId) && line.includes('status=DONE')) {
        inTargetCheckpoint = true;
      }

      // If we're in the target checkpoint block and find status: pending, update it
      if (inTargetCheckpoint && line.includes('status:') && line.includes('pending')) {
        updatedLines.push(line.replace('pending', 'done'));
        inTargetCheckpoint = false;
        updated = true;
        log(`[EpicRouter] Updated checkpoint status to done for ${messageId}`);
      } else {
        updatedLines.push(line);
      }

      // Reset if we hit a new checkpoint (- id:)
      if (inTargetCheckpoint && line.trim().startsWith('- id:') && !line.includes(messageId)) {
        inTargetCheckpoint = false;
      }
    }

    if (updated) {
      fs.writeFileSync(epicsPath, updatedLines.join('\n'), 'utf-8');
      log(`[EpicRouter] EPICS.yaml checkpoint updated for ${messageId}`);
    }
  } catch (error) {
    log(`[EpicRouter] Error updating checkpoint: ${error}`);
  }
}

/**
 * Dispatch a task to terminal
 */
export function dispatchTask(terminal: string, task: QueuedTask): void {
  // Mark task as dispatched
  markTaskDispatched(task.id);

  // Update terminal context
  setTerminalContext(
    terminal,
    task.epic_id || null,
    task.project_id || null,
    task.message_id,
    'working',
    0 // will increment on completion
  );

  log(`[EpicRouter] Dispatched task ${task.message_id} to ${terminal} (epic: ${task.epic_id || 'none'})`);
}

// ─── Statistics ─────────────────────────────────────────────────────────────

const getQueueStats = db.prepare(`
  SELECT
    terminal,
    epic_id,
    COUNT(*) as count,
    MIN(queued_at) as oldest
  FROM task_queue
  WHERE status = 'queued'
  GROUP BY terminal, epic_id
  ORDER BY terminal, count DESC
`);

const getTerminalStats = db.prepare(`
  SELECT
    tc.*,
    e.name as epic_name,
    p.name as project_name,
    (SELECT COUNT(*) FROM task_queue WHERE terminal = tc.terminal AND status = 'queued') as queue_size
  FROM terminal_context tc
  LEFT JOIN epics e ON tc.current_epic_id = e.id
  LEFT JOIN projects p ON tc.current_project_id = p.id
`);

export interface QueueStatsRow {
  terminal: string;
  epic_id: string | null;
  count: number;
  oldest: string;
}

export interface TerminalStatsRow extends TerminalContext {
  epic_name?: string;
  project_name?: string;
  queue_size: number;
}

export function getQueueStatistics(): QueueStatsRow[] {
  return getQueueStats.all() as QueueStatsRow[];
}

export function getTerminalStatistics(): TerminalStatsRow[] {
  return getTerminalStats.all() as TerminalStatsRow[];
}

// ─── Sync from EPICS.yaml ───────────────────────────────────────────────────

import * as yaml from 'js-yaml';

export async function syncFromEpicsYaml(epicsYamlPath: string): Promise<{ projects: number; epics: number }> {
  const content = await fs.promises.readFile(epicsYamlPath, 'utf-8');
  const data = yaml.load(content) as any;

  if (!data || !data.epics) {
    return { projects: 0, epics: 0 };
  }

  const projectIds = new Set<string>();
  let epicCount = 0;

  for (const epicDef of data.epics) {
    // Extract project from epic definition
    const projectId = epicDef.project || 'default';
    const projectName = projectId.replace('spaceos/', '').replace('/', ' - ');

    // Create/update project
    if (!projectIds.has(projectId)) {
      createProject({
        id: projectId,
        name: projectName,
        status: 'active',
      });
      projectIds.add(projectId);
    }

    // Create/update epic
    createEpic({
      id: epicDef.id,
      project_id: projectId,
      name: epicDef.name,
      description: epicDef.description,
      status: epicDef.status || 'pending',
      priority: epicDef.priority || 2,
      depends_on: epicDef.depends_on,
      target_date: epicDef.target_date,
    });
    epicCount++;
  }

  log(`[EpicRouter] Synced ${projectIds.size} projects, ${epicCount} epics from EPICS.yaml`);
  return { projects: projectIds.size, epics: epicCount };
}

// ─── Export Database for Testing ────────────────────────────────────────────

export function getDatabase(): Database.Database {
  return db;
}

export function closeDatabase(): void {
  db.close();
}

// ─── Initialize Default Terminals ───────────────────────────────────────────

const TERMINALS: Terminal[] = ['root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer', 'monitor'];

export function initializeTerminals(): void {
  for (const terminal of TERMINALS) {
    const ctx = getTerminalContext(terminal);
    if (!ctx) {
      setTerminalContext(terminal, null, null, null, 'idle', 0);
    }
  }
  log(`[EpicRouter] Initialized ${TERMINALS.length} terminals`);
}

// Auto-initialize on module load
initializeTerminals();
