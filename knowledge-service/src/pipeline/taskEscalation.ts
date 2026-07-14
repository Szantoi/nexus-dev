/**
 * Task Escalation System - Retry + Root Escalation
 *
 * Implements ADR-052 Phase 2: Automatic retry and escalation for stuck tasks
 *
 * Workflow:
 * 1. Task subscription timeout expires
 * 2. Retry #1: Send nudge (tmux send-keys)
 * 3. Retry #2: Session restart + inbox re-inject
 * 4. Escalation: Root inbox with full context
 *
 * 2026-07-02: Phase 2 Implementation
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { type Subscription, subscriptionManager } from './subscriptionManager';
import { sendNotification } from '../telegram/telegramService';
import { capturePane, sendKeys, sendEnter, hasSession } from './common';
import { getMessage, getUnreadMessages } from '../messageRegistry';
import { startWorkSession } from '../sessionStarter';
import { NWT_TIMEOUTS, nwtToMs } from '../constants/nwt';

const execAsync = promisify(exec);

// ─── Configuration ─────────────────────────────────────────────────────────────
// NWT-based configuration: TASK_RETRY = 15 NWT ≈ 30 minutes

export interface EscalationConfig {
  maxRetries: number;              // Default: 2
  retryIntervalNWT: number;        // Default: 15 NWT (~30 min) between retries
  escalateTo: string;              // Default: 'root'
  retryStrategies: {
    first: 'nudge' | 'restart' | 'inbox-reinject';   // Default: 'nudge'
    second: 'nudge' | 'restart' | 'inbox-reinject';  // Default: 'restart'
  };
}

const DEFAULT_CONFIG: EscalationConfig = {
  maxRetries: 2,
  retryIntervalNWT: NWT_TIMEOUTS.TASK_RETRY, // 15 NWT ≈ 30 minutes
  escalateTo: 'root',
  retryStrategies: {
    first: 'nudge',
    second: 'restart',
  },
};

// Allow runtime configuration override
let currentConfig: EscalationConfig = { ...DEFAULT_CONFIG };

export function setEscalationConfig(config: Partial<EscalationConfig>): void {
  currentConfig = { ...currentConfig, ...config };
  console.log('[TaskEscalation] Configuration updated:', currentConfig);
}

export function getEscalationConfig(): EscalationConfig {
  return { ...currentConfig };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EscalationRecord {
  id: string;
  subscription_id: string;
  task_id: string;
  terminal: string;
  retry_count: number;
  max_retries: number;
  retry_history: RetryAttempt[];
  escalated_at?: string;
  escalated_to?: string;
  status: 'active' | 'resolved' | 'escalated';
}

export interface RetryAttempt {
  attempt: number;
  strategy: 'nudge' | 'restart' | 'inbox-reinject';
  timestamp: string;
  success: boolean;
  error?: string;
  session_log?: string;
}

// ─── In-memory escalation registry ────────────────────────────────────────────

const escalations = new Map<string, EscalationRecord>();

// ─── Escalation Manager ────────────────────────────────────────────────────────

export class TaskEscalationManager {
  /**
   * Handle subscription timeout - retry or escalate
   */
  async handleTimeout(subscription: Subscription): Promise<void> {
    const { id, terminal, target: task_id } = subscription;

    // Get or create escalation record
    let escalation = escalations.get(id);
    if (!escalation) {
      escalation = {
        id: randomUUID(),
        subscription_id: id,
        task_id,
        terminal,
        retry_count: 0,
        max_retries: currentConfig.maxRetries,
        retry_history: [],
        status: 'active',
      };
      escalations.set(id, escalation);
    }

    // Check retry limit
    if (escalation.retry_count >= escalation.max_retries) {
      // ESCALATE
      await this.escalateToRoot(escalation);
      return;
    }

    // RETRY
    await this.retryTask(escalation);
  }

  /**
   * Retry task with progressive strategy
   */
  private async retryTask(escalation: EscalationRecord): Promise<void> {
    escalation.retry_count++;

    // Determine strategy based on config
    let strategy: 'nudge' | 'restart' | 'inbox-reinject';
    if (escalation.retry_count === 1) {
      strategy = currentConfig.retryStrategies.first;
    } else if (escalation.retry_count === 2) {
      strategy = currentConfig.retryStrategies.second;
    } else {
      strategy = 'restart'; // Fallback
    }

    const attempt: RetryAttempt = {
      attempt: escalation.retry_count,
      strategy,
      timestamp: new Date().toISOString(),
      success: false,
    };

    console.log(`[TaskEscalation] Retry ${escalation.retry_count}/${escalation.max_retries} for ${escalation.task_id} (strategy: ${strategy})`);

    try {
      if (strategy === 'nudge') {
        // Strategy: Nudge terminal session
        const sessionName = `spaceos-${escalation.terminal}`;
        if (await hasSession(sessionName)) {
          // Capture current state
          attempt.session_log = await capturePane(sessionName, 20);

          // Send nudge (hexa Enter)
          await sendEnter(sessionName);
          await new Promise(r => setTimeout(r, 500));
          await sendEnter(sessionName);

          await sendNotification(
            `⚠️ Task Timeout Retry 1/2\n` +
            `Task: ${escalation.task_id}\n` +
            `Terminal: ${escalation.terminal.toUpperCase()}\n` +
            `Action: Nudge sent (Enter x2)`
          );

          attempt.success = true;
          console.log(`[TaskEscalation] Nudge sent to ${sessionName}`);
        } else {
          attempt.error = 'Session not found';
          console.log(`[TaskEscalation] Session ${sessionName} not found, skipping nudge`);
        }
      } else if (strategy === 'restart') {
        // Strategy: Session restart + inbox re-inject
        const sessionName = `spaceos-${escalation.terminal}`;

        // Capture before kill
        if (await hasSession(sessionName)) {
          attempt.session_log = await capturePane(sessionName, 50);
          // Kill session
          try {
            await execAsync(`tmux kill-session -t ${sessionName}`);
            console.log(`[TaskEscalation] Killed session ${sessionName}`);
          } catch {
            // Session already dead
          }
        }

        // Restart session with task prompt
        const taskDetails = getMessage(escalation.task_id);
        const prompt = `[RETRY - Task Escalation]\n\nYour inbox message ${escalation.task_id} timed out. Please process it now.\n\nTask: ${taskDetails?.messageId || 'Unknown'}`;

        const result = await startWorkSession(escalation.terminal, prompt, 'sonnet');

        await sendNotification(
          `⚠️ Task Timeout Retry 2/2\n` +
          `Task: ${escalation.task_id}\n` +
          `Terminal: ${escalation.terminal.toUpperCase()}\n` +
          `Action: Session restarted`
        );

        attempt.success = result.success;
        if (!result.success) {
          attempt.error = result.message;
        }
        console.log(`[TaskEscalation] Session restart: ${result.message}`);
      }
    } catch (error: any) {
      attempt.success = false;
      attempt.error = error.message;
      console.error(`[TaskEscalation] Retry failed:`, error);
    }

    escalation.retry_history.push(attempt);
    escalations.set(escalation.subscription_id, escalation);

    // Extend subscription timeout for next check (configurable NWT interval)
    const retryIntervalSeconds = Math.floor(nwtToMs(currentConfig.retryIntervalNWT) / 1000);
    const newSub = subscriptionManager.subscribe({
      terminal: escalation.terminal,
      type: 'task',
      target: escalation.task_id,
      events: ['done', 'blocked', 'progress'],
      deliveryMethod: 'telegram',
      expiresIn: retryIntervalSeconds,
    });

    console.log(`[TaskEscalation] Extended subscription for ${escalation.task_id} (${currentConfig.retryIntervalNWT} NWT)`);
  }

  /**
   * Escalate to Root with full context
   */
  private async escalateToRoot(escalation: EscalationRecord): Promise<void> {
    escalation.status = 'escalated';
    escalation.escalated_at = new Date().toISOString();
    escalation.escalated_to = currentConfig.escalateTo;

    console.log(`[TaskEscalation] ESCALATING ${escalation.task_id} to ROOT`);

    // Collect context
    const taskDetails = getMessage(escalation.task_id);
    const inboxStatus = getUnreadMessages(escalation.terminal, 'inbox');
    const sessionName = `spaceos-${escalation.terminal}`;
    let sessionLog = 'Session not running';
    if (await hasSession(sessionName)) {
      sessionLog = await capturePane(sessionName, 100);
    }

    // Build escalation inbox content
    const escalationContent = `---
id: MSG-ROOT-${Date.now().toString().slice(-3)}
from: system
to: root
type: escalation
priority: high
status: UNREAD
model: sonnet
ref: ${escalation.task_id}
created: ${new Date().toISOString().split('T')[0]}
escalation_id: ${escalation.id}
---

# ESCALATION: Task Timeout - ${escalation.task_id}

## Summary

**Terminal:** ${escalation.terminal}
**Task:** ${escalation.task_id}
**Timeout:** ${escalation.max_retries + 1} periods (initial + ${escalation.max_retries} retries)
**Total Elapsed:** ~${(escalation.max_retries + 1) * currentConfig.retryIntervalNWT} NWT (~${Math.floor((escalation.max_retries + 1) * currentConfig.retryIntervalNWT * 2)} minutes)

**Retry History:**
${escalation.retry_history.map((r, i) => `
${i + 1}. **Attempt ${r.attempt}** (${r.strategy})
   - Timestamp: ${r.timestamp}
   - Success: ${r.success ? '✓' : '✗'}
   ${r.error ? `- Error: ${r.error}` : ''}
`).join('\n')}

---

## Task Details

**Message ID:** ${taskDetails?.messageId || 'Unknown'}
**Priority:** ${taskDetails?.priority || 'unknown'}
**Status:** ${taskDetails?.status || 'unknown'}
**Created:** ${taskDetails?.createdAt || 'unknown'}

---

## Terminal Status

**Inbox UNREAD count:** ${inboxStatus.length}
**Session running:** ${await hasSession(sessionName) ? 'YES' : 'NO'}

---

## Session Log (Last 100 lines)

\`\`\`
${sessionLog}
\`\`\`

---

## Recommended Actions

1. **Check terminal session:** Investigate why ${escalation.terminal} didn't respond
2. **Manual intervention:** Process ${escalation.task_id} manually or reassign
3. **System check:** Verify MCP infrastructure health
4. **Resolution:** Mark escalation as resolved or cancel task

---

## Resolution Commands

\`\`\`bash
# Mark as resolved (terminal responded)
curl -X POST http://localhost:3456/api/escalation/${escalation.id}/resolve

# Cancel task (no longer needed)
curl -X POST http://localhost:3456/api/escalation/${escalation.id}/cancel
\`\`\`
`;

    // Write escalation inbox (to configured target terminal)
    const targetTerminal = currentConfig.escalateTo;
    const inboxPath = path.join(`/opt/spaceos/terminals/${targetTerminal}/inbox`, `escalation_${escalation.id}.md`);
    await fs.writeFile(inboxPath, escalationContent, 'utf-8');

    // Send alert
    await sendNotification(
      `🚨 ROOT ESCALATION\n` +
      `Task: ${escalation.task_id}\n` +
      `Terminal: ${escalation.terminal.toUpperCase()}\n` +
      `Retries: ${escalation.retry_count}/${escalation.max_retries}\n` +
      `Action: Root inbox created\n` +
      `File: ${inboxPath}`
    );

    console.log(`[TaskEscalation] Escalation inbox created: ${inboxPath}`);

    escalations.set(escalation.subscription_id, escalation);

    // Unsubscribe from task (escalated)
    subscriptionManager.unsubscribe(escalation.subscription_id);
  }

  /**
   * Resolve escalation (manual)
   */
  async resolveEscalation(escalationId: string): Promise<boolean> {
    for (const [subId, esc] of escalations.entries()) {
      if (esc.id === escalationId) {
        esc.status = 'resolved';
        escalations.set(subId, esc);
        console.log(`[TaskEscalation] Escalation ${escalationId} resolved`);
        return true;
      }
    }
    return false;
  }

  /**
   * Get all escalations
   */
  getEscalations(status?: 'active' | 'resolved' | 'escalated'): EscalationRecord[] {
    const all = Array.from(escalations.values());
    if (!status) return all;
    return all.filter(e => e.status === status);
  }
}

// Singleton
export const taskEscalationManager = new TaskEscalationManager();

// ─── Nightwatch Integration Hook ──────────────────────────────────────────────

/**
 * Check for expired subscriptions and handle them
 * Called by Nightwatch every 2 minutes
 */
export async function watchTaskEscalations(): Promise<{
  checked: number;
  retried: number;
  escalated: number;
}> {
  const now = new Date();
  let checked = 0;
  let retried = 0;
  let escalated = 0;

  const allSubs = subscriptionManager.getSubscriptions();

  for (const sub of allSubs) {
    if (!sub.expiresAt) continue;

    const expiresAt = new Date(sub.expiresAt);
    if (expiresAt > now) continue; // Not expired yet

    checked++;

    // Check if task is actually done (subscription expired but task completed)
    const taskDetails = getMessage(sub.target);
    if (taskDetails?.status === 'DONE' || taskDetails?.status === 'COMPLETED') {
      // Task completed - just unsubscribe
      subscriptionManager.unsubscribe(sub.id);
      console.log(`[TaskEscalation] Task ${sub.target} completed, unsubscribed`);
      continue;
    }

    // Task NOT done - escalate
    const escalation = escalations.get(sub.id);
    if (escalation && escalation.status === 'escalated') {
      // Already escalated, skip
      continue;
    }

    if (!escalation || escalation.retry_count < currentConfig.maxRetries) {
      // Retry
      await taskEscalationManager.handleTimeout(sub);
      retried++;
    } else {
      // Escalate
      await taskEscalationManager.handleTimeout(sub);
      escalated++;
    }
  }

  if (checked > 0) {
    console.log(`[TaskEscalation] Checked ${checked} expired subscriptions: ${retried} retried, ${escalated} escalated`);
  }

  return { checked, retried, escalated };
}
