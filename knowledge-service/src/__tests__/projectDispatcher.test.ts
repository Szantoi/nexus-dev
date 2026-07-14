/**
 * Project Dispatcher Tests (Track E)
 *
 * Unit tests for the ProjectDispatcher class:
 * - Constructor and configuration
 * - DONE message parsing
 * - Task dispatching
 * - Unblocked task finding
 * - Milestone completion detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  ProjectDispatcher,
  DispatcherConfig,
  Task,
  TaskChain,
  DoneMessage,
} from '../pipeline/projectDispatcher';

// Test fixtures directory
const TEST_PROJECTS_DIR = '/tmp/test-projects-dispatcher';
const TEST_TERMINALS_DIR = '/tmp/test-terminals-dispatcher';

// Helper function to create test task chain
const createTestTaskChain = (): TaskChain => ({
  version: '1.0',
  project: 'test-project',
  created: '2026-06-22',
  updated: '2026-06-22',
  config: {
    default_model: 'sonnet',
    auto_dispatch: true,
    notify_telegram: false,
  },
  milestones: [
    {
      id: 'M1',
      name: 'Phase 1',
      status: 'in_progress',
      blocked_by: [],
      tasks: [
        {
          id: 'TASK-001',
          name: 'Setup Backend',
          terminal: 'backend',
          status: 'in_progress',
          blocked_by: [],
          triggers_on_done: ['TASK-002'],
          msg_id: 'MSG-BACKEND-001',
        },
        {
          id: 'TASK-002',
          name: 'Create Frontend',
          terminal: 'frontend',
          status: 'pending',
          blocked_by: ['TASK-001'],
          triggers_on_done: ['TASK-003'],
        },
        {
          id: 'TASK-003',
          name: 'Write Tests',
          terminal: 'backend',
          status: 'pending',
          blocked_by: ['TASK-001', 'TASK-002'],
          triggers_on_done: [],
        },
      ],
    },
  ],
});

describe('ProjectDispatcher', () => {
  let dispatcher: ProjectDispatcher;

  beforeEach(async () => {
    // Create test directory structure
    await fs.mkdir(TEST_PROJECTS_DIR, { recursive: true });
    await fs.mkdir(TEST_TERMINALS_DIR, { recursive: true });

    // Create test terminals
    const terminals = ['backend', 'frontend', 'conductor'];
    for (const terminal of terminals) {
      await fs.mkdir(path.join(TEST_TERMINALS_DIR, terminal, 'inbox'), { recursive: true });
      await fs.mkdir(path.join(TEST_TERMINALS_DIR, terminal, 'outbox'), { recursive: true });
    }

    // Create dispatcher with test config
    const config: Partial<DispatcherConfig> = {
      projectsDir: TEST_PROJECTS_DIR,
      terminalsDir: TEST_TERMINALS_DIR,
      notifyTelegram: false,
      enabled: false,  // Don't auto-start watcher in tests
    };

    dispatcher = new ProjectDispatcher(config);
  });

  afterEach(async () => {
    // Clean up
    await dispatcher.stop();
    await fs.rm(TEST_PROJECTS_DIR, { recursive: true, force: true });
    await fs.rm(TEST_TERMINALS_DIR, { recursive: true, force: true });
  });

  describe('Constructor', () => {
    it('should create dispatcher with default config', () => {
      const d = new ProjectDispatcher();
      expect(d).toBeDefined();
    });

    it('should merge custom config with defaults', () => {
      const config: Partial<DispatcherConfig> = {
        checkInterval: 30_000,
        notifyTelegram: false,
      };

      const d = new ProjectDispatcher(config);
      expect(d).toBeDefined();
    });
  });

  describe('parseDoneMessage', () => {
    it('should parse valid DONE message', async () => {
      const content = `---
id: MSG-BACKEND-001-DONE
from: backend
to: conductor
type: done
ref: MSG-BACKEND-001
status: UNREAD
created: 2026-06-22
---

# DONE: Setup Backend

## Summary
Backend setup completed successfully.

## Tests
All tests passing.
`;

      const filePath = path.join(TEST_TERMINALS_DIR, 'backend', 'outbox', '2026-06-22_001_setup-backend-done.md');
      await fs.writeFile(filePath, content);

      // Use private method via type assertion
      const parseDoneMessage = (dispatcher as any).parseDoneMessage.bind(dispatcher);
      const result: DoneMessage | null = await parseDoneMessage(filePath, content);

      expect(result).not.toBeNull();
      expect(result?.from).toBe('backend');
      expect(result?.task_id).toBe('MSG-BACKEND-001-DONE');  // ID takes precedence
      expect(result?.ref).toBe('MSG-BACKEND-001');
    });

    it('should return null for non-DONE message', async () => {
      const content = `---
id: MSG-BACKEND-002
from: conductor
to: backend
type: task
status: UNREAD
---

# New Task
`;

      const filePath = path.join(TEST_TERMINALS_DIR, 'backend', 'inbox', '2026-06-22_002_new-task.md');
      await fs.writeFile(filePath, content);

      const parseDoneMessage = (dispatcher as any).parseDoneMessage.bind(dispatcher);
      const result: DoneMessage | null = await parseDoneMessage(filePath, content);

      expect(result).toBeNull();
    });

    it('should return null for malformed frontmatter', async () => {
      const content = `This is not a valid markdown file with frontmatter`;

      const filePath = path.join(TEST_TERMINALS_DIR, 'backend', 'outbox', 'invalid.md');
      await fs.writeFile(filePath, content);

      const parseDoneMessage = (dispatcher as any).parseDoneMessage.bind(dispatcher);
      const result: DoneMessage | null = await parseDoneMessage(filePath, content);

      expect(result).toBeNull();
    });
  });

  describe('scanActiveProjects', () => {
    beforeEach(async () => {
      // Create test projects
      const projects = ['project-a', 'project-b', 'empty-project'];

      for (const project of projects) {
        const projectDir = path.join(TEST_PROJECTS_DIR, project);
        await fs.mkdir(projectDir, { recursive: true });

        if (project !== 'empty-project') {
          // Create TASKS.yaml
          const tasks = createTestTaskChain();
          tasks.project = project;
          await fs.writeFile(path.join(projectDir, 'TASKS.yaml'), yaml.dump(tasks));
        }
      }
    });

    it('should scan and find active projects', async () => {
      const scanActiveProjects = (dispatcher as any).scanActiveProjects.bind(dispatcher);
      const result = await scanActiveProjects();

      expect(result.length).toBe(2);
      expect(result.map((p: any) => p.slug)).toContain('project-a');
      expect(result.map((p: any) => p.slug)).toContain('project-b');
      expect(result.map((p: any) => p.slug)).not.toContain('empty-project');
    });
  });

  describe('findUnblockedTasks', () => {
    it('should find tasks that are unblocked', () => {
      const tasks = createTestTaskChain();

      // Mark TASK-001 as done
      tasks.milestones[0].tasks[0].status = 'done';

      // Find unblocked tasks triggered by TASK-001
      const findUnblockedTasks = (dispatcher as any).findUnblockedTasks.bind(dispatcher);
      const unblocked: Task[] = findUnblockedTasks(tasks, ['TASK-002']);

      expect(unblocked.length).toBe(1);
      expect(unblocked[0].id).toBe('TASK-002');
    });

    it('should not return tasks that are still blocked', () => {
      const tasks = createTestTaskChain();

      // Mark TASK-001 as done
      tasks.milestones[0].tasks[0].status = 'done';

      // TASK-003 is still blocked by TASK-002
      const findUnblockedTasks = (dispatcher as any).findUnblockedTasks.bind(dispatcher);
      const unblocked: Task[] = findUnblockedTasks(tasks, ['TASK-003']);

      expect(unblocked.length).toBe(0);
    });

    it('should not return tasks that are already in progress', () => {
      const tasks = createTestTaskChain();

      // TASK-001 is already in_progress
      const findUnblockedTasks = (dispatcher as any).findUnblockedTasks.bind(dispatcher);
      const unblocked: Task[] = findUnblockedTasks(tasks, ['TASK-001']);

      expect(unblocked.length).toBe(0);
    });
  });

  describe('findTaskById', () => {
    it('should find task by ID', () => {
      const tasks = createTestTaskChain();

      const findTaskById = (dispatcher as any).findTaskById.bind(dispatcher);
      const task: Task | null = findTaskById(tasks, 'TASK-002');

      expect(task).not.toBeNull();
      expect(task?.name).toBe('Create Frontend');
    });

    it('should return null for non-existent task', () => {
      const tasks = createTestTaskChain();

      const findTaskById = (dispatcher as any).findTaskById.bind(dispatcher);
      const task: Task | null = findTaskById(tasks, 'TASK-999');

      expect(task).toBeNull();
    });
  });

  describe('getNextMsgNumber', () => {
    beforeEach(async () => {
      const inboxDir = path.join(TEST_TERMINALS_DIR, 'backend', 'inbox');

      // Create some existing messages
      await fs.writeFile(path.join(inboxDir, '2026-06-22_001_task-a.md'), 'content');
      await fs.writeFile(path.join(inboxDir, '2026-06-22_002_task-b.md'), 'content');
      await fs.writeFile(path.join(inboxDir, '2026-06-22_005_task-c.md'), 'content');
    });

    it('should return next message number', async () => {
      const getNextMsgNumber = (dispatcher as any).getNextMsgNumber.bind(dispatcher);
      const nextNum: number = await getNextMsgNumber('backend');

      expect(nextNum).toBe(6);  // Max is 005, so next is 006
    });

    it('should return 1 for empty inbox', async () => {
      const getNextMsgNumber = (dispatcher as any).getNextMsgNumber.bind(dispatcher);
      const nextNum: number = await getNextMsgNumber('frontend');

      expect(nextNum).toBe(1);
    });
  });

  describe('toSlug', () => {
    it('should convert text to slug', () => {
      const toSlug = (dispatcher as any).toSlug.bind(dispatcher);

      expect(toSlug('Hello World')).toBe('hello-world');
      expect(toSlug('Setup Backend API')).toBe('setup-backend-api');
      expect(toSlug('Fix bug #123')).toBe('fix-bug-123');
      expect(toSlug('Multiple   Spaces')).toBe('multiple-spaces');
    });

    it('should handle special characters', () => {
      const toSlug = (dispatcher as any).toSlug.bind(dispatcher);

      expect(toSlug('Node.js Development')).toBe('node-js-development');
      expect(toSlug('C++ Programming')).toBe('c-programming');
      expect(toSlug('Hello@World!')).toBe('hello-world');
    });
  });

  describe('checkMilestoneCompletion', () => {
    it('should mark milestone as done when all tasks are done', async () => {
      const projectDir = path.join(TEST_PROJECTS_DIR, 'milestone-test');
      await fs.mkdir(projectDir, { recursive: true });

      const tasks = createTestTaskChain();
      tasks.project = 'milestone-test';

      // Mark all tasks as done
      tasks.milestones[0].tasks.forEach(t => {
        t.status = 'done';
      });

      const tasksPath = path.join(projectDir, 'TASKS.yaml');
      await fs.writeFile(tasksPath, yaml.dump(tasks));

      const checkMilestoneCompletion = (dispatcher as any).checkMilestoneCompletion.bind(dispatcher);
      await checkMilestoneCompletion({ slug: 'milestone-test', path: projectDir }, tasks);

      // Read updated TASKS.yaml
      const updatedContent = await fs.readFile(tasksPath, 'utf-8');
      const updatedTasks = yaml.load(updatedContent) as TaskChain;

      expect(updatedTasks.milestones[0].status).toBe('done');
    });

    it('should not mark milestone as done when some tasks are pending', async () => {
      const projectDir = path.join(TEST_PROJECTS_DIR, 'milestone-test-2');
      await fs.mkdir(projectDir, { recursive: true });

      const tasks = createTestTaskChain();
      tasks.project = 'milestone-test-2';

      // Only mark first task as done
      tasks.milestones[0].tasks[0].status = 'done';

      const tasksPath = path.join(projectDir, 'TASKS.yaml');
      await fs.writeFile(tasksPath, yaml.dump(tasks));

      const checkMilestoneCompletion = (dispatcher as any).checkMilestoneCompletion.bind(dispatcher);
      await checkMilestoneCompletion({ slug: 'milestone-test-2', path: projectDir }, tasks);

      // Read updated TASKS.yaml
      const updatedContent = await fs.readFile(tasksPath, 'utf-8');
      const updatedTasks = yaml.load(updatedContent) as TaskChain;

      expect(updatedTasks.milestones[0].status).not.toBe('done');
    });
  });

  describe('generateInboxMessage', () => {
    it('should generate inbox message with correct format', async () => {
      const task: Task = {
        id: 'TASK-NEW',
        name: 'New Test Task',
        description: 'This is a test task',
        terminal: 'backend',
        status: 'pending',
        blocked_by: [],
        triggers_on_done: [],
        priority: 'high',
        model: 'opus',
      };

      const generateInboxMessage = (dispatcher as any).generateInboxMessage.bind(dispatcher);
      const inboxPath: string = await generateInboxMessage(task, 'test-project', 'MSG-CONDUCTOR-001');

      // Verify file was created
      const content = await fs.readFile(inboxPath, 'utf-8');

      expect(content).toContain('id: MSG-BACKEND-001');
      expect(content).toContain('to: backend');
      expect(content).toContain('type: task');
      expect(content).toContain('priority: high');
      expect(content).toContain('status: UNREAD');
      expect(content).toContain('model: opus');
      expect(content).toContain('ref: MSG-CONDUCTOR-001');
      expect(content).toContain('project: test-project');
      expect(content).toContain('# New Test Task');
      expect(content).toContain('This is a test task');
    });
  });
});
