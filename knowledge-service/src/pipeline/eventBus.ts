/**
 * Event Bus for SpaceOS Pipeline
 *
 * Centralizes all pipeline events and enables:
 * - Real-time SSE streaming to dashboard
 * - Event-driven triggering (instead of polling)
 * - Audit trail of all pipeline activities
 *
 * 2026-06-24: Created as part of pipeline modernization
 */

import { EventEmitter } from 'events';

// ─── Event Types ─────────────────────────────────────────────────────────────

export type PipelineEventType =
  | 'inbox:new'           // New UNREAD message detected
  | 'inbox:read'          // Message marked as READ
  | 'outbox:done'         // DONE message in outbox
  | 'outbox:blocked'      // BLOCKED message in outbox
  | 'response:routed'     // Response message routed to target terminal (ISSUE-006)
  | 'session:started'     // Terminal session started
  | 'session:ended'       // Terminal session ended
  | 'session:stuck'       // Session detected as stuck
  | 'session:nudged'      // Session received nudge
  | 'review:started'      // DONE review started
  | 'review:approved'     // Review approved
  | 'review:rejected'     // Review rejected
  | 'pipeline:complete'   // Pipeline run completed
  | 'alert:critical'      // Critical alert triggered
  | 'alert:warning'       // Warning alert triggered
  | 'nightwatch:cycle'    // Nightwatch cycle completed
  | 'cache:invalidated';  // Cache was invalidated

export interface PipelineEvent {
  type: PipelineEventType;
  terminal?: string;
  messageId?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

// ─── Event Bus ───────────────────────────────────────────────────────────────

class PipelineEventBus extends EventEmitter {
  private recentEvents: PipelineEvent[] = [];
  private maxRecentEvents = 100;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Emit a pipeline event
   */
  emit(type: PipelineEventType, event?: Omit<PipelineEvent, 'type' | 'timestamp'>): boolean {
    const fullEvent: PipelineEvent = {
      type,
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Store in recent events
    this.recentEvents.push(fullEvent);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift();
    }

    // Emit to listeners
    return super.emit(type, fullEvent) || super.emit('*', fullEvent);
  }

  /**
   * Get recent events (for SSE reconnection)
   */
  getRecentEvents(since?: string, limit = 50): PipelineEvent[] {
    let events = this.recentEvents;

    if (since) {
      const sinceTime = new Date(since).getTime();
      events = events.filter(e => new Date(e.timestamp).getTime() > sinceTime);
    }

    return events.slice(-limit);
  }

  /**
   * Subscribe to all events
   */
  onAny(listener: (event: PipelineEvent) => void): void {
    this.on('*', listener);
  }

  /**
   * Get event statistics
   */
  getStats(): Record<PipelineEventType, number> {
    const stats: Partial<Record<PipelineEventType, number>> = {};
    for (const event of this.recentEvents) {
      stats[event.type] = (stats[event.type] || 0) + 1;
    }
    return stats as Record<PipelineEventType, number>;
  }
}

// Singleton instance
export const pipelineEvents = new PipelineEventBus();

// ─── Helper functions ────────────────────────────────────────────────────────

/**
 * Emit inbox event
 */
export function emitInboxEvent(
  type: 'inbox:new' | 'inbox:read',
  terminal: string,
  messageId: string,
  data?: Record<string, unknown>
): void {
  pipelineEvents.emit(type, { terminal, messageId, data });
}

/**
 * Emit outbox event
 */
export function emitOutboxEvent(
  type: 'outbox:done' | 'outbox:blocked',
  terminal: string,
  messageId: string,
  data?: Record<string, unknown>
): void {
  pipelineEvents.emit(type, { terminal, messageId, data });
}

/**
 * Emit session event
 */
export function emitSessionEvent(
  type: 'session:started' | 'session:ended' | 'session:stuck' | 'session:nudged',
  terminal: string,
  data?: Record<string, unknown>
): void {
  pipelineEvents.emit(type, { terminal, data });
}

/**
 * Emit review event
 */
export function emitReviewEvent(
  type: 'review:started' | 'review:approved' | 'review:rejected',
  terminal: string,
  messageId: string,
  data?: Record<string, unknown>
): void {
  pipelineEvents.emit(type, { terminal, messageId, data });
}

/**
 * Emit alert event
 */
export function emitAlert(
  level: 'critical' | 'warning',
  message: string,
  data?: Record<string, unknown>
): void {
  const type = level === 'critical' ? 'alert:critical' : 'alert:warning';
  pipelineEvents.emit(type, { data: { message, ...data } });
}

/**
 * Emit nightwatch cycle complete
 */
export function emitNightwatchCycle(result: Record<string, unknown>): void {
  pipelineEvents.emit('nightwatch:cycle', { data: result });
}
