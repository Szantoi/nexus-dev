/**
 * Project Automation Dispatcher (Track A)
 *
 * Watches for DONE messages in terminal outbox folders and automatically
 * dispatches next tasks based on project TASKS.yaml definitions.
 *
 * Features:
 * - Chokidar file watcher for terminals/star/outbox/star.md pattern
 * - DONE message detection and parsing
 * - Task matching and status updates
 * - Auto-dispatch of unblocked tasks
 * - Generator execution (Track B integration)
 * - Telegram notifications
 */

import chokidar, { FSWatcher } from 'chokidar';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { matchDoneToTask } from './projectMatcher';
import { updateProjectStatus } from './statusUpdater';
import {
  getNextTaskForTerminal,
  handleTaskCompletion,
  dispatchTask as epicDispatchTask,
  getTerminalContext,
  markTerminalIdle,
  queueTask,
  QueuedTask,
  RoutingDecision,
} from './epicRouter';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DispatcherConfig {
  checkInterval: number;      // Fallback polling interval (ms)
  projectsDir: string;         // /opt/spaceos/docs/projects
  terminalsDir: string;        // /opt/spaceos/terminals
  generatorsDir: string;       // /opt/spaceos/scripts/generators
  notifyTelegram: boolean;
  retryOnBlocked: number;
  enabled: boolean;
}

export interface DoneMessage {
  from: string;       // terminal name
  task_id: string;    // MSG-BACKEND-004
  ref?: string;       // Optional reference
  timestamp: Date;
  filePath: string;
  content: string;
  // Epic-aware fields (2026-06-24)
  epic_id?: string;   // e.g., "EPIC-CUTTING-Q3"
  project_id?: string; // e.g., "spaceos/cutting"
}

export interface Task {
  id: string;
  name: string;
  description?: string;
  terminal: string;
  model?: string;
  priority?: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'escalated';
  blocked_by: string[];
  triggers_on_done: string[];
  auto_generate?: boolean;
  generator?: string;
  generator_params?: Record<string, any>;
  msg_id?: string;
  inbox_path?: string;
  retry_count?: number;
  completed_at?: string;
}

export interface Milestone {
  id: string;
  name: string;
  status: 'pending' | 'in_progress' | 'done';
  blocked_by: string[];
  tasks: Task[];
}

export interface TaskChain {
  version: string;
  project: string;
  created: string;
  updated: string;
  config: {
    default_model?: string;
    auto_dispatch: boolean;
    notify_telegram: boolean;
    retry_on_blocked?: number;
  };
  milestones: Milestone[];
}

// ─── Default Configuration ──────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const DEFAULT_CONFIG: DispatcherConfig = {
  checkInterval: 60_000,  // 1 minute fallback
  projectsDir: process.env.PROJECTS_DIR || `${SPACEOS_ROOT}/docs/projects`,
  terminalsDir: process.env.TERMINALS_DIR || `${SPACEOS_ROOT}/terminals`,
  generatorsDir: process.env.GENERATORS_DIR || `${SPACEOS_ROOT}/spaceos-nexus/knowledge-service/src/generators`,
  notifyTelegram: true,
  retryOnBlocked: 3,
  enabled: true,
};

// ─── Project Dispatcher Class ──────────────────────────────────────────────

export class ProjectDispatcher {
  private config: DispatcherConfig;
  private watcher: FSWatcher | null = null;
  private isRunning = false;
  private processedFiles = new Set<string>();

  constructor(config: Partial<DispatcherConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the dispatcher with Chokidar file watcher
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[ProjectDispatcher] Already running');
      return;
    }

    if (!this.config.enabled) {
      console.log('[ProjectDispatcher] Disabled by configuration');
      return;
    }

    this.isRunning = true;
    console.log('[ProjectDispatcher] Starting...');

    // Initialize Chokidar watcher
    const watchPattern = path.join(this.config.terminalsDir, '*/outbox/*.md');

    this.watcher = chokidar.watch(watchPattern, {
      persistent: true,
      ignoreInitial: true,  // Don't process existing files on startup
      awaitWriteFinish: {
        stabilityThreshold: 500,  // Wait 500ms for file write to finish
        pollInterval: 100,
      },
    });

    // Watch for new DONE files
    this.watcher.on('add', async (filePath: string) => {
      await this.handleNewFile(filePath);
    });

    // Watch for file changes (e.g., status: UNREAD → READ)
    this.watcher.on('change', async (filePath: string) => {
      await this.handleNewFile(filePath);
    });

    this.watcher.on('error', (error) => {
      console.error('[ProjectDispatcher] Watcher error:', error);
    });

    console.log(`[ProjectDispatcher] Watching: ${watchPattern}`);
  }

  /**
   * Stop the dispatcher
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[ProjectDispatcher] Stopping...');
    this.isRunning = false;

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    console.log('[ProjectDispatcher] Stopped');
  }

  /**
   * Handle new or changed file
   */
  private async handleNewFile(filePath: string): Promise<void> {
    // Prevent duplicate processing
    if (this.processedFiles.has(filePath)) {
      return;
    }

    try {
      // Read and parse file
      const content = await fs.readFile(filePath, 'utf-8');
      const doneMessage = await this.parseDoneMessage(filePath, content);

      if (!doneMessage) {
        // Not a DONE message, ignore
        return;
      }

      // Mark as processed
      this.processedFiles.add(filePath);

      console.log(`[ProjectDispatcher] Processing DONE: ${doneMessage.task_id} from ${doneMessage.from}`);

      // Process the DONE message
      await this.processProjectDone(doneMessage);

    } catch (error) {
      console.error(`[ProjectDispatcher] Error processing file ${filePath}:`, error);
    }
  }

  /**
   * Parse DONE message from outbox file
   */
  private async parseDoneMessage(filePath: string, content: string): Promise<DoneMessage | null> {
    // Extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatter = yaml.load(frontmatterMatch[1]) as any;

    // Check if it's a DONE message
    if (frontmatter.type !== 'done') {
      return null;
    }

    // Extract terminal name from path
    const terminal = path.basename(path.dirname(path.dirname(filePath)));

    return {
      from: terminal,
      task_id: frontmatter.id || frontmatter.ref,
      ref: frontmatter.ref,
      timestamp: new Date(),
      filePath,
      content,
      // Epic-aware fields
      epic_id: frontmatter.epic_id,
      project_id: frontmatter.project_id,
    };
  }

  /**
   * Process DONE message and dispatch next tasks
   *
   * Epic-aware logic (2026-06-24):
   * 1. Use epicRouter to handle task completion
   * 2. Let epicRouter decide next task based on epic context
   * 3. Only dispatch if terminal should receive next task
   */
  private async processProjectDone(done: DoneMessage): Promise<void> {
    // ── Epic-aware routing: handle task completion ──
    const routingDecision = handleTaskCompletion(
      done.from,
      done.task_id,
      done.epic_id || null
    );

    console.log(`[ProjectDispatcher] Epic routing decision: ${routingDecision.nextAction} - ${routingDecision.reason}`);

    // ── Legacy project TASKS.yaml processing ──
    const projects = await this.scanActiveProjects();

    for (const project of projects) {
      try {
        // 2. Load TASKS.yaml
        const tasksPath = path.join(project.path, 'TASKS.yaml');
        const tasksContent = await fs.readFile(tasksPath, 'utf-8');
        const tasks: TaskChain = yaml.load(tasksContent) as TaskChain;

        // 3. Match DONE to project task
        const task = matchDoneToTask(tasks, done);
        if (!task) {
          // No match in this project
          continue;
        }

        console.log(`[ProjectDispatcher] Matched task ${task.id} in project ${project.slug}`);

        // 4. Mark task as done
        task.status = 'done';
        task.completed_at = new Date().toISOString();

        // 5. Update TASKS.yaml
        tasks.updated = new Date().toISOString().split('T')[0];
        await fs.writeFile(tasksPath, yaml.dump(tasks));

        // 6. Find next unblocked tasks
        const nextTasks = this.findUnblockedTasks(tasks, task.triggers_on_done);

        console.log(`[ProjectDispatcher] Found ${nextTasks.length} unblocked tasks`);

        // 7. Queue tasks via epicRouter instead of direct dispatch
        for (const nextTask of nextTasks) {
          await this.queueOrDispatchTask(project, tasks, nextTask, done, routingDecision);
        }

        // 8. Update STATUS.md
        await updateProjectStatus(project.path, tasks);

        // 9. Check milestone completion
        await this.checkMilestoneCompletion(project, tasks);

      } catch (error) {
        console.error(`[ProjectDispatcher] Error processing project ${project.slug}:`, error);
      }
    }

    // ── If epicRouter has a task to dispatch from queue ──
    if (routingDecision.shouldDispatch && routingDecision.task) {
      await this.dispatchQueuedTask(routingDecision.task, done);
    }
  }

  /**
   * Queue or dispatch task based on epic routing
   */
  private async queueOrDispatchTask(
    project: { slug: string; path: string },
    tasks: TaskChain,
    task: Task,
    previousDone: DoneMessage,
    routingDecision: RoutingDecision
  ): Promise<void> {
    const ctx = getTerminalContext(task.terminal);
    const currentEpicId = ctx?.current_epic_id;

    // Determine epic_id for this task (inherit from project or done message)
    const taskEpicId = previousDone.epic_id || `project-${project.slug}`;
    const taskProjectId = previousDone.project_id || project.slug;

    // If terminal is already working, queue the task
    if (ctx?.status === 'working') {
      console.log(`[ProjectDispatcher] Terminal ${task.terminal} is busy, queuing task ${task.id}`);
      queueTask(
        `TASK-${task.id}`,
        task.terminal,
        taskEpicId,
        taskProjectId,
        task.priority as 'critical' | 'high' | 'medium' | 'low' || 'medium'
      );
      return;
    }

    // If same epic context, dispatch immediately
    if (!currentEpicId || currentEpicId === taskEpicId) {
      console.log(`[ProjectDispatcher] Same epic context, dispatching task ${task.id}`);
      await this.dispatchTask(project, tasks, task, previousDone);
    } else {
      // Different epic - queue and let epicRouter decide
      console.log(`[ProjectDispatcher] Different epic (current: ${currentEpicId}, task: ${taskEpicId}), queuing task ${task.id}`);
      queueTask(
        `TASK-${task.id}`,
        task.terminal,
        taskEpicId,
        taskProjectId,
        task.priority as 'critical' | 'high' | 'medium' | 'low' || 'medium'
      );
    }
  }

  /**
   * Dispatch a task that was in the epicRouter queue
   */
  private async dispatchQueuedTask(queuedTask: QueuedTask, previousDone: DoneMessage): Promise<void> {
    console.log(`[ProjectDispatcher] Dispatching queued task ${queuedTask.message_id} to ${queuedTask.terminal}`);

    // Mark as dispatched in epicRouter
    epicDispatchTask(queuedTask.terminal, queuedTask);

    // Notify via Telegram
    if (this.config.notifyTelegram) {
      await this.notifyTelegram(`📤 Queued task dispatched: ${queuedTask.message_id} → ${queuedTask.terminal}`);
    }
  }

  /**
   * Scan for active projects
   */
  private async scanActiveProjects(): Promise<Array<{ slug: string; path: string }>> {
    try {
      const entries = await fs.readdir(this.config.projectsDir, { withFileTypes: true });
      const projects: Array<{ slug: string; path: string }> = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const projectPath = path.join(this.config.projectsDir, entry.name);
          const tasksYamlPath = path.join(projectPath, 'TASKS.yaml');

          // Check if TASKS.yaml exists
          try {
            await fs.access(tasksYamlPath);
            projects.push({
              slug: entry.name,
              path: projectPath,
            });
          } catch {
            // No TASKS.yaml, skip
          }
        }
      }

      return projects;
    } catch (error) {
      console.error('[ProjectDispatcher] Error scanning projects:', error);
      return [];
    }
  }

  /**
   * Find unblocked tasks that can be dispatched
   */
  private findUnblockedTasks(tasks: TaskChain, triggeredIds: string[]): Task[] {
    const unblocked: Task[] = [];

    for (const taskId of triggeredIds) {
      const task = this.findTaskById(tasks, taskId);
      if (!task) {
        console.warn(`[ProjectDispatcher] Task not found: ${taskId}`);
        continue;
      }

      // Check if ALL blocked_by tasks are done
      const allBlockersDone = task.blocked_by.every(blockerId => {
        const blocker = this.findTaskById(tasks, blockerId);
        return blocker && blocker.status === 'done';
      });

      if (allBlockersDone && task.status === 'pending') {
        unblocked.push(task);
      }
    }

    return unblocked;
  }

  /**
   * Find task by ID in task chain
   */
  private findTaskById(tasks: TaskChain, taskId: string): Task | null {
    for (const milestone of tasks.milestones) {
      const task = milestone.tasks.find(t => t.id === taskId);
      if (task) {
        return task;
      }
    }
    return null;
  }

  /**
   * Dispatch a task (generate inbox, optionally run generator)
   */
  private async dispatchTask(
    project: { slug: string; path: string },
    tasks: TaskChain,
    task: Task,
    previousDone: DoneMessage
  ): Promise<void> {
    console.log(`[ProjectDispatcher] Dispatching task ${task.id}: ${task.name}`);

    // 1. Run generator if auto_generate is true
    if (task.auto_generate && task.generator) {
      console.log(`[ProjectDispatcher] Running generator: ${task.generator}`);
      // TODO: Implement generator execution (Track B)
      // await this.runGenerator(task.generator, task.generator_params || {});
    }

    // 2. Generate inbox message
    const inboxPath = await this.generateInboxMessage(task, project.slug, previousDone.task_id);

    // 3. Mark task as in_progress
    task.status = 'in_progress';
    task.inbox_path = inboxPath;
    task.msg_id = this.extractMsgId(inboxPath);

    // 3.5 Update epicRouter terminal context (2026-06-24)
    const epicId = (task as any).epic_id || `project-${project.slug}`;
    const { setTerminalContext } = require('./epicRouter');
    setTerminalContext(
      task.terminal,
      epicId,
      project.slug,
      task.msg_id,
      'working',
      0  // will increment on completion
    );

    // 4. Update TASKS.yaml
    tasks.updated = new Date().toISOString().split('T')[0];
    const tasksPath = path.join(project.path, 'TASKS.yaml');
    await fs.writeFile(tasksPath, yaml.dump(tasks));

    // 5. Notify via Telegram
    if (this.config.notifyTelegram && tasks.config.notify_telegram) {
      await this.notifyTelegram(`🚀 Task dispatched: ${task.name} → ${task.terminal}`);
    }

    console.log(`[ProjectDispatcher] Task ${task.id} dispatched to ${task.terminal}`);
  }

  /**
   * Generate inbox message for task
   */
  private async generateInboxMessage(
    task: Task,
    projectSlug: string,
    ref: string
  ): Promise<string> {
    const date = new Date().toISOString().split('T')[0];
    const terminal = task.terminal;

    // Get next message number for terminal
    const msgNum = await this.getNextMsgNumber(terminal);
    const slug = this.toSlug(task.name);

    const fileName = `${date}_${msgNum.toString().padStart(3, '0')}_${slug}.md`;
    const filePath = path.join(this.config.terminalsDir, terminal, 'inbox', fileName);

    const msgId = `MSG-${terminal.toUpperCase()}-${msgNum.toString().padStart(3, '0')}`;

    // Get epic_id from task or project context
    const epicId = (task as any).epic_id || `project-${projectSlug}`;

    const content = `---
id: ${msgId}
from: conductor
to: ${terminal}
type: task
priority: ${task.priority || 'medium'}
status: UNREAD
model: ${task.model || 'sonnet'}
ref: ${ref}
project: ${projectSlug}
project_id: ${projectSlug}
epic_id: ${epicId}
task_id: ${task.id}
created: ${date}
---

# ${task.name}

## Feladat

**Projekt:** ${projectSlug}
**Prioritás:** ${(task.priority || 'medium').toUpperCase()}

### Kontextus

${task.description || 'Lásd a projekt specifikációt.'}

${task.auto_generate ? `
> ⚙️ **Automatikusan generált skeleton fájlok:**
> Generator: \`${task.generator}\`
> A fájlok már létrejöttek, ellenőrizd és egészítsd ki.
` : ''}

### Teendők

1. Olvasd el a projekt specifikációt: \`docs/projects/${projectSlug}/PLAN.md\`
2. Implementáld a feladatot
3. Futtasd a teszteket
4. Készíts DONE outbox üzenetet

### Definition of Done

- [ ] Kód implementálva
- [ ] Tesztek zöldek
- [ ] Nincs lint warning
- [ ] DONE outbox üzenet elküldve

### Referenciák

- Projekt spec: \`docs/projects/${projectSlug}/PLAN.md\`
- TASKS.yaml: \`docs/projects/${projectSlug}/TASKS.yaml\`
- Előző task: \`${ref}\`
`;

    // Ensure inbox directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write inbox file
    await fs.writeFile(filePath, content, 'utf-8');

    return filePath;
  }

  /**
   * Get next message number for terminal
   */
  private async getNextMsgNumber(terminal: string): Promise<number> {
    const inboxDir = path.join(this.config.terminalsDir, terminal, 'inbox');

    try {
      const files = await fs.readdir(inboxDir);
      const numbers = files
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const match = f.match(/^\d{4}-\d{2}-\d{2}_(\d{3})_/);
          return match ? parseInt(match[1], 10) : 0;
        });

      return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
    } catch {
      return 1;
    }
  }

  /**
   * Extract MSG ID from inbox file path
   */
  private extractMsgId(filePath: string): string {
    const fileName = path.basename(filePath);
    const match = fileName.match(/^\d{4}-\d{2}-\d{2}_(\d{3})_/);
    const num = match ? match[1] : '001';
    const terminal = path.basename(path.dirname(path.dirname(filePath)));
    return `MSG-${terminal.toUpperCase()}-${num}`;
  }

  /**
   * Convert string to slug (lowercase, hyphens)
   */
  private toSlug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Check milestone completion
   */
  private async checkMilestoneCompletion(
    project: { slug: string; path: string },
    tasks: TaskChain
  ): Promise<void> {
    for (const milestone of tasks.milestones) {
      if (milestone.status === 'done') {
        continue;
      }

      const allTasksDone = milestone.tasks.every(t => t.status === 'done');

      if (allTasksDone && milestone.tasks.length > 0) {
        milestone.status = 'done';
        console.log(`[ProjectDispatcher] ✅ Milestone completed: ${milestone.name}`);

        if (this.config.notifyTelegram && tasks.config.notify_telegram) {
          await this.notifyTelegram(`✅ Milestone completed: ${milestone.name} (${project.slug})`);
        }
      }
    }

    // Save updated tasks
    const tasksPath = path.join(project.path, 'TASKS.yaml');
    await fs.writeFile(tasksPath, yaml.dump(tasks));
  }

  /**
   * Send Telegram notification
   */
  private async notifyTelegram(message: string): Promise<void> {
    try {
      // Import telegramBot from pipeline
      const { sendTelegramMessage } = await import('./telegramBot');
      const chatId = process.env.TELEGRAM_CHAT_ID || '';
      if (!chatId) {
        console.log('[ProjectDispatcher] Telegram notification skipped: no TELEGRAM_CHAT_ID');
        return;
      }
      await sendTelegramMessage(chatId, message);
    } catch (error) {
      console.error('[ProjectDispatcher] Telegram notification failed:', error);
    }
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

let dispatcherInstance: ProjectDispatcher | null = null;

export function getDispatcher(config?: Partial<DispatcherConfig>): ProjectDispatcher {
  if (!dispatcherInstance) {
    dispatcherInstance = new ProjectDispatcher(config);
  }
  return dispatcherInstance;
}

export async function startDispatcher(config?: Partial<DispatcherConfig>): Promise<void> {
  const dispatcher = getDispatcher(config);
  await dispatcher.start();
}

export async function stopDispatcher(): Promise<void> {
  if (dispatcherInstance) {
    await dispatcherInstance.stop();
  }
}
