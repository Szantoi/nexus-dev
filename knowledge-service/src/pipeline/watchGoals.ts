/**
 * watchGoals.ts - Monitor-Driven Goal Progression (ADR-059)
 *
 * Runs every Nightwatch cycle (2 min).
 * Checks all watching goals for completion criteria.
 * When criteria are met, triggers the target terminal.
 *
 * This is the core of Mode #4 cost-efficient operation:
 * - Haiku (cheap) continuously watches
 * - Sonnet (expensive) only triggered when goals complete
 *
 * 2026-07-04: Initial implementation
 */

import { log } from './common';
import {
  listGoals,
  getGoal,
  checkGoalCriteria,
  triggerGoal,
  checkExpiredGoals,
  type Goal,
  type CriterionResult,
} from '../goalStore';
import { createTask } from '../mailbox';

export interface WatchGoalsResult {
  checked: number;
  triggered: string[];
  expired: string[];
  errors: string[];
}

/**
 * Main watchGoals function - called every Nightwatch cycle
 */
export async function watchGoals(): Promise<WatchGoalsResult> {
  const result: WatchGoalsResult = {
    checked: 0,
    triggered: [],
    expired: [],
    errors: [],
  };

  try {
    // 1. Check for expired goals first
    const expiredGoals = await checkExpiredGoals();
    result.expired = expiredGoals;
    if (expiredGoals.length > 0) {
      await log(`[watchGoals] Expired ${expiredGoals.length} goals: ${expiredGoals.join(', ')}`);
    }

    // 2. Get all watching goals
    const watchingGoals = await listGoals('watching');
    result.checked = watchingGoals.length;

    if (watchingGoals.length === 0) {
      await log('[watchGoals] No active goals to watch');
      return result;
    }

    await log(`[watchGoals] Checking ${watchingGoals.length} active goals`);

    // 3. Check each goal's criteria
    for (const goal of watchingGoals) {
      try {
        const { allMet, results } = await checkGoalCriteria(goal);

        if (allMet) {
          // All criteria met - trigger the goal
          await log(`[watchGoals] ✅ Goal ${goal.id} criteria MET - triggering ${goal.on_complete.trigger_terminal}`);

          const triggered = await triggerGoalAndNotify(goal, results);
          if (triggered) {
            result.triggered.push(goal.id);
          } else {
            result.errors.push(`${goal.id}: trigger failed`);
          }
        } else {
          // Log progress for debugging
          const metCount = results.filter(r => r.met).length;
          await log(`[watchGoals] Goal ${goal.id}: ${metCount}/${results.length} criteria met`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await log(`[watchGoals] ❌ Error checking goal ${goal.id}: ${errMsg}`);
        result.errors.push(`${goal.id}: ${errMsg}`);
      }
    }

    // 4. Summary
    if (result.triggered.length > 0) {
      await log(`[watchGoals] TRIGGERED ${result.triggered.length} goals: ${result.triggered.join(', ')}`);
    }

    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await log(`[watchGoals] ❌ Critical error: ${errMsg}`);
    result.errors.push(`critical: ${errMsg}`);
    return result;
  }
}

/**
 * Trigger a goal and send notification to target terminal
 */
async function triggerGoalAndNotify(
  goal: Goal,
  criteriaResults: CriterionResult[]
): Promise<boolean> {
  try {
    // Build the prompt with variable substitution
    const completedCriteriaText = criteriaResults
      .map(r => `- ${r.met ? '✓' : '✗'} ${r.criterion.type}: ${r.details}`)
      .join('\n');

    const prompt = goal.on_complete.prompt
      .replace(/\{\{goal\.description\}\}/g, goal.goal.description)
      .replace(/\{\{on_complete\.next_goal\}\}/g, goal.on_complete.next_goal || '')
      .replace(/\{\{completed_criteria\}\}/g, completedCriteriaText);

    // Create task for target terminal
    const taskResult = await createTask({
      from: 'monitor',
      to: goal.on_complete.trigger_terminal,
      title: `✅ Goal Completed: ${goal.goal.description}`,
      description: prompt,
      priority: 'high',
      model: 'sonnet', // Use Sonnet for Conductor decisions
      ref: goal.id,
      epic_id: goal.epic_id,
    });

    if (!taskResult.success || !taskResult.id) {
      await log(`[watchGoals] Failed to create task for ${goal.on_complete.trigger_terminal}: ${taskResult.error || 'unknown error'}`);
      return false;
    }

    // Mark goal as triggered
    await triggerGoal(goal.id, taskResult.id, criteriaResults);

    await log(`[watchGoals] Goal ${goal.id} triggered → ${goal.on_complete.trigger_terminal} (${taskResult.id})`);

    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await log(`[watchGoals] ❌ Failed to trigger goal ${goal.id}: ${errMsg}`);
    return false;
  }
}

/**
 * Get a summary of active goals for Nightwatch reporting
 */
export async function getGoalsSummary(): Promise<{
  watching: number;
  triggered: number;
  completed: number;
  expired: number;
}> {
  try {
    const [watching, triggered, completed, expired] = await Promise.all([
      listGoals('watching'),
      listGoals('triggered'),
      listGoals('completed'),
      listGoals('expired'),
    ]);

    return {
      watching: watching.length,
      triggered: triggered.length,
      completed: completed.length,
      expired: expired.length,
    };
  } catch {
    return { watching: 0, triggered: 0, completed: 0, expired: 0 };
  }
}
