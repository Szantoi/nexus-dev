/**
 * Workflow Database - SQLite-based workflow state management
 *
 * Tables:
 * - workflows: Workflow definitions cache
 * - workflow_states: Current state per workflow
 * - workflow_history: Step transition history
 * - workflow_tasks: Generated tasks tracking
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './core/logger';
import { DATA_DIR } from './config/paths';

const DB_PATH = process.env.WORKFLOW_DB || path.join(DATA_DIR, 'workflow.db');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  -- Workflow definitions (cached from YAML)
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    focus TEXT,
    priority TEXT DEFAULT 'medium',
    enabled INTEGER DEFAULT 1,
    yaml_path TEXT,
    steps_json TEXT,
    metadata_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Current workflow state
  CREATE TABLE IF NOT EXISTS workflow_states (
    workflow_id TEXT PRIMARY KEY,
    current_step TEXT NOT NULL,
    previous_step TEXT,
    status TEXT DEFAULT 'active',
    started_at TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)
  );

  -- Step transition history
  CREATE TABLE IF NOT EXISTS workflow_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    status TEXT DEFAULT 'active',
    terminal TEXT,
    island TEXT,
    task_file TEXT,
    notes TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)
  );

  -- Generated tasks tracking
  CREATE TABLE IF NOT EXISTS workflow_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    task_file TEXT NOT NULL,
    terminal TEXT NOT NULL,
    island TEXT NOT NULL,
    model TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)
  );

  -- Epics table
  CREATE TABLE IF NOT EXISTS epics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    priority TEXT DEFAULT 'medium',
    assignee TEXT,
    target_date TEXT,
    depends_on_json TEXT,
    parallel_with_json TEXT,
    tasks_json TEXT,
    island TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Epic tasks (sub-tasks within an epic)
  CREATE TABLE IF NOT EXISTS epic_tasks (
    id TEXT PRIMARY KEY,
    epic_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    assignee TEXT,
    terminal TEXT,
    island TEXT,
    priority TEXT DEFAULT 'medium',
    depends_on_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (epic_id) REFERENCES epics(id)
  );

  -- Epic history (status changes)
  CREATE TABLE IF NOT EXISTS epic_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (epic_id) REFERENCES epics(id)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_history_workflow ON workflow_history(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_history_step ON workflow_history(step_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON workflow_tasks(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON workflow_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_epics_status ON epics(status);
  CREATE INDEX IF NOT EXISTS idx_epic_tasks_epic ON epic_tasks(epic_id);
  CREATE INDEX IF NOT EXISTS idx_epic_tasks_status ON epic_tasks(status);
`);

// Prepared statements
const stmts = {
  // Workflows
  upsertWorkflow: db.prepare(`
    INSERT INTO workflows (id, name, description, focus, priority, enabled, yaml_path, steps_json, metadata_json, updated_at)
    VALUES (@id, @name, @description, @focus, @priority, @enabled, @yaml_path, @steps_json, @metadata_json, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = @name,
      description = @description,
      focus = @focus,
      priority = @priority,
      enabled = @enabled,
      yaml_path = @yaml_path,
      steps_json = @steps_json,
      metadata_json = @metadata_json,
      updated_at = datetime('now')
  `),

  getWorkflow: db.prepare(`SELECT * FROM workflows WHERE id = ?`),
  getAllWorkflows: db.prepare(`SELECT * FROM workflows WHERE enabled = 1`),
  getWorkflowCount: db.prepare(`SELECT COUNT(*) as count FROM workflows`),

  // States
  upsertState: db.prepare(`
    INSERT INTO workflow_states (workflow_id, current_step, previous_step, status, started_at, updated_at)
    VALUES (@workflow_id, @current_step, @previous_step, @status, @started_at, datetime('now'))
    ON CONFLICT(workflow_id) DO UPDATE SET
      previous_step = workflow_states.current_step,
      current_step = @current_step,
      status = @status,
      updated_at = datetime('now')
  `),

  getState: db.prepare(`SELECT * FROM workflow_states WHERE workflow_id = ?`),
  getAllStates: db.prepare(`SELECT * FROM workflow_states`),

  // History
  insertHistory: db.prepare(`
    INSERT INTO workflow_history (workflow_id, step_id, terminal, island, task_file, notes)
    VALUES (@workflow_id, @step_id, @terminal, @island, @task_file, @notes)
  `),

  completeHistory: db.prepare(`
    UPDATE workflow_history
    SET completed_at = datetime('now'), status = 'done'
    WHERE workflow_id = ? AND step_id = ? AND completed_at IS NULL
  `),

  getHistory: db.prepare(`
    SELECT * FROM workflow_history
    WHERE workflow_id = ?
    ORDER BY started_at DESC
    LIMIT 50
  `),

  // Tasks
  insertTask: db.prepare(`
    INSERT INTO workflow_tasks (workflow_id, step_id, task_file, terminal, island, model, status)
    VALUES (@workflow_id, @step_id, @task_file, @terminal, @island, @model, 'pending')
  `),

  completeTask: db.prepare(`
    UPDATE workflow_tasks
    SET status = 'done', completed_at = datetime('now')
    WHERE task_file = ?
  `),

  getPendingTasks: db.prepare(`
    SELECT * FROM workflow_tasks
    WHERE status = 'pending'
    ORDER BY created_at DESC
  `),

  getTasksByWorkflow: db.prepare(`
    SELECT * FROM workflow_tasks
    WHERE workflow_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `),

  // Epics
  upsertEpic: db.prepare(`
    INSERT INTO epics (id, name, description, status, priority, assignee, target_date, depends_on_json, parallel_with_json, tasks_json, island, updated_at)
    VALUES (@id, @name, @description, @status, @priority, @assignee, @target_date, @depends_on_json, @parallel_with_json, @tasks_json, @island, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = @name,
      description = @description,
      status = @status,
      priority = @priority,
      assignee = @assignee,
      target_date = @target_date,
      depends_on_json = @depends_on_json,
      parallel_with_json = @parallel_with_json,
      tasks_json = @tasks_json,
      island = @island,
      updated_at = datetime('now')
  `),

  getEpic: db.prepare(`SELECT * FROM epics WHERE id = ?`),
  getAllEpics: db.prepare(`SELECT * FROM epics ORDER BY priority, created_at`),
  getEpicsByStatus: db.prepare(`SELECT * FROM epics WHERE status = ? ORDER BY priority, created_at`),
  deleteEpic: db.prepare(`DELETE FROM epics WHERE id = ?`),

  // Epic tasks
  upsertEpicTask: db.prepare(`
    INSERT INTO epic_tasks (id, epic_id, name, description, status, assignee, terminal, island, priority, depends_on_json, updated_at)
    VALUES (@id, @epic_id, @name, @description, @status, @assignee, @terminal, @island, @priority, @depends_on_json, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = @name,
      description = @description,
      status = @status,
      assignee = @assignee,
      terminal = @terminal,
      island = @island,
      priority = @priority,
      depends_on_json = @depends_on_json,
      updated_at = datetime('now'),
      completed_at = CASE WHEN @status = 'done' THEN datetime('now') ELSE completed_at END
  `),

  getEpicTasks: db.prepare(`SELECT * FROM epic_tasks WHERE epic_id = ? ORDER BY priority, created_at`),
  getEpicTasksByStatus: db.prepare(`SELECT * FROM epic_tasks WHERE epic_id = ? AND status = ?`),

  // Epic history
  insertEpicHistory: db.prepare(`
    INSERT INTO epic_history (epic_id, old_status, new_status, changed_by, notes)
    VALUES (@epic_id, @old_status, @new_status, @changed_by, @notes)
  `),

  getEpicHistory: db.prepare(`SELECT * FROM epic_history WHERE epic_id = ? ORDER BY created_at DESC LIMIT 20`),
};

// Export functions
export interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  focus?: string;
  priority?: string;
  enabled: number;
  yaml_path?: string;
  steps_json?: string;
  metadata_json?: string;
  created_at?: string;
  updated_at?: string;
}

export interface WorkflowStateRecord {
  workflow_id: string;
  current_step: string;
  previous_step?: string;
  status: string;
  started_at?: string;
  updated_at?: string;
}

export interface WorkflowHistoryRecord {
  id: number;
  workflow_id: string;
  step_id: string;
  started_at: string;
  completed_at?: string;
  status: string;
  terminal?: string;
  island?: string;
  task_file?: string;
  notes?: string;
}

export interface WorkflowTaskRecord {
  id: number;
  workflow_id: string;
  step_id: string;
  task_file: string;
  terminal: string;
  island: string;
  model?: string;
  status: string;
  created_at: string;
  completed_at?: string;
}

// Workflow CRUD
export function saveWorkflow(workflow: {
  id: string;
  name: string;
  description?: string;
  focus?: string;
  priority?: string;
  enabled?: boolean;
  yaml_path?: string;
  steps?: unknown[];
  metadata?: unknown;
}): void {
  stmts.upsertWorkflow.run({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description || null,
    focus: workflow.focus || null,
    priority: workflow.priority || 'medium',
    enabled: workflow.enabled !== false ? 1 : 0,
    yaml_path: workflow.yaml_path || null,
    steps_json: workflow.steps ? JSON.stringify(workflow.steps) : null,
    metadata_json: workflow.metadata ? JSON.stringify(workflow.metadata) : null,
  });
}

export function getWorkflowFromDb(id: string): WorkflowRecord | null {
  return stmts.getWorkflow.get(id) as WorkflowRecord | null;
}

export function getAllWorkflowsFromDb(): WorkflowRecord[] {
  return stmts.getAllWorkflows.all() as WorkflowRecord[];
}

// State management
export function saveState(
  workflowId: string,
  currentStep: string,
  previousStep?: string,
  status: string = 'active'
): void {
  stmts.upsertState.run({
    workflow_id: workflowId,
    current_step: currentStep,
    previous_step: previousStep || null,
    status,
    started_at: new Date().toISOString(),
  });
}

export function getStateFromDb(workflowId: string): WorkflowStateRecord | null {
  return stmts.getState.get(workflowId) as WorkflowStateRecord | null;
}

export function getAllStatesFromDb(): WorkflowStateRecord[] {
  return stmts.getAllStates.all() as WorkflowStateRecord[];
}

// History
export function addHistory(entry: {
  workflow_id: string;
  step_id: string;
  terminal?: string;
  island?: string;
  task_file?: string;
  notes?: string;
}): void {
  stmts.insertHistory.run(entry);
}

export function completeHistoryStep(workflowId: string, stepId: string): void {
  stmts.completeHistory.run(workflowId, stepId);
}

export function getHistoryFromDb(workflowId: string): WorkflowHistoryRecord[] {
  return stmts.getHistory.all(workflowId) as WorkflowHistoryRecord[];
}

// Tasks
export function trackTask(task: {
  workflow_id: string;
  step_id: string;
  task_file: string;
  terminal: string;
  island: string;
  model?: string;
}): void {
  stmts.insertTask.run(task);
}

export function markTaskDone(taskFile: string): void {
  stmts.completeTask.run(taskFile);
}

export function getPendingTasksFromDb(): WorkflowTaskRecord[] {
  return stmts.getPendingTasks.all() as WorkflowTaskRecord[];
}

export function getTasksForWorkflow(workflowId: string): WorkflowTaskRecord[] {
  return stmts.getTasksByWorkflow.all(workflowId) as WorkflowTaskRecord[];
}

// Aggregate queries
export function getWorkflowStats(): {
  total_workflows: number;
  active_workflows: number;
  pending_tasks: number;
  completed_today: number;
} {
  const total = (stmts.getWorkflowCount.get() as { count: number }).count;
  const active = db.prepare(`SELECT COUNT(*) as count FROM workflow_states WHERE status = 'active'`).get() as { count: number };
  const pending = db.prepare(`SELECT COUNT(*) as count FROM workflow_tasks WHERE status = 'pending'`).get() as { count: number };
  const today = db.prepare(`
    SELECT COUNT(*) as count FROM workflow_tasks
    WHERE status = 'done' AND date(completed_at) = date('now')
  `).get() as { count: number };

  return {
    total_workflows: total,
    active_workflows: active.count,
    pending_tasks: pending.count,
    completed_today: today.count,
  };
}

// Sync YAML to DB
export function syncWorkflowFromYaml(yamlPath: string, workflow: {
  id: string;
  name: string;
  description?: string;
  focus?: string;
  priority?: string;
  enabled?: boolean;
  steps?: unknown[];
  metadata?: unknown;
}): void {
  saveWorkflow({
    ...workflow,
    yaml_path: yamlPath,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EPIC MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

export interface EpicRecord {
  id: string;
  name: string;
  description?: string;
  status: string;
  priority?: string;
  assignee?: string;
  target_date?: string;
  depends_on_json?: string;
  parallel_with_json?: string;
  tasks_json?: string;
  island?: string;
  created_at?: string;
  updated_at?: string;
}

export interface EpicTaskRecord {
  id: string;
  epic_id: string;
  name: string;
  description?: string;
  status: string;
  assignee?: string;
  terminal?: string;
  island?: string;
  priority?: string;
  depends_on_json?: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
}

export interface EpicHistoryRecord {
  id: number;
  epic_id: string;
  old_status?: string;
  new_status: string;
  changed_by?: string;
  notes?: string;
  created_at?: string;
}

// Epic CRUD
export function saveEpic(epic: {
  id: string;
  name: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  target_date?: string;
  depends_on?: string[];
  parallel_with?: string[];
  tasks?: string[];
  island?: string;
}): void {
  stmts.upsertEpic.run({
    id: epic.id,
    name: epic.name,
    description: epic.description || null,
    status: epic.status || 'pending',
    priority: epic.priority || 'medium',
    assignee: epic.assignee || null,
    target_date: epic.target_date || null,
    depends_on_json: epic.depends_on ? JSON.stringify(epic.depends_on) : null,
    parallel_with_json: epic.parallel_with ? JSON.stringify(epic.parallel_with) : null,
    tasks_json: epic.tasks ? JSON.stringify(epic.tasks) : null,
    island: epic.island || null,
  });
}

export function getEpicFromDb(id: string): EpicRecord | null {
  return stmts.getEpic.get(id) as EpicRecord | null;
}

export function getAllEpicsFromDb(): EpicRecord[] {
  return stmts.getAllEpics.all() as EpicRecord[];
}

export function getEpicsByStatusFromDb(status: string): EpicRecord[] {
  return stmts.getEpicsByStatus.all(status) as EpicRecord[];
}

export function deleteEpicFromDb(id: string): void {
  stmts.deleteEpic.run(id);
}

export function updateEpicStatusInDb(
  epicId: string,
  newStatus: string,
  changedBy?: string,
  notes?: string
): boolean {
  const epic = getEpicFromDb(epicId);
  if (!epic) return false;

  const oldStatus = epic.status;

  // Update epic
  saveEpic({
    ...epic,
    status: newStatus,
    depends_on: epic.depends_on_json ? JSON.parse(epic.depends_on_json) : undefined,
    parallel_with: epic.parallel_with_json ? JSON.parse(epic.parallel_with_json) : undefined,
    tasks: epic.tasks_json ? JSON.parse(epic.tasks_json) : undefined,
  });

  // Add history
  stmts.insertEpicHistory.run({
    epic_id: epicId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: changedBy || null,
    notes: notes || null,
  });

  return true;
}

// Epic tasks
export function saveEpicTask(task: {
  id: string;
  epic_id: string;
  name: string;
  description?: string;
  status?: string;
  assignee?: string;
  terminal?: string;
  island?: string;
  priority?: string;
  depends_on?: string[];
}): void {
  stmts.upsertEpicTask.run({
    id: task.id,
    epic_id: task.epic_id,
    name: task.name,
    description: task.description || null,
    status: task.status || 'pending',
    assignee: task.assignee || null,
    terminal: task.terminal || null,
    island: task.island || null,
    priority: task.priority || 'medium',
    depends_on_json: task.depends_on ? JSON.stringify(task.depends_on) : null,
  });
}

export function getEpicTasksFromDb(epicId: string): EpicTaskRecord[] {
  return stmts.getEpicTasks.all(epicId) as EpicTaskRecord[];
}

export function getEpicHistoryFromDb(epicId: string): EpicHistoryRecord[] {
  return stmts.getEpicHistory.all(epicId) as EpicHistoryRecord[];
}

// Import from YAML
export function importEpicsFromYaml(yamlContent: { epics: Array<{
  id: string;
  name: string;
  description?: string;
  status?: string;
  priority?: string;
  depends_on?: string[];
  parallel_with?: string[];
  target_date?: string;
  assignee?: string;
  tasks?: string[];
}> }): number {
  let imported = 0;
  for (const epic of yamlContent.epics || []) {
    saveEpic(epic);
    imported++;
  }
  return imported;
}

// Stats
export function getEpicStats(): {
  total: number;
  by_status: Record<string, number>;
  blocked: number;
  active: number;
} {
  const all = getAllEpicsFromDb();
  const byStatus: Record<string, number> = {};

  for (const epic of all) {
    byStatus[epic.status] = (byStatus[epic.status] || 0) + 1;
  }

  return {
    total: all.length,
    by_status: byStatus,
    blocked: byStatus['blocked'] || 0,
    active: byStatus['active'] || 0,
  };
}

// Export database for advanced queries
export function getDb(): Database.Database {
  return db;
}

logger.info('[WorkflowDB] Initialized:', DB_PATH);
