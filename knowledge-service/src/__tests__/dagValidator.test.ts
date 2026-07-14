/**
 * Unit tests for DAG Validator (ADR-049 Phase 3)
 * Tests Kahn's algorithm for cycle detection and parallel batch generation
 */

import { describe, it, expect } from 'vitest';
import {
  validateDependencies,
  getParallelBatches,
  getMaxParallelWidth,
  canTaskStart,
  type WorkTask,
} from '../pipeline/dagValidator';

describe('DAG Validator', () => {
  describe('validateDependencies', () => {
    it('should accept valid acyclic graph', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: ['A'] },
        { id: 'C', depends_on: ['A'] },
        { id: 'D', depends_on: ['B', 'C'] },
      ];

      const result = validateDependencies(tasks);

      expect(result.valid).toBe(true);
      expect(result.executionOrder).toEqual(['A', 'B', 'C', 'D']);
    });

    it('should detect simple cycle (A → B → A)', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: ['B'] },
        { id: 'B', depends_on: ['A'] },
      ];

      const result = validateDependencies(tasks);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Circular dependency');
    });

    it('should detect self-dependency (A → A)', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: ['A'] },
      ];

      const result = validateDependencies(tasks);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Circular dependency');
    });

    it('should detect complex cycle (A → B → C → A)', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: ['C'] },
        { id: 'B', depends_on: ['A'] },
        { id: 'C', depends_on: ['B'] },
      ];

      const result = validateDependencies(tasks);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Circular dependency');
    });

    it('should accept diamond dependency graph', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: ['A'] },
        { id: 'C', depends_on: ['A'] },
        { id: 'D', depends_on: ['B', 'C'] },
      ];

      const result = validateDependencies(tasks);

      expect(result.valid).toBe(true);
      expect(result.executionOrder).toEqual(['A', 'B', 'C', 'D']);
    });

    it('should reject missing dependency', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: ['MISSING'] },
      ];

      const result = validateDependencies(tasks);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Dependency not found');
    });

    it('should accept multiple independent tasks', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: [] },
        { id: 'C', depends_on: [] },
      ];

      const result = validateDependencies(tasks);

      expect(result.valid).toBe(true);
      expect(result.executionOrder).toHaveLength(3);
      expect(result.executionOrder).toContain('A');
      expect(result.executionOrder).toContain('B');
      expect(result.executionOrder).toContain('C');
    });
  });

  describe('getParallelBatches', () => {
    it('should return single batch for independent tasks', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: [] },
        { id: 'C', depends_on: [] },
      ];

      const batches = getParallelBatches(tasks);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
      expect(batches[0]).toContain('A');
      expect(batches[0]).toContain('B');
      expect(batches[0]).toContain('C');
    });

    it('should return sequential batches for linear dependency', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: ['A'] },
        { id: 'C', depends_on: ['B'] },
      ];

      const batches = getParallelBatches(tasks);

      expect(batches).toHaveLength(3);
      expect(batches[0]).toEqual(['A']);
      expect(batches[1]).toEqual(['B']);
      expect(batches[2]).toEqual(['C']);
    });

    it('should return 3 batches for diamond graph', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: ['A'] },
        { id: 'C', depends_on: ['A'] },
        { id: 'D', depends_on: ['B', 'C'] },
      ];

      const batches = getParallelBatches(tasks);

      expect(batches).toHaveLength(3);
      expect(batches[0]).toEqual(['A']);
      expect(batches[1]).toHaveLength(2);
      expect(batches[1]).toContain('B');
      expect(batches[1]).toContain('C');
      expect(batches[2]).toEqual(['D']);
    });

    it('should handle complex graph with multiple parallelizable tasks', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: [] },
        { id: 'C', depends_on: ['A'] },
        { id: 'D', depends_on: ['B'] },
        { id: 'E', depends_on: ['C', 'D'] },
      ];

      const batches = getParallelBatches(tasks);

      expect(batches).toHaveLength(3);
      expect(batches[0]).toHaveLength(2); // A, B
      expect(batches[1]).toHaveLength(2); // C, D
      expect(batches[2]).toEqual(['E']);
    });
  });

  describe('getMaxParallelWidth', () => {
    it('should return 1 for linear dependency', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: ['A'] },
        { id: 'C', depends_on: ['B'] },
      ];

      const width = getMaxParallelWidth(tasks);

      expect(width).toBe(1);
    });

    it('should return 3 for 3 independent tasks', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: [] },
        { id: 'C', depends_on: [] },
      ];

      const width = getMaxParallelWidth(tasks);

      expect(width).toBe(3);
    });

    it('should return 2 for diamond graph (B and C can run in parallel)', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: ['A'] },
        { id: 'C', depends_on: ['A'] },
        { id: 'D', depends_on: ['B', 'C'] },
      ];

      const width = getMaxParallelWidth(tasks);

      expect(width).toBe(2);
    });
  });

  describe('canTaskStart', () => {
    it('should return true if no dependencies', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
      ];

      const result = canTaskStart('A', tasks, []);

      expect(result).toBe(true);
    });

    it('should return true if all dependencies completed', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: ['A'] },
      ];

      const result = canTaskStart('B', tasks, ['A']);

      expect(result).toBe(true);
    });

    it('should return false if some dependencies not completed', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: [] },
        { id: 'C', depends_on: ['A', 'B'] },
      ];

      const result = canTaskStart('C', tasks, ['A']); // B not completed

      expect(result).toBe(false);
    });

    it('should return false if no dependencies completed', () => {
      const tasks: WorkTask[] = [
        { id: 'A', depends_on: [] },
        { id: 'B', depends_on: ['A'] },
      ];

      const result = canTaskStart('B', tasks, []);

      expect(result).toBe(false);
    });
  });
});
