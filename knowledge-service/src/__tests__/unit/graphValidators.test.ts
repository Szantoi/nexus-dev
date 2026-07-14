/**
 * Unit tests for graph validators
 *
 * Tests status transitions, done preconditions, and self-reference checks
 */

import { describe, it, expect } from 'vitest';
import {
  isValidStatusTransition,
  validateDonePrecondition,
  validateNoSelfReference,
} from '../../graph/validators';
import type { EpicDependency } from '../../graph/types';

describe('isValidStatusTransition', () => {
  describe('valid transitions', () => {
    it('should allow pending → active', () => {
      const result = isValidStatusTransition('pending', 'active');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow pending → blocked', () => {
      const result = isValidStatusTransition('pending', 'blocked');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow active → done', () => {
      const result = isValidStatusTransition('active', 'done');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow active → blocked', () => {
      const result = isValidStatusTransition('active', 'blocked');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow blocked → active (retry)', () => {
      const result = isValidStatusTransition('blocked', 'active');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow same status (no-op)', () => {
      const result = isValidStatusTransition('active', 'active');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('invalid transitions', () => {
    it('should reject done → pending', () => {
      const result = isValidStatusTransition('done', 'pending');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Cannot transition from done to pending');
    });

    it('should reject done → active', () => {
      const result = isValidStatusTransition('done', 'active');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Cannot transition from done to active');
    });

    it('should reject done → blocked', () => {
      const result = isValidStatusTransition('done', 'blocked');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Cannot transition from done to blocked');
    });

    it('should reject pending → done (skip active)', () => {
      const result = isValidStatusTransition('pending', 'done');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Cannot transition from pending to done');
    });

    it('should reject blocked → done', () => {
      const result = isValidStatusTransition('blocked', 'done');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Cannot transition from blocked to done');
    });

    it('should reject blocked → pending', () => {
      const result = isValidStatusTransition('blocked', 'pending');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Cannot transition from blocked to pending');
    });

    it('should reject active → pending', () => {
      const result = isValidStatusTransition('active', 'pending');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Cannot transition from active to pending');
    });
  });
});

describe('validateDonePrecondition', () => {
  it('should allow done status when no dependencies', () => {
    const epic: EpicDependency = {
      id: 'EPIC-A',
      name: 'Epic A',
      status: 'active',
      depends_on: [],
    };

    const result = validateDonePrecondition(epic, [epic]);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should allow done status when all dependencies are done', () => {
    const epics: EpicDependency[] = [
      {
        id: 'EPIC-A',
        name: 'Epic A',
        status: 'done',
        depends_on: [],
      },
      {
        id: 'EPIC-B',
        name: 'Epic B',
        status: 'done',
        depends_on: [],
      },
      {
        id: 'EPIC-C',
        name: 'Epic C',
        status: 'active',
        depends_on: ['EPIC-A', 'EPIC-B'],
      },
    ];

    const result = validateDonePrecondition(epics[2], epics);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject done status when some dependencies are active', () => {
    const epics: EpicDependency[] = [
      {
        id: 'EPIC-A',
        name: 'Epic A',
        status: 'done',
        depends_on: [],
      },
      {
        id: 'EPIC-B',
        name: 'Epic B',
        status: 'active', // NOT done
        depends_on: [],
      },
      {
        id: 'EPIC-C',
        name: 'Epic C',
        status: 'active',
        depends_on: ['EPIC-A', 'EPIC-B'],
      },
    ];

    const result = validateDonePrecondition(epics[2], epics);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('dependencies not complete');
    expect(result.error).toContain('EPIC-B');
    expect(result.blockingDeps).toEqual(['EPIC-B']);
  });

  it('should reject done status when all dependencies are pending', () => {
    const epics: EpicDependency[] = [
      {
        id: 'EPIC-A',
        name: 'Epic A',
        status: 'pending',
        depends_on: [],
      },
      {
        id: 'EPIC-B',
        name: 'Epic B',
        status: 'pending',
        depends_on: [],
      },
      {
        id: 'EPIC-C',
        name: 'Epic C',
        status: 'active',
        depends_on: ['EPIC-A', 'EPIC-B'],
      },
    ];

    const result = validateDonePrecondition(epics[2], epics);
    expect(result.valid).toBe(false);
    expect(result.blockingDeps).toEqual(['EPIC-A', 'EPIC-B']);
  });

  it('should reject done status when some dependencies are blocked', () => {
    const epics: EpicDependency[] = [
      {
        id: 'EPIC-A',
        name: 'Epic A',
        status: 'done',
        depends_on: [],
      },
      {
        id: 'EPIC-B',
        name: 'Epic B',
        status: 'blocked',
        depends_on: [],
      },
      {
        id: 'EPIC-C',
        name: 'Epic C',
        status: 'active',
        depends_on: ['EPIC-A', 'EPIC-B'],
      },
    ];

    const result = validateDonePrecondition(epics[2], epics);
    expect(result.valid).toBe(false);
    expect(result.blockingDeps).toEqual(['EPIC-B']);
  });

  it('should handle missing dependencies gracefully', () => {
    const epic: EpicDependency = {
      id: 'EPIC-A',
      name: 'Epic A',
      status: 'active',
      depends_on: ['EPIC-MISSING'],
    };

    // Should not crash on missing dependency
    const result = validateDonePrecondition(epic, [epic]);
    expect(result.valid).toBe(true); // No blocking deps found
  });
});

describe('validateNoSelfReference', () => {
  it('should allow dependencies that do not include self', () => {
    const result = validateNoSelfReference('EPIC-A', ['EPIC-B', 'EPIC-C']);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should allow empty dependencies', () => {
    const result = validateNoSelfReference('EPIC-A', []);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject dependencies that include self', () => {
    const result = validateNoSelfReference('EPIC-A', ['EPIC-A']);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Epic cannot depend on itself: EPIC-A');
  });

  it('should reject dependencies that include self among others', () => {
    const result = validateNoSelfReference('EPIC-B', [
      'EPIC-A',
      'EPIC-B',
      'EPIC-C',
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Epic cannot depend on itself: EPIC-B');
  });
});
