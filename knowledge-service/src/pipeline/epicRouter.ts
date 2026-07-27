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
import { updateCheckpointStatus } from './checkpointStatusUpdater';
import {
  LegacyCompletionRefusedError,
  ScopedClaimMutationRefusedError,
  TerminalContextStore,
  type TerminalClaimResult,
  type TerminalContext,
} from './terminalContextStore';
export { LegacyCompletionRefusedError, ScopedClaimMutationRefusedError };
export type { TerminalClaimResult, TerminalContext };
import {
  CompletionReceiptStore,
  type CompletionReceiptPage,
  type CompletionReceiptSource,
  type RunnerCompletionReceipt,
} from './completionReceiptStore';
import { ValidationError, InvalidStateError } from '../core/errors';

// ─── Database Setup ─────────────────────────────────────────────────────────

import { DATA_DIR } from '../config/paths';
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
    current_island_id TEXT,
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

// Additive migration for databases created before durable runner claims bound
// the active task to the token-derived island. Existing active contexts remain
// NULL and therefore cannot use the canonical completion path until reclaimed.
const terminalContextColumns = db.prepare('PRAGMA table_info(terminal_context)').all() as Array<{
  name: string;
}>;
if (!terminalContextColumns.some((column) => column.name === 'current_island_id')) {
  db.exec('ALTER TABLE terminal_context ADD COLUMN current_island_id TEXT');
}

const completionReceiptStore = new CompletionReceiptStore(db);

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

export interface CompletionReceiptContext {
  islandId: string;
  source: CompletionReceiptSource;
}

export function getRunnerCompletionReceipt(
  islandId: string,
  terminalId: string,
  messageId: string,
): RunnerCompletionReceipt | undefined {
  return completionReceiptStore.get(islandId, terminalId, messageId);
}

export function listRunnerCompletionReceipts(
  islandId: string,
  terminalId: string,
  after: number,
  limit?: number,
): CompletionReceiptPage {
  return completionReceiptStore.list(islandId, terminalId, after, limit);
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

const terminalContextStore = new TerminalContextStore(db);

export function getTerminalContext(terminal: string): TerminalContext | undefined {
  return terminalContextStore.get(terminal);
}

export function setTerminalContext(
  terminal: string,
  epicId: string | null,
  projectId: string | null,
  taskId: string | null,
  status: TerminalContext['status'] = 'idle',
  consecutiveTasks: number = 0,
  islandId: string | null = null,
): void {
  terminalContextStore.setGeneric(
    terminal, epicId, projectId, taskId, status, consecutiveTasks, islandId,
  );
}

/** Atomic ownership CAS: only an empty context or the exact tuple may succeed. */
export function claimTerminalTask(
  terminal: string,
  messageId: string,
  islandId: string,
  epicId: string | null,
  projectId: string | null,
): TerminalClaimResult {
  return terminalContextStore.claim(terminal, messageId, islandId, epicId, projectId);
}

/** Exact scoped release CAS; no read-then-write window and no root override. */
export function releaseTerminalTask(
  terminal: string,
  messageId: string,
  islandId: string,
): boolean {
  return terminalContextStore.release(terminal, messageId, islandId);
}

export function markTerminalWorking(terminal: string, taskId: string): void {
  terminalContextStore.markWorking(terminal, taskId);
}

export function markTerminalIdle(terminal: string): void {
  terminalContextStore.markIdle(terminal);
}

export function markTerminalBlocked(terminal: string): void {
  terminalContextStore.markBlocked(terminal);
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
  epicId: string | null,
  receiptContext: CompletionReceiptContext,
): RoutingDecision {
  return commitTaskCompletion(terminal, messageId, epicId, receiptContext);
}

/**
 * Compatibility-only completion for legacy, unscoped project automation.
 * A task claimed through the authenticated runner always has current_island_id
 * and is therefore refused here: only complete_task may finish that resource.
 */
export function handleLegacyTaskCompletion(
  terminal: string,
  messageId: string,
  epicId: string | null,
): RoutingDecision {
  return commitTaskCompletion(terminal, messageId, epicId);
}

function commitTaskCompletion(
  terminal: string,
  messageId: string,
  epicId: string | null,
  receiptContext?: CompletionReceiptContext,
): RoutingDecision {
  const completedAt = new Date().toISOString();
  const { consecutiveTasks } = db.transaction(() => {
    // Task state and the durable receipt must commit atomically. Otherwise a
    // crash could clear current_task_id while leaving an attached runner with
    // no proof that complete_task succeeded.
    const ctx = getTerminalContext(terminal);
    if (receiptContext) {
      if (!receiptContext.islandId) {
        throw new ValidationError('Completion receipt island scope must be non-empty', { islandId: 'must be non-empty' });
      }
      if (!ctx || ctx.current_task_id !== messageId) {
        throw new InvalidStateError(`Task ${messageId} is not claimed by terminal ${terminal}`);
      }
      if (!ctx.current_island_id || ctx.current_island_id !== receiptContext.islandId) {
        throw new InvalidStateError(
          `Completion scope mismatch for ${terminal}/${messageId}: claimed island does not match caller`,
        );
      }
    } else if (ctx?.current_island_id) {
      throw new LegacyCompletionRefusedError(
        `Legacy completion refused for island-scoped task ${ctx.current_island_id}/${terminal}/${messageId}`,
      );
    }

    markTaskCompleted(messageId);
    const nextConsecutiveTasks = (ctx?.consecutive_epic_tasks || 0) + 1;

    terminalContextStore.replaceAfterOwnedTransition(
      terminal,
      epicId,
      ctx?.current_project_id || null,
      null, // clear current task
      'idle',
      epicId === ctx?.current_epic_id ? nextConsecutiveTasks : 1,
      null,
    );

    if (receiptContext) {
      completionReceiptStore.record({
        islandId: receiptContext.islandId,
        terminalId: terminal,
        messageId,
        source: receiptContext.source,
        completedAt,
      });
    }

    return { consecutiveTasks: nextConsecutiveTasks };
  })();

  log(`[EpicRouter] Terminal ${terminal} completed task ${messageId} (epic: ${epicId || 'none'}, consecutive: ${consecutiveTasks})`);

  // ADR-053: Emit outbox:done event for subscription triggers
  // This is the DB-authoritative event, not file-based
  emitOutboxEvent('outbox:done', terminal, messageId, {
    epicId: epicId || undefined,
    source: receiptContext ? 'mcp_complete_task' : 'legacy_file_done',
    completedAt,
  });
  log(`[EpicRouter] Emitted outbox:done for ${messageId} (${receiptContext ? 'MCP-authoritative' : 'legacy-unscoped'})`);

  // ADR-053: Update checkpoint status in EPICS.yaml if this task triggers one
  if (epicId) {
    updateCheckpointStatus(epicId, messageId);
  }

  // Get next task decision
  return getNextTaskForTerminal(terminal);
}

/**
 * Dispatch a task to terminal
 */
export function dispatchTask(terminal: string, task: QueuedTask): void {
  db.transaction(() => {
    terminalContextStore.assertGenericMutationAllowed(terminal);
    markTaskDispatched(task.id);
    terminalContextStore.replaceAfterOwnedTransition(
      terminal,
      task.epic_id || null,
      task.project_id || null,
      task.message_id,
      'working',
      0,
      null,
    );
  })();

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
