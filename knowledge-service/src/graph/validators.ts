/**
 * Graph validation utilities for epic and workflow state management
 *
 * Provides validators for:
 * - Status transitions (state machine logic)
 * - Dependency constraints (done preconditions)
 * - Self-reference checks
 */

import { NodeStatus, EpicDependency } from './types';

/**
 * Valid status transitions for epic state machine
 *
 * State machine rules:
 * - pending → active (start work)
 * - pending → blocked (blocked before start)
 * - active → done (complete)
 * - active → blocked (blocked during work)
 * - blocked → active (retry/unblock)
 * - done → (terminal state, no transitions allowed)
 */
const VALID_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  pending: ['active', 'blocked'],
  active: ['done', 'blocked'],
  done: [], // Terminal state
  blocked: ['active'], // Can retry from blocked
};

/**
 * Validate status transition
 *
 * @param currentStatus - Current epic status
 * @param newStatus - Proposed new status
 * @returns Validation result with error message if invalid
 */
export function isValidStatusTransition(
  currentStatus: NodeStatus,
  newStatus: NodeStatus
): { valid: boolean; error?: string } {
  // Same status is allowed (no-op)
  if (currentStatus === newStatus) {
    return { valid: true };
  }

  const allowedTargets = VALID_TRANSITIONS[currentStatus] || [];

  if (!allowedTargets.includes(newStatus)) {
    return {
      valid: false,
      error: `Cannot transition from ${currentStatus} to ${newStatus}`,
    };
  }

  return { valid: true };
}

/**
 * Validate "done" precondition
 *
 * Before setting an epic to "done", all its dependencies must also be "done".
 * This prevents marking an epic complete while it still depends on incomplete work.
 *
 * @param epic - Epic being updated
 * @param allEpics - All epics in the system
 * @returns Validation result with blocking dependencies if invalid
 */
export function validateDonePrecondition(
  epic: EpicDependency,
  allEpics: EpicDependency[]
): { valid: boolean; error?: string; blockingDeps?: string[] } {
  if (!epic.depends_on || epic.depends_on.length === 0) {
    return { valid: true };
  }

  const epicMap = new Map(allEpics.map(e => [e.id, e]));
  const blockingDeps: string[] = [];

  for (const depId of epic.depends_on) {
    const dep = epicMap.get(depId);
    if (!dep) {
      // Dependency not found - should be caught by earlier validation
      continue;
    }

    if (dep.status !== 'done') {
      blockingDeps.push(depId);
    }
  }

  if (blockingDeps.length > 0) {
    return {
      valid: false,
      error: `Cannot set status to done: dependencies not complete: ${blockingDeps.join(', ')}`,
      blockingDeps,
    };
  }

  return { valid: true };
}

/**
 * Validate self-reference in dependencies
 *
 * Prevents an epic from depending on itself (direct cycle).
 *
 * @param epicId - Epic ID
 * @param dependsOn - Proposed dependency list
 * @returns Validation result with error if self-reference detected
 */
export function validateNoSelfReference(
  epicId: string,
  dependsOn: string[]
): { valid: boolean; error?: string } {
  if (dependsOn.includes(epicId)) {
    return {
      valid: false,
      error: `Epic cannot depend on itself: ${epicId}`,
    };
  }

  return { valid: true };
}
