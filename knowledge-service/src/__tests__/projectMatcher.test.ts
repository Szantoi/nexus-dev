/**
 * Project Matcher Tests (Track E)
 *
 * Unit tests for project task matching logic:
 * - matchDoneToTask
 * - matchDoneToTaskStrict
 * - findTasksByTerminal
 * - findTasksByStatus
 * - findTaskById
 * - isTaskUnblocked
 * - validateTaskChain
 */

import { describe, it, expect } from 'vitest';
import {
  matchDoneToTask,
  matchDoneToTaskStrict,
  findTasksByTerminal,
  findTasksByStatus,
  findTaskById,
  isTaskUnblocked,
  getTasksUnblockedBy,
  validateTaskChain,
} from '../pipeline/projectMatcher';
import { Task, TaskChain, DoneMessage } from '../pipeline/projectDispatcher';

// Test fixtures
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
          name: 'Backend API',
          terminal: 'backend',
          status: 'done',
          blocked_by: [],
          triggers_on_done: ['TASK-002'],
          msg_id: 'MSG-BACKEND-001',
          completed_at: '2026-06-22T10:00:00Z',
        },
        {
          id: 'TASK-002',
          name: 'Frontend UI',
          terminal: 'frontend',
          status: 'in_progress',
          blocked_by: ['TASK-001'],
          triggers_on_done: ['TASK-003'],
          msg_id: 'MSG-FRONTEND-001',
        },
        {
          id: 'TASK-003',
          name: 'Integration Tests',
          terminal: 'backend',
          status: 'pending',
          blocked_by: ['TASK-001', 'TASK-002'],
          triggers_on_done: [],
        },
      ],
    },
    {
      id: 'M2',
      name: 'Phase 2',
      status: 'pending',
      blocked_by: ['M1'],
      tasks: [
        {
          id: 'TASK-004',
          name: 'Deploy to staging',
          terminal: 'conductor',
          status: 'blocked',
          blocked_by: ['TASK-003'],
          triggers_on_done: [],
        },
      ],
    },
  ],
});

const createTestDoneMessage = (overrides?: Partial<DoneMessage>): DoneMessage => ({
  from: 'backend',
  task_id: 'MSG-BACKEND-001',
  timestamp: new Date('2026-06-22T10:00:00Z'),
  filePath: '/opt/spaceos/terminals/backend/outbox/2026-06-22_001_done.md',
  content: 'DONE message content',
  ...overrides,
});

describe('Project Matcher', () => {
  describe('matchDoneToTask', () => {
    it('should match by exact msg_id', () => {
      const tasks = createTestTaskChain();
      const done = createTestDoneMessage({
        task_id: 'MSG-BACKEND-001',
        from: 'backend',
      });

      const result = matchDoneToTask(tasks, done);

      expect(result).toBeDefined();
      expect(result?.id).toBe('TASK-001');
      expect(result?.msg_id).toBe('MSG-BACKEND-001');
    });

    it('should match by ref field', () => {
      const tasks = createTestTaskChain();
      const done = createTestDoneMessage({
        task_id: 'MSG-BACKEND-002',
        ref: 'MSG-BACKEND-001',
        from: 'backend',
      });

      const result = matchDoneToTask(tasks, done);

      expect(result).toBeDefined();
      expect(result?.id).toBe('TASK-001');
    });

    it('should fuzzy match by terminal and in_progress status', () => {
      const tasks = createTestTaskChain();
      const done = createTestDoneMessage({
        task_id: 'MSG-FRONTEND-999',  // Unknown msg_id
        from: 'frontend',
      });

      const result = matchDoneToTask(tasks, done);

      expect(result).toBeDefined();
      expect(result?.id).toBe('TASK-002');
      expect(result?.terminal).toBe('frontend');
      expect(result?.status).toBe('in_progress');
    });

    it('should return null when no match found', () => {
      const tasks = createTestTaskChain();
      const done = createTestDoneMessage({
        task_id: 'MSG-UNKNOWN-999',
        from: 'unknown-terminal',
      });

      const result = matchDoneToTask(tasks, done);

      expect(result).toBeNull();
    });
  });

  describe('matchDoneToTaskStrict', () => {
    it('should validate status when requireInProgress is true', () => {
      const tasks = createTestTaskChain();
      const done = createTestDoneMessage({
        task_id: 'MSG-BACKEND-001',
        from: 'backend',
      });

      // TASK-001 is 'done', not 'in_progress'
      const result = matchDoneToTaskStrict(tasks, done, {
        requireInProgress: true,
      });

      expect(result).toBeNull();
    });

    it('should match when requireInProgress is false', () => {
      const tasks = createTestTaskChain();
      const done = createTestDoneMessage({
        task_id: 'MSG-BACKEND-001',
        from: 'backend',
      });

      const result = matchDoneToTaskStrict(tasks, done, {
        requireInProgress: false,
      });

      expect(result).toBeDefined();
      expect(result?.id).toBe('TASK-001');
    });

    it('should skip fuzzy match when allowFuzzy is false', () => {
      const tasks = createTestTaskChain();
      const done = createTestDoneMessage({
        task_id: 'MSG-FRONTEND-999',
        from: 'frontend',
      });

      const result = matchDoneToTaskStrict(tasks, done, {
        allowFuzzy: false,
      });

      expect(result).toBeNull();
    });
  });

  describe('findTasksByTerminal', () => {
    it('should find all tasks for a terminal', () => {
      const tasks = createTestTaskChain();
      const backendTasks = findTasksByTerminal(tasks, 'backend');

      expect(backendTasks.length).toBe(2);
      expect(backendTasks[0].id).toBe('TASK-001');
      expect(backendTasks[1].id).toBe('TASK-003');
    });

    it('should return empty array for terminal with no tasks', () => {
      const tasks = createTestTaskChain();
      const result = findTasksByTerminal(tasks, 'non-existent-terminal');

      expect(result.length).toBe(0);
    });
  });

  describe('findTasksByStatus', () => {
    it('should find all tasks with a specific status', () => {
      const tasks = createTestTaskChain();
      const pendingTasks = findTasksByStatus(tasks, 'pending');

      expect(pendingTasks.length).toBe(1);
      expect(pendingTasks[0].id).toBe('TASK-003');
    });

    it('should find multiple tasks with same status', () => {
      const tasks = createTestTaskChain();
      const inProgressTasks = findTasksByStatus(tasks, 'in_progress');

      expect(inProgressTasks.length).toBe(1);
      expect(inProgressTasks[0].id).toBe('TASK-002');
    });
  });

  describe('findTaskById', () => {
    it('should find task by ID', () => {
      const tasks = createTestTaskChain();
      const task = findTaskById(tasks, 'TASK-002');

      expect(task).toBeDefined();
      expect(task?.name).toBe('Frontend UI');
      expect(task?.terminal).toBe('frontend');
    });

    it('should return null for non-existent task', () => {
      const tasks = createTestTaskChain();
      const task = findTaskById(tasks, 'TASK-999');

      expect(task).toBeNull();
    });
  });

  describe('isTaskUnblocked', () => {
    it('should return true when all blockers are done', () => {
      const tasks = createTestTaskChain();
      const task = findTaskById(tasks, 'TASK-002');

      expect(task).toBeDefined();
      const result = isTaskUnblocked(tasks, task!);

      // TASK-002 is blocked by TASK-001, which is done
      expect(result).toBe(true);
    });

    it('should return false when some blockers are not done', () => {
      const tasks = createTestTaskChain();
      const task = findTaskById(tasks, 'TASK-003');

      expect(task).toBeDefined();
      const result = isTaskUnblocked(tasks, task!);

      // TASK-003 is blocked by TASK-001 (done) and TASK-002 (in_progress)
      expect(result).toBe(false);
    });

    it('should return true when task has no blockers', () => {
      const tasks = createTestTaskChain();
      const task = findTaskById(tasks, 'TASK-001');

      expect(task).toBeDefined();
      const result = isTaskUnblocked(tasks, task!);

      expect(result).toBe(true);
    });
  });

  describe('getTasksUnblockedBy', () => {
    it('should return tasks that would be unblocked', () => {
      const tasks = createTestTaskChain();

      // Mark TASK-002 as done
      const task2 = findTaskById(tasks, 'TASK-002');
      if (task2) task2.status = 'done';

      // Now TASK-003 should be unblocked
      const unblocked = getTasksUnblockedBy(tasks, 'TASK-002');

      expect(unblocked.length).toBe(1);
      expect(unblocked[0].id).toBe('TASK-003');
    });

    it('should return empty array when no tasks are unblocked', () => {
      const tasks = createTestTaskChain();
      const unblocked = getTasksUnblockedBy(tasks, 'TASK-002');

      // TASK-002 is not done yet, so TASK-003 is still blocked by both
      expect(unblocked.length).toBe(0);
    });
  });

  describe('validateTaskChain', () => {
    it('should validate correct task chain', () => {
      const tasks = createTestTaskChain();
      const result = validateTaskChain(tasks);

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should detect self-blocking task', () => {
      const tasks = createTestTaskChain();

      // Add self-blocking task
      tasks.milestones[0].tasks.push({
        id: 'TASK-SELF-BLOCK',
        name: 'Self Blocking Task',
        terminal: 'backend',
        status: 'pending',
        blocked_by: ['TASK-SELF-BLOCK'],  // Self-blocking
        triggers_on_done: [],
      });

      const result = validateTaskChain(tasks);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('blocks itself');
    });

    it('should detect non-existent blocker', () => {
      const tasks = createTestTaskChain();

      // Add task with non-existent blocker
      tasks.milestones[0].tasks.push({
        id: 'TASK-BAD-BLOCKER',
        name: 'Bad Blocker Task',
        terminal: 'backend',
        status: 'pending',
        blocked_by: ['TASK-NON-EXISTENT'],
        triggers_on_done: [],
      });

      const result = validateTaskChain(tasks);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('non-existent task');
    });

    it('should detect non-existent trigger', () => {
      const tasks = createTestTaskChain();

      // Add task with non-existent trigger
      tasks.milestones[0].tasks.push({
        id: 'TASK-BAD-TRIGGER',
        name: 'Bad Trigger Task',
        terminal: 'backend',
        status: 'pending',
        blocked_by: [],
        triggers_on_done: ['TASK-NON-EXISTENT'],
      });

      const result = validateTaskChain(tasks);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('triggers non-existent task');
    });
  });
});
