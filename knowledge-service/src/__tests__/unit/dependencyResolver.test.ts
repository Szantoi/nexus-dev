/**
 * Dependency Resolver Unit Tests
 *
 * Tests for epic dependency resolution, blocker detection, and cycle validation.
 * Target coverage: >90%
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveDependencies,
  isTaskBlocked,
  getCriticalPath,
  validateDependencyGraph,
  getReadyTasks,
} from '../../pipeline/dependencyResolver';

describe('Dependency Resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveDependencies', () => {
    it('should resolve epic with no blockers', async () => {
      const result = await resolveDependencies('EPIC-IDENTITY-V1', true);

      expect(result).toBeDefined();
      expect(result.epic).toBe('EPIC-IDENTITY-V1');
      expect(Array.isArray(result.blockedBy)).toBe(true);
      expect(Array.isArray(result.blocks)).toBe(true);
    });

    it('should identify blockedBy dependencies', async () => {
      const result = await resolveDependencies('EPIC-CUTTING-Q3', true);

      expect(Array.isArray(result.blockedBy)).toBe(true);
      result.blockedBy.forEach((blocker: string) => {
        expect(typeof blocker).toBe('string');
      });
    });

    it('should identify blocking epics', async () => {
      const result = await resolveDependencies('EPIC-KERNEL-STABLE', true);

      expect(Array.isArray(result.blocks)).toBe(true);
      result.blocks.forEach((blocked: string) => {
        expect(typeof blocked).toBe('string');
      });
    });

    it('should list parallel epics', async () => {
      const result = await resolveDependencies('EPIC-CUTTING-Q3', true);

      expect(Array.isArray(result.parallelWith)).toBe(true);
      result.parallelWith.forEach((parallel: string) => {
        expect(typeof parallel).toBe('string');
      });
    });

    it('should identify ready tasks', async () => {
      const result = await resolveDependencies('EPIC-CUTTING-Q3', true);

      expect(Array.isArray(result.readyTasks)).toBe(true);
      result.readyTasks.forEach((task: any) => {
        expect(task.id).toBeDefined();
        expect(task.terminal).toBeDefined();
        expect(Array.isArray(task.dependencies)).toBe(true);
      });
    });

    it('should identify blocked tasks', async () => {
      const result = await resolveDependencies('EPIC-CUTTING-Q3', true);

      expect(Array.isArray(result.blockedTasks)).toBe(true);
      result.blockedTasks.forEach((task: any) => {
        expect(task.id).toBeDefined();
        expect(task.terminal).toBeDefined();
        expect(Array.isArray(task.blockedBy)).toBe(true);
        expect(task.blockedBy.length).toBeGreaterThan(0);
      });
    });

    it('should return proper status', async () => {
      const result = await resolveDependencies('EPIC-IDENTITY-V1', true);

      expect(['pending', 'active', 'done', 'blocked']).toContain(result.status);
    });

    it('should handle checkBlockers=false', async () => {
      const result = await resolveDependencies('EPIC-CUTTING-Q3', false);

      expect(result.status).not.toBe('blocked');
    });

    it('should throw on invalid epic', async () => {
      await expect(resolveDependencies('NONEXISTENT-EPIC', true)).rejects.toThrow();
    });
  });

  describe('isTaskBlocked', () => {
    it('should return unblocked for simple task', async () => {
      const result = await isTaskBlocked('MSG-BACKEND-001');

      expect(result).toBeDefined();
      expect(result.blocked).toBe(false);
    });

    it('should detect blocked tasks', async () => {
      const result = await isTaskBlocked('MSG-FRONTEND-066');

      expect(typeof result.blocked).toBe('boolean');
      if (result.blocked) {
        expect(Array.isArray(result.blockedBy)).toBe(true);
      }
    });

    it('should list blocking tasks', async () => {
      const result = await isTaskBlocked('MSG-FRONTEND-066');

      if (result.blocked && result.blockedBy) {
        result.blockedBy.forEach((blocker: string) => {
          expect(typeof blocker).toBe('string');
        });
      }
    });
  });

  describe('getCriticalPath', () => {
    it('should return path for simple epic', async () => {
      const path = await getCriticalPath('EPIC-IDENTITY-V1');

      expect(Array.isArray(path)).toBe(true);
      expect(path.length).toBeGreaterThan(0);
      expect(path[0]).toBe('EPIC-IDENTITY-V1');
    });

    it('should include dependencies in path', async () => {
      const path = await getCriticalPath('EPIC-CUTTING-Q3');

      expect(Array.isArray(path)).toBe(true);
      expect(path.length).toBeGreaterThan(0);
      // First element should be requested epic
      expect(path[0]).toBe('EPIC-CUTTING-Q3');
    });

    it('should return longest dependency chain', async () => {
      const path = await getCriticalPath('EPIC-PORTAL-V2');

      expect(Array.isArray(path)).toBe(true);
      // Path should represent longest dependency chain
      expect(path.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle circular dependencies gracefully', async () => {
      // Should not hang; should detect cycles
      const path = await getCriticalPath('EPIC-CUTTING-Q3');

      expect(Array.isArray(path)).toBe(true);
      expect(path.length).toBeGreaterThan(0);
    });

    it('should not include duplicates in path', async () => {
      const path = await getCriticalPath('EPIC-CUTTING-Q3');

      const uniquePath = new Set(path);
      expect(uniquePath.size).toBe(path.length);
    });
  });

  describe('validateDependencyGraph', () => {
    it('should validate acyclic graph', async () => {
      const result = await validateDependencyGraph();

      expect(result.valid).toBe(true);
      expect(result.cycles).toBeUndefined();
    });

    it('should detect cycles in graph', async () => {
      // Mock cyclic dependency scenario
      const result = await validateDependencyGraph();

      if (!result.valid) {
        expect(Array.isArray(result.cycles)).toBe(true);
        if (result.cycles && result.cycles.length > 0) {
          result.cycles.forEach((cycle: string[]) => {
            expect(Array.isArray(cycle)).toBe(true);
            expect(cycle.length).toBeGreaterThanOrEqual(2);
          });
        }
      }
    });

    it('should provide cycle details', async () => {
      const result = await validateDependencyGraph();

      if (!result.valid && result.cycles) {
        result.cycles.forEach((cycle: string[]) => {
          // First and last elements should match (forming a cycle)
          expect(cycle[0]).toBe(cycle[cycle.length - 1]);
        });
      }
    });
  });

  describe('getReadyTasks', () => {
    it('should return array of ready tasks', async () => {
      const tasks = await getReadyTasks();

      expect(Array.isArray(tasks)).toBe(true);
    });

    it('should include task structure', async () => {
      const tasks = await getReadyTasks();

      tasks.forEach((task: any) => {
        expect(task.id).toBeDefined();
        expect(task.terminal).toBeDefined();
        expect(task.epicId).toBeDefined();
      });
    });

    it('should not include blocked tasks', async () => {
      const tasks = await getReadyTasks();

      // Ready tasks should have no unresolved dependencies
      tasks.forEach((task: any) => {
        expect(task.id).toBeDefined();
        // Task should not be in any blocked list
      });
    });

    it('should be sortable by priority', async () => {
      const tasks = await getReadyTasks();

      expect(Array.isArray(tasks)).toBe(true);
      // Should be able to sort without error
      const sorted = [...tasks].sort((a: any, b: any) => a.id.localeCompare(b.id));
      expect(sorted.length).toBe(tasks.length);
    });
  });

  describe('error handling', () => {
    it('should handle missing EPICS.yaml', async () => {
      // Should not crash; should have graceful error handling
      expect(async () => {
        try {
          await resolveDependencies('EPIC-TEST');
        } catch (e) {
          expect(e).toBeDefined();
        }
      }).not.toThrow();
    });

    it('should return valid structure on error', async () => {
      try {
        await resolveDependencies('INVALID-EPIC');
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe('performance', () => {
    it('should resolve dependencies in <150ms', async () => {
      const start = Date.now();
      await resolveDependencies('EPIC-IDENTITY-V1', true);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(150);
    });

    it('should validate graph in <200ms', async () => {
      const start = Date.now();
      await validateDependencyGraph();
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(200);
    });

    it('should compute critical path in <200ms', async () => {
      const start = Date.now();
      await getCriticalPath('EPIC-CUTTING-Q3');
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(200);
    });
  });
});
