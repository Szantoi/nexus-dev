/**
 * Subscription Manager for FSM Event Notifications
 *
 * Implements ADR-052: FSM Subscription System
 * Provides push-based event notifications via SSE, Telegram, or Inbox
 *
 * 2026-06-30: Phase 1 Core Implementation
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { pipelineEvents, type PipelineEvent, type PipelineEventType } from './eventBus';
import { broadcastToTerminal } from '../routes/subscriptionRoutes';
import { sendNotification } from '../telegram/telegramService';
import { startWorkSession } from '../sessionStarter';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SubscriptionType = 'task' | 'terminal';

export type SubscriptionEventType =
  // Task events
  | 'done'
  | 'blocked'
  | 'progress'
  // Terminal events
  | 'inbox_new'
  | 'outbox_done'
  | 'session_started'
  | 'session_ended';

export type DeliveryMethod = 'sse' | 'telegram' | 'inbox' | 'auto';

export interface Subscription {
  id: string;                     // UUID
  terminal: string;               // architect, backend, etc.
  type: SubscriptionType;         // 'task' or 'terminal'
  target: string;                 // Task ID or terminal name
  events: SubscriptionEventType[]; // Event list
  deliveryMethod: DeliveryMethod; // Preferred delivery
  createdAt: string;              // ISO timestamp
  expiresAt?: string;             // Optional expiration
}

export interface SubscribeParams {
  terminal: string;
  type: SubscriptionType;
  target: string;
  events: SubscriptionEventType[];
  deliveryMethod?: DeliveryMethod;
  expiresIn?: number;  // Seconds (default: 3600)
}

// ─── Event Mapping ────────────────────────────────────────────────────────────

/**
 * Maps subscription events to pipeline events
 */
const EVENT_MAPPING: Record<SubscriptionEventType, PipelineEventType[]> = {
  // Task events
  'done': ['outbox:done'],
  'blocked': ['outbox:blocked'],
  'progress': ['inbox:read'],

  // Terminal events
  'inbox_new': ['inbox:new'],
  'outbox_done': ['outbox:done'],
  'session_started': ['session:started'],
  'session_ended': ['session:ended'],
};

// ─── Subscription Manager ─────────────────────────────────────────────────────

export class SubscriptionManager {
  private subscriptions = new Map<string, Subscription>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupTimer();
    this.attachToEventBus();
  }

  /**
   * Subscribe to events
   */
  subscribe(params: SubscribeParams): Subscription {
    const {
      terminal,
      type,
      target,
      events,
      deliveryMethod = 'auto',
      expiresIn = 3600,
    } = params;

    const subscription: Subscription = {
      id: randomUUID(),
      terminal,
      type,
      target,
      events,
      deliveryMethod,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };

    this.subscriptions.set(subscription.id, subscription);

    console.log(`[SubscriptionManager] ${terminal} subscribed to ${type}:${target} (${events.join(',')})`);

    return subscription;
  }

  /**
   * Unsubscribe by subscription ID
   */
  unsubscribe(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return false;
    }

    this.subscriptions.delete(subscriptionId);
    console.log(`[SubscriptionManager] Unsubscribed: ${subscriptionId}`);

    return true;
  }

  /**
   * Get subscriptions for a terminal
   */
  getSubscriptions(terminal?: string): Subscription[] {
    const all = Array.from(this.subscriptions.values());

    if (!terminal) {
      return all;
    }

    return all.filter(sub => sub.terminal === terminal);
  }

  /**
   * Find subscriptions that match a pipeline event
   */
  findMatchingSubscriptions(event: PipelineEvent): Subscription[] {
    const matches: Subscription[] = [];

    for (const subscription of this.subscriptions.values()) {
      if (this.isMatch(subscription, event)) {
        matches.push(subscription);
      }
    }

    return matches;
  }

  /**
   * Check if subscription matches event
   */
  private isMatch(subscription: Subscription, event: PipelineEvent): boolean {
    // Check expiration
    if (subscription.expiresAt && new Date(subscription.expiresAt) < new Date()) {
      return false;
    }

    // Task subscription
    if (subscription.type === 'task') {
      // Check if event's messageId matches subscription target
      if (event.messageId !== subscription.target) {
        return false;
      }

      // Check if event type matches any subscribed event
      return subscription.events.some(subEvent => {
        const mappedEvents = EVENT_MAPPING[subEvent] || [];
        return mappedEvents.includes(event.type);
      });
    }

    // Terminal subscription
    if (subscription.type === 'terminal') {
      // Check if event's terminal matches subscription target
      if (event.terminal !== subscription.target) {
        return false;
      }

      // Check if event type matches any subscribed event
      return subscription.events.some(subEvent => {
        const mappedEvents = EVENT_MAPPING[subEvent] || [];
        return mappedEvents.includes(event.type);
      });
    }

    return false;
  }

  /**
   * Deliver notification to subscriber
   *
   * ADR-053: Checkpoint triggers should START TERMINAL SESSIONS
   * Not just send Telegram notifications - terminals need to work!
   */
  private async deliverNotification(subscription: Subscription, event: PipelineEvent): Promise<void> {
    const { terminal, deliveryMethod } = subscription;

    try {
      // Try SSE first (for already active sessions)
      if (deliveryMethod === 'auto' || deliveryMethod === 'sse') {
        const delivered = this.tryDeliverSSE(terminal, event, subscription);
        if (delivered) {
          console.log(`[SubscriptionManager] Delivered via SSE to ${terminal}`);
          return;
        }
      }

      // ADR-053: Start terminal work session for checkpoint triggers
      // This is the PRIMARY delivery method - terminals should work on next task
      if (event.type === 'outbox:done' || event.type === 'outbox:blocked') {
        const taskPrompt = this.buildCheckpointTaskPrompt(subscription, event);
        console.log(`[SubscriptionManager] Starting work session for ${terminal} (checkpoint trigger)`);

        const result = await startWorkSession(terminal, taskPrompt, 'sonnet');
        if (result.success) {
          console.log(`[SubscriptionManager] Work session started: ${result.sessionName}`);
        } else {
          console.log(`[SubscriptionManager] Work session already running or failed: ${result.message}`);
        }
      }

      // Also send Telegram notification (secondary - for visibility)
      if (deliveryMethod === 'auto' || deliveryMethod === 'telegram') {
        const delivered = await this.deliverTelegram(subscription, event);
        if (delivered) {
          console.log(`[SubscriptionManager] Delivered via Telegram for subscription ${subscription.id}`);
        }
      }
    } catch (error) {
      console.error(`[SubscriptionManager] Delivery failed:`, error);
    }
  }

  /**
   * Build task prompt for checkpoint-triggered work session
   */
  private buildCheckpointTaskPrompt(subscription: Subscription, event: PipelineEvent): string {
    const eventType = event.type === 'outbox:done' ? 'DONE' : 'BLOCKED';

    return `[CHECKPOINT TRIGGER - ${eventType}]

A checkpoint esemény triggelt:
- **Target:** ${subscription.target}
- **Event:** ${event.type}
- **From terminal:** ${event.terminal || 'unknown'}

Te (${subscription.terminal}) fel voltál iratkozva erre a checkpoint-ra.

**Teendőd:**
1. Ellenőrizd a ${event.terminal || 'source'} terminál outbox-át
2. Ha ${eventType} → dolgozd fel és dispatch következő feladatot
3. Ha szükséges, indíts további terminálokat

Használd az MCP toolokat:
- \`list_inbox\` / \`tmb_get_inbox\` — bejövő feladatok
- \`get_focus_queue\` — aktív queue
- \`create_task\` — új feladat kiadása

---
Subscription ID: ${subscription.id}
`;
  }

  /**
   * Deliver notification via Telegram
   * ADR-053: Phase 2 Implementation
   *
   * Message format: Checkpoint name + Epic status
   */
  private async deliverTelegram(subscription: Subscription, event: PipelineEvent): Promise<boolean> {
    try {
      // Get checkpoint info for better message
      const checkpointInfo = this.getCheckpointInfo(subscription.target);

      // Format notification message
      const eventEmoji = event.type === 'outbox:done' ? '✅' : event.type === 'outbox:blocked' ? '🚫' : '📌';

      let message: string;

      if (checkpointInfo) {
        // Checkpoint-based message
        message = [
          `${eventEmoji} *CHECKPOINT COMPLETE*`,
          ``,
          `🎯 *${checkpointInfo.checkpointName}*`,
          `📋 Epic: \`${checkpointInfo.epicId}\``,
          ``,
          `*Státusz:* ${event.type === 'outbox:done' ? 'DONE ✅' : 'BLOCKED 🚫'}`,
          event.terminal ? `*From:* ${event.terminal}` : null,
          ``,
          `*Következő lépés:* ${subscription.terminal} terminál indítva`,
          ``,
          `_${checkpointInfo.pendingCount} checkpoint maradt az epic-ben_`,
        ]
          .filter(Boolean)
          .join('\n');
      } else {
        // Generic task-based message
        message = [
          `${eventEmoji} *TASK ${event.type === 'outbox:done' ? 'DONE' : 'BLOCKED'}*`,
          ``,
          `*Target:* \`${subscription.target}\``,
          event.terminal ? `*From:* ${event.terminal}` : null,
          ``,
          `*Subscriber:* ${subscription.terminal} (session started)`,
        ]
          .filter(Boolean)
          .join('\n');
      }

      const success = await sendNotification(message);
      return success;
    } catch (error) {
      console.error(`[SubscriptionManager] Telegram delivery error:`, error);
      return false;
    }
  }

  /**
   * Get checkpoint info for a subscription target
   */
  private getCheckpointInfo(target: string): {
    epicId: string;
    checkpointId: string;
    checkpointName: string;
    pendingCount: number;
  } | null {
    try {
      const checkpoints = parseCheckpointsFromEpics();

      // Find checkpoint that matches this target
      const match = checkpoints.find(cp => cp.messageId === target);
      if (!match) return null;

      // Count pending checkpoints in same epic
      const sameEpicCheckpoints = checkpoints.filter(cp => cp.epicId === match.epicId);
      const pendingCount = sameEpicCheckpoints.filter(cp => cp.checkpoint.status === 'pending').length;

      return {
        epicId: match.epicId,
        checkpointId: match.checkpoint.id,
        checkpointName: match.checkpoint.name,
        pendingCount,
      };
    } catch {
      return null;
    }
  }

  /**
   * Try to deliver via SSE
   */
  private tryDeliverSSE(terminal: string, event: PipelineEvent, subscription: Subscription): boolean {
    try {
      broadcastToTerminal(terminal, {
        type: 'notification',
        subscription: {
          id: subscription.id,
          type: subscription.type,
          target: subscription.target,
        },
        event,
        timestamp: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Attach to event bus
   */
  private attachToEventBus(): void {
    pipelineEvents.onAny((event: PipelineEvent) => {
      const matches = this.findMatchingSubscriptions(event);

      if (matches.length > 0) {
        console.log(`[SubscriptionManager] Event ${event.type} matched ${matches.length} subscriptions`);
      }

      matches.forEach(sub => {
        this.deliverNotification(sub, event);
      });
    });

    console.log('[SubscriptionManager] Attached to Event Bus');
  }

  /**
   * Clean up expired subscriptions
   */
  cleanupExpired(): number {
    const now = new Date();
    let cleanedCount = 0;

    for (const [id, subscription] of this.subscriptions.entries()) {
      if (subscription.expiresAt && new Date(subscription.expiresAt) < now) {
        this.subscriptions.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[SubscriptionManager] Cleaned up ${cleanedCount} expired subscriptions`);
    }

    return cleanedCount;
  }

  /**
   * Start cleanup timer (runs every 60 seconds)
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60000); // 60 seconds
  }

  /**
   * Get subscription stats
   */
  getStats(): {
    total: number;
    byTerminal: Record<string, number>;
    byType: Record<SubscriptionType, number>;
    byDeliveryMethod: Record<DeliveryMethod, number>;
  } {
    const stats = {
      total: this.subscriptions.size,
      byTerminal: {} as Record<string, number>,
      byType: {} as Record<SubscriptionType, number>,
      byDeliveryMethod: {} as Record<DeliveryMethod, number>,
    };

    for (const sub of this.subscriptions.values()) {
      stats.byTerminal[sub.terminal] = (stats.byTerminal[sub.terminal] || 0) + 1;
      stats.byType[sub.type] = (stats.byType[sub.type] || 0) + 1;
      stats.byDeliveryMethod[sub.deliveryMethod] = (stats.byDeliveryMethod[sub.deliveryMethod] || 0) + 1;
    }

    return stats;
  }
}

// Singleton instance
export const subscriptionManager = new SubscriptionManager();

// ─── Checkpoint Subscription System ─────────────────────────────────────────

/**
 * Checkpoint definition from EPICS.yaml
 */
interface Checkpoint {
  id: string;
  name: string;
  trigger_to: string | string[];  // Terminal(s) to notify
  condition: string;              // e.g., "MSG-FRONTEND-084 status=DONE"
  status: 'pending' | 'done';
}

interface EpicWithCheckpoints {
  id: string;
  name: string;
  checkpoints?: Checkpoint[];
}

/**
 * Parse EPICS.yaml and extract all checkpoint subscriptions
 * Returns list of checkpoints with their target terminals
 */
const SPACEOS_ROOT_DEFAULT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const DEFAULT_EPICS_PATH = process.env.EPICS_PATH || `${SPACEOS_ROOT_DEFAULT}/docs/projects/EPICS.yaml`;

export function parseCheckpointsFromEpics(epicsPath = DEFAULT_EPICS_PATH): {
  epicId: string;
  checkpoint: Checkpoint;
  terminals: string[];
  messageId: string | null;
}[] {
  try {
    const content = fs.readFileSync(epicsPath, 'utf-8');
    const data = yaml.load(content) as { epics: EpicWithCheckpoints[] };

    const results: {
      epicId: string;
      checkpoint: Checkpoint;
      terminals: string[];
      messageId: string | null;
    }[] = [];

    for (const epic of data.epics || []) {
      if (!epic.checkpoints) continue;

      for (const cp of epic.checkpoints) {
        // Parse terminals from trigger_to
        const terminals = Array.isArray(cp.trigger_to)
          ? cp.trigger_to
          : [cp.trigger_to];

        // Parse target from condition (e.g., "MSG-FRONTEND-084 status=DONE" or "EPIC-DATAHAVEN-UI status=done")
        const match = cp.condition.match(/^(MSG-[A-Z]+-\d+|EPIC-[A-Z0-9-]+)\s+status=(DONE|done)$/i);
        const messageId = match ? match[1] : null;

        results.push({
          epicId: epic.id,
          checkpoint: cp,
          terminals,
          messageId,
        });
      }
    }

    return results;
  } catch (error) {
    console.error('[SubscriptionManager] Error parsing EPICS.yaml:', error);
    return [];
  }
}

/**
 * Subscribe all terminals to their checkpoint events
 * Call this on service startup to auto-subscribe based on EPICS.yaml
 *
 * Returns number of subscriptions created
 */
export function subscribeToAllCheckpoints(
  epicsPath = DEFAULT_EPICS_PATH
): number {
  const checkpoints = parseCheckpointsFromEpics(epicsPath);
  let count = 0;

  for (const { epicId, checkpoint, terminals, messageId } of checkpoints) {
    // Skip if checkpoint is already done or no messageId
    if (checkpoint.status === 'done' || !messageId) {
      continue;
    }

    // Subscribe each terminal
    for (const terminal of terminals) {
      const subscription = subscriptionManager.subscribe({
        terminal,
        type: 'task',
        target: messageId,
        events: ['done'],
        deliveryMethod: 'telegram',
        expiresIn: 86400 * 30, // 30 days - checkpoints are long-lived
      });

      console.log(`[SubscriptionManager] Auto-subscribed ${terminal} to checkpoint ${checkpoint.id} (${messageId})`);
      count++;
    }
  }

  console.log(`[SubscriptionManager] Created ${count} checkpoint subscriptions from EPICS.yaml`);
  return count;
}

/**
 * Get pending checkpoints for an epic
 */
export function getPendingCheckpoints(epicId: string): Checkpoint[] {
  const checkpoints = parseCheckpointsFromEpics();
  return checkpoints
    .filter(cp => cp.epicId === epicId && cp.checkpoint.status === 'pending')
    .map(cp => cp.checkpoint);
}

/**
 * Get all checkpoint subscriptions status
 */
export function getCheckpointSubscriptionStatus(): {
  epicId: string;
  checkpointId: string;
  checkpointName: string;
  status: 'pending' | 'done';
  terminals: string[];
  messageId: string | null;
  hasSubscription: boolean;
}[] {
  const checkpoints = parseCheckpointsFromEpics();
  const currentSubs = subscriptionManager.getSubscriptions();

  return checkpoints.map(({ epicId, checkpoint, terminals, messageId }) => ({
    epicId,
    checkpointId: checkpoint.id,
    checkpointName: checkpoint.name,
    status: checkpoint.status,
    terminals,
    messageId,
    hasSubscription: messageId
      ? currentSubs.some(s => s.target === messageId)
      : false,
  }));
}
