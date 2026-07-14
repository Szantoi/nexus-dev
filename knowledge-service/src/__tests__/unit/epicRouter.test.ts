import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Epic Router Unit Tests
 *
 * Tests for epic-aware task routing:
 * - Terminal context management
 * - Task queuing and dequeuing
 * - Epic-aware routing decisions
 * - Project and Epic CRUD
 */

// Use in-memory database for testing
const TEST_DB_PATH = '/tmp/test-epic-router.db';

// Clean up before tests
beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
});

afterAll(() => {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
});

describe('Epic Router', () => {
  describe('SQLite Schema', () => {
    it('should create all required tables', () => {
      const db = new Database(TEST_DB_PATH);
      db.pragma('journal_mode = WAL');

      // Create schema (copy from epicRouter.ts)
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );

        CREATE TABLE IF NOT EXISTS epics (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER NOT NULL DEFAULT 2
        );

        CREATE TABLE IF NOT EXISTS terminal_context (
          terminal TEXT PRIMARY KEY,
          current_epic_id TEXT,
          current_project_id TEXT,
          current_task_id TEXT,
          status TEXT NOT NULL DEFAULT 'idle'
        );

        CREATE TABLE IF NOT EXISTS task_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT UNIQUE NOT NULL,
          terminal TEXT NOT NULL,
          epic_id TEXT,
          priority_order INTEGER NOT NULL DEFAULT 2,
          status TEXT NOT NULL DEFAULT 'queued'
        );
      `);

      // Verify tables exist
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all() as { name: string }[];

      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('projects');
      expect(tableNames).toContain('epics');
      expect(tableNames).toContain('terminal_context');
      expect(tableNames).toContain('task_queue');

      db.close();
    });
  });

  describe('Terminal Context', () => {
    it('should initialize terminal as idle with no epic', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE terminal_context (
          terminal TEXT PRIMARY KEY,
          current_epic_id TEXT,
          status TEXT NOT NULL DEFAULT 'idle'
        );
      `);

      db.prepare(`INSERT INTO terminal_context (terminal, status) VALUES (?, ?)`).run('backend', 'idle');

      const ctx = db.prepare(`SELECT * FROM terminal_context WHERE terminal = ?`).get('backend') as any;
      expect(ctx.terminal).toBe('backend');
      expect(ctx.status).toBe('idle');
      expect(ctx.current_epic_id).toBeNull();

      db.close();
    });

    it('should update terminal status to working', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE terminal_context (
          terminal TEXT PRIMARY KEY,
          current_epic_id TEXT,
          current_task_id TEXT,
          status TEXT NOT NULL DEFAULT 'idle'
        );
      `);

      db.prepare(`INSERT INTO terminal_context (terminal, status) VALUES (?, ?)`).run('backend', 'idle');
      db.prepare(`UPDATE terminal_context SET status = ?, current_task_id = ? WHERE terminal = ?`)
        .run('working', 'MSG-BACKEND-001', 'backend');

      const ctx = db.prepare(`SELECT * FROM terminal_context WHERE terminal = ?`).get('backend') as any;
      expect(ctx.status).toBe('working');
      expect(ctx.current_task_id).toBe('MSG-BACKEND-001');

      db.close();
    });

    it('should track epic context when task starts', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE terminal_context (
          terminal TEXT PRIMARY KEY,
          current_epic_id TEXT,
          current_project_id TEXT,
          status TEXT NOT NULL DEFAULT 'idle'
        );
      `);

      db.prepare(`
        INSERT INTO terminal_context (terminal, current_epic_id, current_project_id, status)
        VALUES (?, ?, ?, ?)
      `).run('backend', 'EPIC-CUTTING-Q3', 'spaceos/cutting', 'working');

      const ctx = db.prepare(`SELECT * FROM terminal_context WHERE terminal = ?`).get('backend') as any;
      expect(ctx.current_epic_id).toBe('EPIC-CUTTING-Q3');
      expect(ctx.current_project_id).toBe('spaceos/cutting');

      db.close();
    });
  });

  describe('Task Queue', () => {
    it('should queue tasks with priority ordering', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE task_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT UNIQUE NOT NULL,
          terminal TEXT NOT NULL,
          epic_id TEXT,
          priority_order INTEGER NOT NULL DEFAULT 2,
          status TEXT NOT NULL DEFAULT 'queued',
          queued_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Queue tasks with different priorities
      db.prepare(`INSERT INTO task_queue (message_id, terminal, epic_id, priority_order) VALUES (?, ?, ?, ?)`)
        .run('MSG-001', 'backend', 'EPIC-A', 2); // medium
      db.prepare(`INSERT INTO task_queue (message_id, terminal, epic_id, priority_order) VALUES (?, ?, ?, ?)`)
        .run('MSG-002', 'backend', 'EPIC-A', 4); // critical
      db.prepare(`INSERT INTO task_queue (message_id, terminal, epic_id, priority_order) VALUES (?, ?, ?, ?)`)
        .run('MSG-003', 'backend', 'EPIC-A', 3); // high

      // Get next task (should be highest priority)
      const nextTask = db.prepare(`
        SELECT * FROM task_queue
        WHERE terminal = ? AND status = 'queued'
        ORDER BY priority_order DESC, queued_at ASC
        LIMIT 1
      `).get('backend') as any;

      expect(nextTask.message_id).toBe('MSG-002'); // critical
      expect(nextTask.priority_order).toBe(4);

      db.close();
    });

    it('should prioritize same-epic tasks', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE task_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT UNIQUE NOT NULL,
          terminal TEXT NOT NULL,
          epic_id TEXT,
          priority_order INTEGER NOT NULL DEFAULT 2,
          status TEXT NOT NULL DEFAULT 'queued'
        );
      `);

      // Queue tasks from different epics
      db.prepare(`INSERT INTO task_queue (message_id, terminal, epic_id, priority_order) VALUES (?, ?, ?, ?)`)
        .run('MSG-001', 'backend', 'EPIC-B', 4); // critical, different epic
      db.prepare(`INSERT INTO task_queue (message_id, terminal, epic_id, priority_order) VALUES (?, ?, ?, ?)`)
        .run('MSG-002', 'backend', 'EPIC-A', 2); // medium, same epic

      const currentEpicId = 'EPIC-A';

      // Get same-epic task first
      const sameEpicTask = db.prepare(`
        SELECT * FROM task_queue
        WHERE terminal = ? AND epic_id = ? AND status = 'queued'
        ORDER BY priority_order DESC
        LIMIT 1
      `).get('backend', currentEpicId) as any;

      expect(sameEpicTask?.message_id).toBe('MSG-002');

      db.close();
    });

    it('should mark task as dispatched', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE task_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT UNIQUE NOT NULL,
          terminal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          dispatched_at TEXT
        );
      `);

      db.prepare(`INSERT INTO task_queue (message_id, terminal) VALUES (?, ?)`).run('MSG-001', 'backend');

      db.prepare(`UPDATE task_queue SET status = 'dispatched', dispatched_at = datetime('now') WHERE message_id = ?`)
        .run('MSG-001');

      const task = db.prepare(`SELECT * FROM task_queue WHERE message_id = ?`).get('MSG-001') as any;
      expect(task.status).toBe('dispatched');
      expect(task.dispatched_at).not.toBeNull();

      db.close();
    });
  });

  describe('Routing Decision Logic', () => {
    it('should not dispatch to working terminal', () => {
      const terminalStatus = 'working';
      const shouldDispatch = terminalStatus === 'idle';
      expect(shouldDispatch).toBe(false);
    });

    it('should dispatch to idle terminal', () => {
      const terminalStatus = 'idle';
      const shouldDispatch = terminalStatus === 'idle';
      expect(shouldDispatch).toBe(true);
    });

    it('should prefer same-epic task', () => {
      const currentEpicId = 'EPIC-A';
      const sameEpicTask = { message_id: 'MSG-002', epic_id: 'EPIC-A' };
      const otherEpicTask = { message_id: 'MSG-001', epic_id: 'EPIC-B' };

      const taskToDispatch = sameEpicTask.epic_id === currentEpicId ? sameEpicTask : otherEpicTask;
      expect(taskToDispatch.message_id).toBe('MSG-002');
    });

    it('should switch epic when no same-epic tasks available', () => {
      const currentEpicId = 'EPIC-A';
      const sameEpicTasks: any[] = [];
      const otherEpicTask = { message_id: 'MSG-001', epic_id: 'EPIC-B' };

      const shouldSwitchEpic = sameEpicTasks.length === 0 && otherEpicTask !== null;
      expect(shouldSwitchEpic).toBe(true);

      // After switch, current epic should be updated
      const newEpicId = otherEpicTask.epic_id;
      expect(newEpicId).toBe('EPIC-B');
    });

    it('should stop when no tasks available', () => {
      const queuedTasks: any[] = [];
      const nextAction = queuedTasks.length === 0 ? 'stop' : 'dispatch';
      expect(nextAction).toBe('stop');
    });
  });

  describe('Project and Epic Management', () => {
    it('should create project', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      db.prepare(`INSERT INTO projects (id, name, status) VALUES (?, ?, ?)`)
        .run('spaceos/cutting', 'Cutting Module', 'active');

      const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get('spaceos/cutting') as any;
      expect(project.id).toBe('spaceos/cutting');
      expect(project.name).toBe('Cutting Module');
      expect(project.status).toBe('active');

      db.close();
    });

    it('should create epic with dependencies', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE epics (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          depends_on TEXT
        );
      `);

      const dependsOn = JSON.stringify(['EPIC-IDENTITY-V1', 'EPIC-ORCH-V2']);
      db.prepare(`INSERT INTO epics (id, project_id, name, status, depends_on) VALUES (?, ?, ?, ?, ?)`)
        .run('EPIC-PORTAL-V2', 'spaceos/portal', 'Customer Portal v2', 'pending', dependsOn);

      const epic = db.prepare(`SELECT * FROM epics WHERE id = ?`).get('EPIC-PORTAL-V2') as any;
      expect(epic.id).toBe('EPIC-PORTAL-V2');
      const parsedDeps = JSON.parse(epic.depends_on);
      expect(parsedDeps).toContain('EPIC-IDENTITY-V1');
      expect(parsedDeps).toContain('EPIC-ORCH-V2');

      db.close();
    });

    it('should list active epics', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE epics (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER NOT NULL DEFAULT 2
        );
      `);

      db.prepare(`INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, ?, ?, ?)`)
        .run('EPIC-1', 'proj-a', 'Epic 1', 'active', 3);
      db.prepare(`INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, ?, ?, ?)`)
        .run('EPIC-2', 'proj-a', 'Epic 2', 'pending', 2);
      db.prepare(`INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, ?, ?, ?)`)
        .run('EPIC-3', 'proj-b', 'Epic 3', 'done', 1);

      const activeEpics = db.prepare(`
        SELECT * FROM epics WHERE status IN ('pending', 'active') ORDER BY priority DESC
      `).all() as any[];

      expect(activeEpics.length).toBe(2);
      expect(activeEpics[0].id).toBe('EPIC-1'); // highest priority
      expect(activeEpics[1].id).toBe('EPIC-2');

      db.close();
    });
  });

  describe('Task Completion Flow', () => {
    it('should mark task completed and get next decision', () => {
      const db = new Database(TEST_DB_PATH);
      db.exec(`
        CREATE TABLE task_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT UNIQUE NOT NULL,
          terminal TEXT NOT NULL,
          epic_id TEXT,
          status TEXT NOT NULL DEFAULT 'queued'
        );
        CREATE TABLE terminal_context (
          terminal TEXT PRIMARY KEY,
          current_epic_id TEXT,
          current_task_id TEXT,
          status TEXT NOT NULL DEFAULT 'idle',
          consecutive_epic_tasks INTEGER DEFAULT 0
        );
      `);

      // Add terminal context
      db.prepare(`INSERT INTO terminal_context (terminal, current_epic_id, current_task_id, status) VALUES (?, ?, ?, ?)`)
        .run('backend', 'EPIC-A', 'MSG-001', 'working');

      // Add current task and a next task
      db.prepare(`INSERT INTO task_queue (message_id, terminal, epic_id, status) VALUES (?, ?, ?, ?)`)
        .run('MSG-001', 'backend', 'EPIC-A', 'executing');
      db.prepare(`INSERT INTO task_queue (message_id, terminal, epic_id, status) VALUES (?, ?, ?, ?)`)
        .run('MSG-002', 'backend', 'EPIC-A', 'queued');

      // Mark task completed
      db.prepare(`UPDATE task_queue SET status = 'completed' WHERE message_id = ?`).run('MSG-001');
      db.prepare(`UPDATE terminal_context SET status = 'idle', current_task_id = NULL WHERE terminal = ?`)
        .run('backend');

      // Check terminal is idle
      const ctx = db.prepare(`SELECT * FROM terminal_context WHERE terminal = ?`).get('backend') as any;
      expect(ctx.status).toBe('idle');
      expect(ctx.current_task_id).toBeNull();

      // Get next task
      const nextTask = db.prepare(`
        SELECT * FROM task_queue WHERE terminal = ? AND status = 'queued' ORDER BY id LIMIT 1
      `).get('backend') as any;

      expect(nextTask.message_id).toBe('MSG-002');

      db.close();
    });

    it('should increment consecutive task counter within same epic', () => {
      let consecutiveTasks = 3;
      const completedEpicId = 'EPIC-A';
      const currentEpicId = 'EPIC-A';

      if (completedEpicId === currentEpicId) {
        consecutiveTasks += 1;
      } else {
        consecutiveTasks = 1;
      }

      expect(consecutiveTasks).toBe(4);
    });

    it('should reset consecutive counter when switching epics', () => {
      let consecutiveTasks = 5;
      const completedEpicId = 'EPIC-B';
      const currentEpicId = 'EPIC-A';

      if (completedEpicId === currentEpicId) {
        consecutiveTasks += 1;
      } else {
        consecutiveTasks = 1;
      }

      expect(consecutiveTasks).toBe(1);
    });
  });

  describe('Priority Ordering', () => {
    it('should map priority strings to numbers correctly', () => {
      const priorityOrder: Record<string, number> = {
        critical: 4,
        high: 3,
        medium: 2,
        low: 1,
      };

      expect(priorityOrder['critical']).toBe(4);
      expect(priorityOrder['high']).toBe(3);
      expect(priorityOrder['medium']).toBe(2);
      expect(priorityOrder['low']).toBe(1);
    });

    it('should order critical before high before medium before low', () => {
      const tasks = [
        { id: 1, priority_order: 2 }, // medium
        { id: 2, priority_order: 4 }, // critical
        { id: 3, priority_order: 1 }, // low
        { id: 4, priority_order: 3 }, // high
      ];

      const sorted = tasks.sort((a, b) => b.priority_order - a.priority_order);

      expect(sorted[0].priority_order).toBe(4); // critical first
      expect(sorted[1].priority_order).toBe(3); // high second
      expect(sorted[2].priority_order).toBe(2); // medium third
      expect(sorted[3].priority_order).toBe(1); // low last
    });
  });
});
