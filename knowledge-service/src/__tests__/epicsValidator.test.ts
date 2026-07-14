/**
 * EPICS Validator Tests (ADR-041 Phase 1 / TASK-001)
 *
 * Unit tests for EPICS.yaml validation logic:
 * - Schema validation (version, updated, epics array)
 * - Reference integrity (depends_on, parallel_with)
 * - Cycle detection (DAG validation)
 * - Epic field validation
 *
 * Target coverage: 80%+
 */

import { describe, it, expect } from 'vitest';
import { validateEpicsYaml, EpicsValidationResult } from '../pipeline/epicsValidator';
import { EpicsYaml, EpicDependency } from '../graph/types';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const createValidEpicsYaml = (): EpicsYaml => ({
  version: '1.0',
  updated: '2026-06-22',
  epics: [
    {
      id: 'EPIC-KERNEL',
      name: 'Kernel Module',
      project: 'spaceos/kernel',
      depends_on: [],
      status: 'done',
      target_date: '2026-04-30',
      tasks_yaml: 'spaceos/kernel/TASKS.yaml',
      description: 'Kernel foundation',
    },
    {
      id: 'EPIC-JOINERY',
      name: 'Joinery Module',
      project: 'spaceos/joinery',
      depends_on: ['EPIC-KERNEL'],
      parallel_with: ['EPIC-CUTTING'],
      status: 'active',
      target_date: '2026-05-15',
      tasks_yaml: 'spaceos/joinery/TASKS.yaml',
      description: 'Joinery implementation',
    },
    {
      id: 'EPIC-CUTTING',
      name: 'Cutting Module',
      project: 'spaceos/cutting',
      depends_on: ['EPIC-KERNEL'],
      parallel_with: ['EPIC-JOINERY'],
      status: 'pending',
      tasks_yaml: 'spaceos/cutting/TASKS.yaml',
    },
  ],
});

// ─── Happy Path Tests ───────────────────────────────────────────────────────

describe('epicsValidator - Happy Path', () => {
  it('should validate a correct EPICS.yaml', () => {
    const valid = createValidEpicsYaml();
    const result = validateEpicsYaml(valid);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should allow empty depends_on array', () => {
    const data = createValidEpicsYaml();
    data.epics[0].depends_on = [];

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(true);
  });

  it('should allow missing optional fields (description, target_date, parallel_with)', () => {
    const data = createValidEpicsYaml();
    delete data.epics[2].description;
    delete data.epics[2].target_date;
    delete data.epics[2].parallel_with;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(true);
    // Should have warnings for missing description
    const descWarnings = result.warnings.filter(w => w.code === 'E_MISSING_DESCRIPTION');
    expect(descWarnings.length).toBeGreaterThan(0);
  });

  it('should accept semantic version formats (X.Y and X.Y.Z)', () => {
    const data1 = createValidEpicsYaml();
    data1.version = '1.0';
    expect(validateEpicsYaml(data1).valid).toBe(true);

    const data2 = createValidEpicsYaml();
    data2.version = '1.0.1';
    expect(validateEpicsYaml(data2).valid).toBe(true);
  });
});

// ─── E1: Version Validation ─────────────────────────────────────────────────

describe('epicsValidator - E1: Version Validation', () => {
  it('should error when version is missing', () => {
    const data: any = createValidEpicsYaml();
    delete data.version;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E1_MISSING_VERSION',
      })
    );
  });

  it('should error when version is not a string', () => {
    const data: any = createValidEpicsYaml();
    data.version = 123;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E1_INVALID_VERSION_TYPE',
      })
    );
  });

  it('should warn when version format is invalid', () => {
    const data = createValidEpicsYaml();
    data.version = 'v1.0'; // Invalid format

    const result = validateEpicsYaml(data);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'E1_INVALID_VERSION_FORMAT',
      })
    );
  });
});

// ─── E2: Updated Field Validation ───────────────────────────────────────────

describe('epicsValidator - E2: Updated Field Validation', () => {
  it('should error when updated is missing', () => {
    const data: any = createValidEpicsYaml();
    delete data.updated;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E2_MISSING_UPDATED',
      })
    );
  });

  it('should error when updated is not a string', () => {
    const data: any = createValidEpicsYaml();
    data.updated = 20260622;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E2_INVALID_UPDATED_TYPE',
      })
    );
  });

  it('should error when updated has invalid date format', () => {
    const data = createValidEpicsYaml();
    data.updated = '22-06-2026'; // Wrong format

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E2_INVALID_DATE_FORMAT',
      })
    );
  });

  it('should error when updated is an invalid date', () => {
    const data = createValidEpicsYaml();
    data.updated = '2026-13-45'; // Invalid month/day

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E2_INVALID_DATE_FORMAT',
      })
    );
  });
});

// ─── E3: Epics Array Validation ─────────────────────────────────────────────

describe('epicsValidator - E3: Epics Array Validation', () => {
  it('should error when epics is missing', () => {
    const data: any = createValidEpicsYaml();
    delete data.epics;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E3_MISSING_EPICS',
      })
    );
  });

  it('should error when epics is not an array', () => {
    const data: any = createValidEpicsYaml();
    data.epics = { 'EPIC-1': {} };

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E3_INVALID_EPICS_TYPE',
      })
    );
  });

  it('should warn when epics array is empty', () => {
    const data = createValidEpicsYaml();
    data.epics = [];

    const result = validateEpicsYaml(data);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'E3_EMPTY_EPICS',
      })
    );
  });
});

// ─── E4: Unique Epic IDs ────────────────────────────────────────────────────

describe('epicsValidator - E4: Unique Epic IDs', () => {
  it('should error when epic id is missing', () => {
    const data: any = createValidEpicsYaml();
    delete data.epics[0].id;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E4_MISSING_ID',
      })
    );
  });

  it('should error when epic IDs are not unique', () => {
    const data = createValidEpicsYaml();
    data.epics[1].id = 'EPIC-KERNEL'; // Duplicate

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E4_DUPLICATE_ID',
        epic_id: 'EPIC-KERNEL',
      })
    );
  });
});

// ─── E5: depends_on Reference Integrity ─────────────────────────────────────

describe('epicsValidator - E5: depends_on Reference Integrity', () => {
  it('should error when depends_on references non-existent epic', () => {
    const data = createValidEpicsYaml();
    data.epics[1].depends_on = ['EPIC-KERNEL', 'EPIC-NONEXISTENT'];

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E5_MISSING_DEPENDENCY',
        message: expect.stringContaining('EPIC-NONEXISTENT'),
      })
    );
  });

  it('should error when epic depends on itself', () => {
    const data = createValidEpicsYaml();
    data.epics[1].depends_on = ['EPIC-JOINERY']; // Self-dependency

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E5_SELF_DEPENDENCY',
      })
    );
  });

  it('should error when depends_on is not an array', () => {
    const data: any = createValidEpicsYaml();
    data.epics[1].depends_on = 'EPIC-KERNEL';

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E_INVALID_DEPENDS_ON_TYPE',
      })
    );
  });

  it('should error when depends_on contains non-string value', () => {
    const data: any = createValidEpicsYaml();
    data.epics[1].depends_on = ['EPIC-KERNEL', 123];

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E5_INVALID_DEPENDENCY_TYPE',
      })
    );
  });
});

// ─── E6: parallel_with Reference Integrity ──────────────────────────────────

describe('epicsValidator - E6: parallel_with Reference Integrity', () => {
  it('should error when parallel_with references non-existent epic', () => {
    const data = createValidEpicsYaml();
    data.epics[1].parallel_with = ['EPIC-CUTTING', 'EPIC-GHOST'];

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E6_MISSING_PARALLEL',
        message: expect.stringContaining('EPIC-GHOST'),
      })
    );
  });

  it('should error when epic is parallel with itself', () => {
    const data = createValidEpicsYaml();
    data.epics[1].parallel_with = ['EPIC-JOINERY'];

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E6_SELF_PARALLEL',
      })
    );
  });

  it('should error when parallel_with is not an array', () => {
    const data: any = createValidEpicsYaml();
    data.epics[1].parallel_with = 'EPIC-CUTTING';

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E_INVALID_PARALLEL_WITH_TYPE',
      })
    );
  });
});

// ─── E7: Cycle Detection (DAG Validation) ───────────────────────────────────

describe('epicsValidator - E7: Cycle Detection', () => {
  it('should detect simple cycle (A → B → A)', () => {
    const data = createValidEpicsYaml();
    data.epics = [
      {
        id: 'EPIC-A',
        name: 'Epic A',
        project: 'test/a',
        depends_on: ['EPIC-B'],
        status: 'pending',
        tasks_yaml: 'test/a/TASKS.yaml',
      },
      {
        id: 'EPIC-B',
        name: 'Epic B',
        project: 'test/b',
        depends_on: ['EPIC-A'],
        status: 'pending',
        tasks_yaml: 'test/b/TASKS.yaml',
      },
    ];

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E7_CIRCULAR_DEPENDENCY',
      })
    );
    expect(result.cycles).toBeDefined();
    expect(result.cycles!.length).toBeGreaterThan(0);
  });

  it('should detect complex cycle (A → B → C → A)', () => {
    const data = createValidEpicsYaml();
    data.epics = [
      {
        id: 'EPIC-A',
        name: 'Epic A',
        project: 'test/a',
        depends_on: ['EPIC-C'],
        status: 'pending',
        tasks_yaml: 'test/a/TASKS.yaml',
      },
      {
        id: 'EPIC-B',
        name: 'Epic B',
        project: 'test/b',
        depends_on: ['EPIC-A'],
        status: 'pending',
        tasks_yaml: 'test/b/TASKS.yaml',
      },
      {
        id: 'EPIC-C',
        name: 'Epic C',
        project: 'test/c',
        depends_on: ['EPIC-B'],
        status: 'pending',
        tasks_yaml: 'test/c/TASKS.yaml',
      },
    ];

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E7_CIRCULAR_DEPENDENCY',
      })
    );
  });

  it('should pass when there are no cycles (valid DAG)', () => {
    const data = createValidEpicsYaml();
    // Already a valid DAG: KERNEL → JOINERY, KERNEL → CUTTING
    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(true);
    expect(result.cycles).toBeUndefined();
  });
});

// ─── E8: Status Validation ──────────────────────────────────────────────────

describe('epicsValidator - E8: Status Validation', () => {
  it('should error when status is invalid', () => {
    const data: any = createValidEpicsYaml();
    data.epics[0].status = 'completed'; // Invalid status

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E8_INVALID_STATUS',
      })
    );
  });

  it('should warn when status is missing', () => {
    const data: any = createValidEpicsYaml();
    delete data.epics[0].status;

    const result = validateEpicsYaml(data);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'E8_MISSING_STATUS',
      })
    );
  });

  it('should accept all valid statuses', () => {
    const validStatuses = ['pending', 'active', 'done', 'blocked'];

    for (const status of validStatuses) {
      const data = createValidEpicsYaml();
      data.epics[0].status = status as any;

      const result = validateEpicsYaml(data);
      const statusErrors = result.errors.filter(e => e.code === 'E8_INVALID_STATUS');
      expect(statusErrors).toHaveLength(0);
    }
  });
});

// ─── E9: Project Field Validation ───────────────────────────────────────────

describe('epicsValidator - E9: Project Field Validation', () => {
  it('should error when project is missing', () => {
    const data: any = createValidEpicsYaml();
    delete data.epics[0].project;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E9_MISSING_PROJECT',
      })
    );
  });

  it('should error when project is not a string', () => {
    const data: any = createValidEpicsYaml();
    data.epics[0].project = 123;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E9_INVALID_PROJECT_TYPE',
      })
    );
  });
});

// ─── E10: tasks_yaml Path Validation ────────────────────────────────────────

describe('epicsValidator - E10: tasks_yaml Path Validation', () => {
  it('should error when tasks_yaml is missing', () => {
    const data: any = createValidEpicsYaml();
    delete data.epics[0].tasks_yaml;

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E10_MISSING_TASKS_YAML',
      })
    );
  });

  it('should error when tasks_yaml is not a string', () => {
    const data: any = createValidEpicsYaml();
    data.epics[0].tasks_yaml = ['path/to/tasks.yaml'];

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E10_INVALID_TASKS_YAML_TYPE',
      })
    );
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('epicsValidator - Edge Cases', () => {
  it('should handle invalid target_date format', () => {
    const data = createValidEpicsYaml();
    data.epics[0].target_date = '2026/06/22'; // Wrong format

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'E_INVALID_TARGET_DATE_FORMAT',
      })
    );
  });

  it('should handle multiple errors gracefully', () => {
    const data: any = {
      epics: [
        {
          id: 'EPIC-1',
          // Missing: name, project, tasks_yaml, status
        },
      ],
    };

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(3); // Multiple errors
  });

  it('should handle null/undefined epic gracefully', () => {
    const data: any = createValidEpicsYaml();
    data.epics.push(null);

    const result = validateEpicsYaml(data);
    expect(result.valid).toBe(false);
    // Should have errors for missing fields
  });

  it('should validate large epic lists efficiently', () => {
    const data = createValidEpicsYaml();
    // Add 100 epics
    for (let i = 4; i <= 100; i++) {
      data.epics.push({
        id: `EPIC-${i}`,
        name: `Epic ${i}`,
        project: `spaceos/module-${i}`,
        depends_on: [],
        status: 'pending',
        tasks_yaml: `spaceos/module-${i}/TASKS.yaml`,
      });
    }

    const start = Date.now();
    const result = validateEpicsYaml(data);
    const duration = Date.now() - start;

    expect(result.valid).toBe(true);
    expect(duration).toBeLessThan(1000); // Should complete in < 1s
  });
});
