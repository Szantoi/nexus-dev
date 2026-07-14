/**
 * Unit tests for Cost Limiter (ADR-049 Phase 3)
 * Tests cost calculations, alert levels, and max parallel limits
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCostState,
  getCurrentHourlyCost,
  calculateMaxParallel,
  checkCostAlerts,
  getModelCostPerMinute,
  estimateTaskCost,
  canSpawnWorker,
  getCostAlertMessage,
  SOFT_LIMIT_PER_HOUR,
  HARD_LIMIT_PER_HOUR,
  CRITICAL_LIMIT_PER_HOUR,
  HARD_MAX_PARALLEL,
  type CostState,
} from '../pipeline/costLimiter';
import {
  registerWorker,
  clearRegistry,
  markWorkerDone,
  type WorkSessionConfig,
} from '../pipeline/workerRegistry';

describe('Cost Limiter', () => {
  beforeEach(() => {
    // Clear worker registry before each test
    clearRegistry();
  });

  describe('getModelCostPerMinute', () => {
    it('should return correct cost for haiku', () => {
      expect(getModelCostPerMinute('haiku')).toBe(0.002);
    });

    it('should return correct cost for sonnet', () => {
      expect(getModelCostPerMinute('sonnet')).toBe(0.02);
    });

    it('should return correct cost for opus', () => {
      expect(getModelCostPerMinute('opus')).toBe(0.1);
    });

    it('should default to sonnet for unknown model', () => {
      expect(getModelCostPerMinute('unknown')).toBe(0.02);
    });
  });

  describe('estimateTaskCost', () => {
    it('should calculate cost correctly for haiku (10 minutes)', () => {
      const cost = estimateTaskCost('haiku', 10);
      expect(cost).toBe(0.02); // 0.002 * 10
    });

    it('should calculate cost correctly for sonnet (20 minutes)', () => {
      const cost = estimateTaskCost('sonnet', 20);
      expect(cost).toBe(0.40); // 0.02 * 20
    });

    it('should calculate cost correctly for opus (5 minutes)', () => {
      const cost = estimateTaskCost('opus', 5);
      expect(cost).toBe(0.50); // 0.1 * 5
    });
  });

  describe('getCurrentHourlyCost', () => {
    it('should return 0 for terminal with no workers', () => {
      const cost = getCurrentHourlyCost('backend');
      expect(cost).toBe(0);
    });

    it('should calculate cost for single running worker', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };
      registerWorker('work-001', config, 'spaceos-backend-work-001');

      const cost = getCurrentHourlyCost('backend');

      // Sonnet = 0.02/min * 60 min = 1.20/hour
      expect(cost).toBe(1.20);
    });

    it('should calculate cost for multiple running workers', () => {
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'haiku',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'sonnet',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');

      const cost = getCurrentHourlyCost('backend');

      // Haiku = 0.002/min * 60 = 0.12
      // Sonnet = 0.02/min * 60 = 1.20
      // Total = 1.32/hour
      expect(cost).toBeCloseTo(1.32, 2);
    });

    it('should not count completed workers', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'sonnet',
      };
      registerWorker('work-001', config, 'spaceos-backend-work-001');
      markWorkerDone('work-001');

      const cost = getCurrentHourlyCost('backend');

      expect(cost).toBe(0);
    });
  });

  describe('checkCostAlerts', () => {
    it('should return "ok" when cost is below soft limit', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'haiku',
      };
      registerWorker('work-001', config, 'spaceos-backend-work-001');

      const alert = checkCostAlerts('backend');

      expect(alert).toBe('ok');
    });

    it('should return "soft" when cost is at soft limit', () => {
      // Soft limit = 3/hour
      // 3 Sonnet = 3 * 1.20 = 3.60/hour → soft alert (>= 3 but < 5)

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
        model: 'sonnet',
      };
      const config3: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-3',
        prompt: 'Test task 3',
        model: 'sonnet',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');
      registerWorker('work-003', config3, 'spaceos-backend-work-003');

      const alert = checkCostAlerts('backend');

      expect(alert).toBe('soft');
    });

    it('should return "hard" when cost is at hard limit', () => {
      // Hard limit = 5/hour
      // 5 Sonnet = 5 * 1.20 = 6.00/hour → hard alert (>= 5 but < 10)
      for (let i = 0; i < 5; i++) {
        const config: WorkSessionConfig = {
          terminal: 'backend',
          taskId: `task-${i}`,
          prompt: 'Test task',
          model: 'sonnet',
        };
        registerWorker(`work-${String(i + 1).padStart(3, '0')}`, config, `spaceos-backend-work-${String(i + 1).padStart(3, '0')}`);
      }

      const alert = checkCostAlerts('backend');

      expect(alert).toBe('hard');
    });

    it('should return "critical" when cost is at critical limit', () => {
      // Critical limit = 10/hour
      // 2 Opus = 2 * 6.00 = 12.00/hour → critical alert (>= 10)
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'opus',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'opus',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');

      const alert = checkCostAlerts('backend');

      expect(alert).toBe('critical');
    });
  });

  describe('calculateMaxParallel', () => {
    it('should return HARD_MAX_PARALLEL when no workers running', () => {
      const max = calculateMaxParallel('backend');
      expect(max).toBe(HARD_MAX_PARALLEL);
    });

    it('should reduce max parallel when cost is above soft limit', () => {
      // 2 Opus = 2 * 6.00 = 12.00/hour → critical → max should be reduced
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'opus',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'opus',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');

      const max = calculateMaxParallel('backend');

      expect(max).toBeLessThan(HARD_MAX_PARALLEL);
    });

    it('should never allow more than HARD_MAX_PARALLEL', () => {
      const max = calculateMaxParallel('backend');
      expect(max).toBeLessThanOrEqual(HARD_MAX_PARALLEL);
    });

    it('should return at least 1', () => {
      const max = calculateMaxParallel('backend');
      expect(max).toBeGreaterThanOrEqual(1);
    });
  });

  describe('canSpawnWorker', () => {
    it('should allow spawn when no workers running', () => {
      const result = canSpawnWorker('backend', 'haiku');

      expect(result.allowed).toBe(true);
    });

    it('should block spawn when at HARD_MAX_PARALLEL', () => {
      // Register HARD_MAX_PARALLEL workers
      for (let i = 0; i < HARD_MAX_PARALLEL; i++) {
        const config: WorkSessionConfig = {
          terminal: 'backend',
          taskId: `task-${i}`,
          prompt: 'Test task',
          model: 'haiku',
        };
        registerWorker(`work-${String(i + 1).padStart(3, '0')}`, config, `spaceos-backend-work-${String(i + 1).padStart(3, '0')}`);
      }

      const result = canSpawnWorker('backend', 'haiku');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('max parallel');
    });

    it('should block spawn when estimated cost exceeds limit', () => {
      // Register 2 opus workers: 2 * 6.00 = 12.00/hour (already critical)
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'opus',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'opus',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');

      // Try to spawn another opus (would add 6.00/hour, total 18/hour)
      const result = canSpawnWorker('backend', 'opus');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cost');
    });

    it('should allow spawn when cost is under soft limit', () => {
      const config: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task',
        model: 'haiku',
      };
      registerWorker('work-001', config, 'spaceos-backend-work-001');

      const result = canSpawnWorker('backend', 'haiku');

      expect(result.allowed).toBe(true);
    });
  });

  describe('getCostAlertMessage', () => {
    it('should return null when cost is ok', () => {
      const message = getCostAlertMessage('backend');
      expect(message).toBeNull();
    });

    it('should return message when cost is at soft limit', () => {
      // 3 Sonnet = 3 * 1.20 = 3.60/hour → soft alert
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
        model: 'sonnet',
      };
      const config3: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-3',
        prompt: 'Test task 3',
        model: 'sonnet',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');
      registerWorker('work-003', config3, 'spaceos-backend-work-003');

      const message = getCostAlertMessage('backend');

      expect(message).not.toBeNull();
      expect(message).toContain('Soft limit');
    });

    it('should return message when cost is at hard limit', () => {
      // 5 Sonnet = 5 * 1.20 = 6.00/hour → hard alert
      for (let i = 0; i < 5; i++) {
        const config: WorkSessionConfig = {
          terminal: 'backend',
          taskId: `task-${i}`,
          prompt: 'Test task',
          model: 'sonnet',
        };
        registerWorker(`work-${String(i + 1).padStart(3, '0')}`, config, `spaceos-backend-work-${String(i + 1).padStart(3, '0')}`);
      }

      const message = getCostAlertMessage('backend');

      expect(message).not.toBeNull();
      expect(message).toContain('Hard limit');
    });

    it('should return message when cost is at critical limit', () => {
      // 2 Opus = 2 * 6.00 = 12.00/hour → critical alert
      const config1: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-1',
        prompt: 'Test task 1',
        model: 'opus',
      };
      const config2: WorkSessionConfig = {
        terminal: 'backend',
        taskId: 'task-2',
        prompt: 'Test task 2',
        model: 'opus',
      };

      registerWorker('work-001', config1, 'spaceos-backend-work-001');
      registerWorker('work-002', config2, 'spaceos-backend-work-002');

      const message = getCostAlertMessage('backend');

      expect(message).not.toBeNull();
      expect(message).toContain('CRITICAL');
    });
  });
});
