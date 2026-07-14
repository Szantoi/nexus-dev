/**
 * EPICS.yaml Validator (ADR-041 Phase 1 / TASK-001)
 *
 * Validates EPICS.yaml files against the Graph-Based Workflow schema.
 *
 * Validation Rules:
 * - E1: version field required (semantic versioning)
 * - E2: updated field required (YYYY-MM-DD)
 * - E3: epics array required and non-empty
 * - E4: All epic IDs unique
 * - E5: depends_on references exist
 * - E6: parallel_with references exist
 * - E7: No circular dependencies (DAG validation)
 * - E8: Status values valid
 * - E9: project field required
 * - E10: tasks_yaml path required
 *
 * @see docs/architecture/decisions/ADR-041-graph-based-workflow-architecture.md
 */

import { EpicsYaml, EpicDependency, NodeStatus, WorkflowGraph } from '../graph/types';
import { detectCycles } from '../graph/operations';

export interface EpicsValidationResult {
  valid: boolean;
  errors: EpicsValidationError[];
  warnings: EpicsValidationWarning[];
  cycles?: string[][];
}

export interface EpicsValidationError {
  code: string;
  message: string;
  epic_id?: string;
  path?: string;
}

export interface EpicsValidationWarning {
  code: string;
  message: string;
  epic_id?: string;
  path?: string;
}

/**
 * Valid epic statuses
 */
const VALID_EPIC_STATUSES: NodeStatus[] = ['pending', 'active', 'done', 'blocked'];

/**
 * Validate EPICS.yaml schema
 *
 * @param epicsData Parsed EPICS.yaml content (unknown type for safety)
 * @returns Validation result
 */
export function validateEpicsYaml(epicsData: any): EpicsValidationResult {
  const errors: EpicsValidationError[] = [];
  const warnings: EpicsValidationWarning[] = [];

  // ─── E1: Version field required ──────────────────────────────────────────
  if (!epicsData.version) {
    errors.push({
      code: 'E1_MISSING_VERSION',
      message: 'Missing required field: version',
      path: 'version',
    });
  } else if (typeof epicsData.version !== 'string') {
    errors.push({
      code: 'E1_INVALID_VERSION_TYPE',
      message: 'version must be a string',
      path: 'version',
    });
  } else if (!isValidSemanticVersion(epicsData.version)) {
    warnings.push({
      code: 'E1_INVALID_VERSION_FORMAT',
      message: `Invalid semantic version format: ${epicsData.version}. Expected format: X.Y or X.Y.Z`,
      path: 'version',
    });
  }

  // ─── E2: Updated field required ─────────────────────────────────────────
  if (!epicsData.updated) {
    errors.push({
      code: 'E2_MISSING_UPDATED',
      message: 'Missing required field: updated',
      path: 'updated',
    });
  } else if (typeof epicsData.updated !== 'string') {
    errors.push({
      code: 'E2_INVALID_UPDATED_TYPE',
      message: 'updated must be a string (YYYY-MM-DD)',
      path: 'updated',
    });
  } else if (!isValidDateFormat(epicsData.updated)) {
    errors.push({
      code: 'E2_INVALID_DATE_FORMAT',
      message: `Invalid date format: ${epicsData.updated}. Expected YYYY-MM-DD`,
      path: 'updated',
    });
  }

  // ─── E3: Epics array required ───────────────────────────────────────────
  if (!epicsData.epics) {
    errors.push({
      code: 'E3_MISSING_EPICS',
      message: 'Missing required field: epics',
      path: 'epics',
    });
    // Cannot continue validation without epics array
    return { valid: false, errors, warnings };
  }

  if (!Array.isArray(epicsData.epics)) {
    errors.push({
      code: 'E3_INVALID_EPICS_TYPE',
      message: 'epics must be an array',
      path: 'epics',
    });
    return { valid: false, errors, warnings };
  }

  if (epicsData.epics.length === 0) {
    warnings.push({
      code: 'E3_EMPTY_EPICS',
      message: 'epics array is empty',
      path: 'epics',
    });
    return { valid: errors.length === 0, errors, warnings };
  }

  // ─── E4: Unique epic IDs ────────────────────────────────────────────────
  const epicIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (let i = 0; i < epicsData.epics.length; i++) {
    const epic = epicsData.epics[i];
    const epicId = epic?.id;

    if (!epicId) {
      errors.push({
        code: 'E4_MISSING_ID',
        message: `Epic at index ${i} is missing id field`,
        path: `epics[${i}].id`,
      });
      continue;
    }

    if (epicIds.has(epicId)) {
      duplicateIds.add(epicId);
      errors.push({
        code: 'E4_DUPLICATE_ID',
        message: `Duplicate epic ID: ${epicId}`,
        epic_id: epicId,
        path: `epics[${i}].id`,
      });
    }

    epicIds.add(epicId);
  }

  // ─── Validate each epic ─────────────────────────────────────────────────
  for (let i = 0; i < epicsData.epics.length; i++) {
    const epic = epicsData.epics[i];
    validateEpicFields(epic, i, epicIds, errors, warnings);
  }

  // ─── E7: Cycle detection (DAG validation) ───────────────────────────────
  if (errors.length === 0) {
    const cycleResult = checkForCycles(epicsData.epics);
    if (cycleResult.hasCycles) {
      for (const cycle of cycleResult.cycles) {
        errors.push({
          code: 'E7_CIRCULAR_DEPENDENCY',
          message: `Circular dependency detected: ${cycle.join(' → ')}`,
          path: 'epics',
        });
      }
      return {
        valid: false,
        errors,
        warnings,
        cycles: cycleResult.cycles,
      };
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate individual epic fields
 */
function validateEpicFields(
  epic: any,
  index: number,
  allEpicIds: Set<string>,
  errors: EpicsValidationError[],
  warnings: EpicsValidationWarning[]
): void {
  // Handle null/undefined epic
  if (epic === null || epic === undefined) {
    errors.push({
      code: 'E_NULL_EPIC',
      message: `Epic at index ${index} is null or undefined`,
      path: `epics[${index}]`,
    });
    return;
  }

  const epicId = epic?.id || `[index ${index}]`;

  // ─── E9: Project field required ─────────────────────────────────────────
  if (!epic.project) {
    errors.push({
      code: 'E9_MISSING_PROJECT',
      message: 'Missing required field: project',
      epic_id: epicId,
      path: `epics[${index}].project`,
    });
  } else if (typeof epic.project !== 'string') {
    errors.push({
      code: 'E9_INVALID_PROJECT_TYPE',
      message: 'project must be a string',
      epic_id: epicId,
      path: `epics[${index}].project`,
    });
  }

  // ─── Name field required ────────────────────────────────────────────────
  if (!epic.name) {
    errors.push({
      code: 'E_MISSING_NAME',
      message: 'Missing required field: name',
      epic_id: epicId,
      path: `epics[${index}].name`,
    });
  } else if (typeof epic.name !== 'string') {
    errors.push({
      code: 'E_INVALID_NAME_TYPE',
      message: 'name must be a string',
      epic_id: epicId,
      path: `epics[${index}].name`,
    });
  }

  // ─── E10: tasks_yaml path required ──────────────────────────────────────
  if (!epic.tasks_yaml) {
    errors.push({
      code: 'E10_MISSING_TASKS_YAML',
      message: 'Missing required field: tasks_yaml',
      epic_id: epicId,
      path: `epics[${index}].tasks_yaml`,
    });
  } else if (typeof epic.tasks_yaml !== 'string') {
    errors.push({
      code: 'E10_INVALID_TASKS_YAML_TYPE',
      message: 'tasks_yaml must be a string',
      epic_id: epicId,
      path: `epics[${index}].tasks_yaml`,
    });
  }

  // ─── depends_on validation ──────────────────────────────────────────────
  if (!epic.depends_on) {
    // depends_on is optional, default to empty array
    epic.depends_on = [];
  } else if (!Array.isArray(epic.depends_on)) {
    errors.push({
      code: 'E_INVALID_DEPENDS_ON_TYPE',
      message: 'depends_on must be an array',
      epic_id: epicId,
      path: `epics[${index}].depends_on`,
    });
  } else {
    // ─── E5: depends_on references exist ────────────────────────────────
    for (const depId of epic.depends_on) {
      if (typeof depId !== 'string') {
        errors.push({
          code: 'E5_INVALID_DEPENDENCY_TYPE',
          message: `depends_on contains non-string value: ${depId}`,
          epic_id: epicId,
          path: `epics[${index}].depends_on`,
        });
      } else if (!allEpicIds.has(depId)) {
        errors.push({
          code: 'E5_MISSING_DEPENDENCY',
          message: `depends_on references non-existent epic: ${depId}`,
          epic_id: epicId,
          path: `epics[${index}].depends_on`,
        });
      } else if (depId === epicId) {
        errors.push({
          code: 'E5_SELF_DEPENDENCY',
          message: `Epic cannot depend on itself: ${depId}`,
          epic_id: epicId,
          path: `epics[${index}].depends_on`,
        });
      }
    }
  }

  // ─── parallel_with validation ───────────────────────────────────────────
  if (epic.parallel_with) {
    if (!Array.isArray(epic.parallel_with)) {
      errors.push({
        code: 'E_INVALID_PARALLEL_WITH_TYPE',
        message: 'parallel_with must be an array',
        epic_id: epicId,
        path: `epics[${index}].parallel_with`,
      });
    } else {
      // ─── E6: parallel_with references exist ─────────────────────────────
      for (const parallelId of epic.parallel_with) {
        if (typeof parallelId !== 'string') {
          errors.push({
            code: 'E6_INVALID_PARALLEL_TYPE',
            message: `parallel_with contains non-string value: ${parallelId}`,
            epic_id: epicId,
            path: `epics[${index}].parallel_with`,
          });
        } else if (!allEpicIds.has(parallelId)) {
          errors.push({
            code: 'E6_MISSING_PARALLEL',
            message: `parallel_with references non-existent epic: ${parallelId}`,
            epic_id: epicId,
            path: `epics[${index}].parallel_with`,
          });
        } else if (parallelId === epicId) {
          errors.push({
            code: 'E6_SELF_PARALLEL',
            message: `Epic cannot be parallel with itself: ${parallelId}`,
            epic_id: epicId,
            path: `epics[${index}].parallel_with`,
          });
        }
      }
    }
  }

  // ─── E8: Status validation ──────────────────────────────────────────────
  if (!epic.status) {
    warnings.push({
      code: 'E8_MISSING_STATUS',
      message: 'Missing status field, defaulting to "pending"',
      epic_id: epicId,
      path: `epics[${index}].status`,
    });
  } else if (!VALID_EPIC_STATUSES.includes(epic.status)) {
    errors.push({
      code: 'E8_INVALID_STATUS',
      message: `Invalid status: ${epic.status}. Valid values: ${VALID_EPIC_STATUSES.join(', ')}`,
      epic_id: epicId,
      path: `epics[${index}].status`,
    });
  }

  // ─── Optional field warnings ────────────────────────────────────────────
  if (!epic.description) {
    warnings.push({
      code: 'E_MISSING_DESCRIPTION',
      message: 'Missing optional field: description',
      epic_id: epicId,
      path: `epics[${index}].description`,
    });
  }

  if (epic.target_date && !isValidDateFormat(epic.target_date)) {
    errors.push({
      code: 'E_INVALID_TARGET_DATE_FORMAT',
      message: `Invalid target_date format: ${epic.target_date}. Expected YYYY-MM-DD`,
      epic_id: epicId,
      path: `epics[${index}].target_date`,
    });
  }
}

/**
 * Check for circular dependencies in epic graph
 *
 * Uses the detectCycles() function from operations.ts
 */
function checkForCycles(epics: EpicDependency[]): { hasCycles: boolean; cycles: string[][] } {
  // Build WorkflowGraph for cycle detection
  const graph: WorkflowGraph = {
    id: 'epics-validation',
    name: 'EPICS Validation Graph',
    type: 'epic_dependency',
    nodes: epics.map(epic => ({
      id: epic.id,
      type: 'epic' as const,
      name: epic.name,
      status: epic.status || 'pending',
      depends_on: epic.depends_on || [],
      triggers: [], // Will be computed by loader
      parallel_with: epic.parallel_with,
      metadata: {
        project: epic.project,
        tasks_yaml: epic.tasks_yaml,
      },
    })),
  };

  const cycles = detectCycles(graph);

  return {
    hasCycles: cycles.length > 0,
    cycles,
  };
}

/**
 * Validate semantic version format (X.Y or X.Y.Z)
 */
function isValidSemanticVersion(version: string): boolean {
  const semverRegex = /^\d+\.\d+(\.\d+)?$/;
  return semverRegex.test(version);
}

/**
 * Validate date format (YYYY-MM-DD)
 */
function isValidDateFormat(date: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return false;
  }

  // Check if it's a valid date
  const parsedDate = new Date(date);
  return !isNaN(parsedDate.getTime());
}
