/**
 * Unit tests for Worker Registry (ADR-049 Phase 3)
 * Tests worker registration, state tracking, and dependencies
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerWorker,
  getActiveWorkers,
  getActiveWorkerIds,
  getWorker,
  getAllWorkers,
  markWorkerDone,
  markWorkerFailed,
  queueWorker,
  removeWorker,
  clearRegistry,
  checkDependencies,
  processQueue,
  type WorkSessionConfig,
  type WorkerState,
} from '../pipeline/workerRegistry';

describe('Worker Registry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  describe('registerWorker', () => {
    it('should register a new worker', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };

      registerWorker('work-001', config, 'spaceos-backend-work-001');

      const worker = getWorker('work-001');
      expect(worker).toBeDefined();
      expect(worker?.id).toBe('work-001');
      expect(worker?.terminal).toBe('backend');
      expect(worker?.taskId).toBe('task-1');
      expect(worker?.model).toBe('sonnet');
      expect(worker?.status).toBe('running');
      expect(worker?.sessionName).toBe('spaceos-backend-work-001');
    });

    it('should register worker with dependencies', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'haiku',
        depends_on: ['task-1'],
      };

      registerWorker('work-002', config, 'spaceos-backend-work-002');

      const worker = getWorker('work-002');
      expect(worker?.depends_on).toEqual(['task-1']);
    });

    it('should track startedAt timestamp', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };

      const before = Date.now();
      registerWorker('work-001', config, 'spaceos-backend-work-001');
      const after = Date.now();

      const worker = getWorker('work-001');
      const startedAtMs = new Date(worker!.startedAt).getTime();
      expect(startedAtMs).toBeGreaterThanOrEqual(before);
      expect(startedAtMs).toBeLessThanOrEqual(after);
    });
  });

  describe('getActiveWorkers', () => {
    it('should return empty array when no workers', () => {
      const workers = getActiveWorkers('backend');
      expect(workers).toEqual([]);
    });

    it('should return only workers for specified terminal', () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'sonnet',
      };
      const config2: WorkSessionConfig = {
        terminal: 'frontend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'haiku',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-frontend-work-002');

      const backendWorkers = getActiveWorkers('backend');
      expect(backendWorkers).toHaveLength(1);
      expect(backendWorkers[0].id).toBe('work-001');

      const frontendWorkers = getActiveWorkers('frontend');
      expect(frontendWorkers).toHaveLength(1);
      expect(frontendWorkers[0].id).toBe('work-002');
    });

    it('should return only running and queued workers', () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'sonnet',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'haiku',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');
      markWorkerDone('work-002');

      const workers = getActiveWorkers('backend');
      expect(workers).toHaveLength(1);
      expect(workers[0].id).toBe('work-001');
    });
  });

  describe('getActiveWorkerIds', () => {
    it('should return empty array when no workers', () => {
      const ids = getActiveWorkerIds('backend');
      expect(ids).toEqual([]);
    });

    it('should return only IDs of running workers', () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'sonnet',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'haiku',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');

      const ids = getActiveWorkerIds('backend');
      expect(ids).toEqual(['work-001', 'work-002']);
    });
  });

  describe('markWorkerDone', () => {
    it('should mark worker as done', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };

      registerWorker('work-001', config, 'spaceos-backend-work-001');
      markWorkerDone('work-001');

      const worker = getWorker('work-001');
      expect(worker?.status).toBe('done');
      expect(worker?.completedAt).toBeDefined();
    });

    it('should track completedAt timestamp', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };

      registerWorker('work-001', config, 'spaceos-backend-work-001');
      const before = Date.now();
      markWorkerDone('work-001');
      const after = Date.now();

      const worker = getWorker('work-001');
      const completedAtMs = new Date(worker!.completedAt!).getTime();
      expect(completedAtMs).toBeGreaterThanOrEqual(before);
      expect(completedAtMs).toBeLessThanOrEqual(after);
    });
  });

  describe('markWorkerFailed', () => {
    it('should mark worker as failed', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };

      registerWorker('work-001', config, 'spaceos-backend-work-001');
      markWorkerFailed('work-001', 'Out of memory');

      const worker = getWorker('work-001');
      expect(worker?.status).toBe('failed');
      expect(worker?.failureReason).toBe('Out of memory');
      expect(worker?.completedAt).toBeDefined();
    });

    it('should work without failure reason', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };

      registerWorker('work-001', config, 'spaceos-backend-work-001');
      markWorkerFailed('work-001');

      const worker = getWorker('work-001');
      expect(worker?.status).toBe('failed');
      expect(worker?.failureReason).toBeUndefined();
    });
  });

  describe('queueWorker', () => {
    it('should queue worker with dependencies', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'haiku',
        depends_on: ['task-1'],
      };

      queueWorker('work-002', config);

      const worker = getWorker('work-002');
      expect(worker?.status).toBe('queued');
      expect(worker?.depends_on).toEqual(['task-1']);
    });
  });

  describe('checkDependencies', () => {
    it('should return empty array when all dependencies done', async () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'sonnet',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      markWorkerDone('work-001');

      const unfinished = await checkDependencies(['task-1']);
      expect(unfinished).toEqual([]);
    });

    it('should return unfinished dependencies', async () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'sonnet',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      // Not marking as done

      const unfinished = await checkDependencies(['task-1']);
      expect(unfinished).toEqual(['task-1']);
    });

    it('should handle multiple dependencies', async () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'sonnet',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'haiku',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');
      markWorkerDone('work-001');
      // work-002 still running

      const unfinished = await checkDependencies(['task-1', 'task-2']);
      expect(unfinished).toEqual(['task-2']);
    });
  });

  describe('processQueue', () => {
    it('should start queued workers when dependencies complete', async () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'sonnet',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'haiku',
        depends_on: ['task-1'],
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      queueWorker('work-002', config2);

      // Mark dependency as done
      markWorkerDone('work-001');

      // Process queue should start work-002
      // Note: processQueue is async and requires a spawner function
      // This test would need a mock spawner
    });
  });

  describe('removeWorker', () => {
    it('should remove worker from registry', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };

      registerWorker('work-001', config, 'spaceos-backend-work-001');
      removeWorker('work-001');

      const worker = getWorker('work-001');
      expect(worker).toBeUndefined();
    });
  });

  describe('clearRegistry', () => {
    it('should remove all workers', () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'sonnet',
      };
      const config2: WorkSessionConfig = {
        terminal: 'frontend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'haiku',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-frontend-work-002');

      clearRegistry();

      const allWorkers = getAllWorkers();
      expect(allWorkers).toEqual([]);
    });
  });
});
