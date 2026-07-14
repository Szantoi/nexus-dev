/**
 * Subscription MCP Tools
 *
 * Implements ADR-052: FSM Subscription System
 * Provides 4 MCP tools for event subscription management
 *
 * 2026-06-30: Phase 1 Core Implementation
 */

import {
  subscriptionManager,
  subscribeToAllCheckpoints,
  getCheckpointSubscriptionStatus,
  type SubscribeParams,
} from './subscriptionManager';

// ─── MCP Tool Handlers ────────────────────────────────────────────────────────

/**
 * subscribe_to_task
 *
 * Subscribe to task state changes (done, blocked, progress)
 */
export function handleSubscribeToTask(args: any): any {
  const { terminal, task_id, events, delivery_method = 'auto', expires_in = 3600 } = args;

  if (!terminal || !task_id || !events || !Array.isArray(events)) {
    return {
      success: false,
      error: 'Missing required parameters: terminal, task_id, events (array)',
    };
  }

  try {
    const subscription = subscriptionManager.subscribe({
      terminal,
      type: 'task',
      target: task_id,
      events,
      deliveryMethod: delivery_method,
      expiresIn: expires_in,
    });

    return {
      success: true,
      subscription: {
        id: subscription.id,
        terminal: subscription.terminal,
        type: subscription.type,
        target: subscription.target,
        events: subscription.events,
        deliveryMethod: subscription.deliveryMethod,
        createdAt: subscription.createdAt,
        expiresAt: subscription.expiresAt,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to create subscription',
    };
  }
}

/**
 * subscribe_to_terminal
 *
 * Subscribe to terminal events (inbox, outbox, session)
 */
export function handleSubscribeToTerminal(args: any): any {
  const { terminal, target_terminal, events, delivery_method = 'auto', expires_in = 3600 } = args;

  if (!terminal || !target_terminal || !events || !Array.isArray(events)) {
    return {
      success: false,
      error: 'Missing required parameters: terminal, target_terminal, events (array)',
    };
  }

  try {
    const subscription = subscriptionManager.subscribe({
      terminal,
      type: 'terminal',
      target: target_terminal,
      events,
      deliveryMethod: delivery_method,
      expiresIn: expires_in,
    });

    return {
      success: true,
      subscription: {
        id: subscription.id,
        terminal: subscription.terminal,
        type: subscription.type,
        target: subscription.target,
        events: subscription.events,
        deliveryMethod: subscription.deliveryMethod,
        createdAt: subscription.createdAt,
        expiresAt: subscription.expiresAt,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to create subscription',
    };
  }
}

/**
 * unsubscribe
 *
 * Unsubscribe from events by subscription ID
 */
export function handleUnsubscribe(args: any): any {
  const { subscription_id } = args;

  if (!subscription_id) {
    return {
      success: false,
      error: 'Missing required parameter: subscription_id',
    };
  }

  try {
    const removed = subscriptionManager.unsubscribe(subscription_id);

    if (!removed) {
      return {
        success: false,
        error: 'Subscription not found',
      };
    }

    return {
      success: true,
      message: `Subscription ${subscription_id} removed`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to unsubscribe',
    };
  }
}

/**
 * get_subscriptions
 *
 * List active subscriptions for a terminal
 */
export function handleGetSubscriptions(args: any): any {
  const { terminal } = args;

  try {
    const subscriptions = subscriptionManager.getSubscriptions(terminal);
    const stats = subscriptionManager.getStats();

    return {
      success: true,
      subscriptions: subscriptions.map(sub => ({
        id: sub.id,
        terminal: sub.terminal,
        type: sub.type,
        target: sub.target,
        events: sub.events,
        deliveryMethod: sub.deliveryMethod,
        createdAt: sub.createdAt,
        expiresAt: sub.expiresAt,
      })),
      stats: terminal ? undefined : stats,
      count: subscriptions.length,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to get subscriptions',
    };
  }
}

/**
 * get_checkpoint_status
 *
 * Get all checkpoint subscriptions status from EPICS.yaml
 */
export function handleGetCheckpointStatus(): any {
  try {
    const checkpoints = getCheckpointSubscriptionStatus();

    return {
      success: true,
      checkpoints: checkpoints.map(cp => ({
        epicId: cp.epicId,
        checkpointId: cp.checkpointId,
        name: cp.checkpointName,
        status: cp.status,
        terminals: cp.terminals,
        targetId: cp.messageId,
        hasSubscription: cp.hasSubscription,
      })),
      summary: {
        total: checkpoints.length,
        pending: checkpoints.filter(cp => cp.status === 'pending').length,
        done: checkpoints.filter(cp => cp.status === 'done').length,
        subscribed: checkpoints.filter(cp => cp.hasSubscription).length,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to get checkpoint status',
    };
  }
}

/**
 * refresh_checkpoint_subscriptions
 *
 * Re-scan EPICS.yaml and subscribe to all pending checkpoints
 */
export function handleRefreshCheckpointSubscriptions(): any {
  try {
    const count = subscribeToAllCheckpoints();
    const status = getCheckpointSubscriptionStatus();

    return {
      success: true,
      subscriptionsCreated: count,
      pendingCheckpoints: status.filter(s => s.status === 'pending').length,
      message: count > 0
        ? `Created ${count} new checkpoint subscriptions`
        : 'No new checkpoint subscriptions needed',
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to refresh checkpoint subscriptions',
    };
  }
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const SUBSCRIPTION_TOOLS = [
  {
    name: 'subscribe_to_task',
    description: 'Subscribe to task state changes (done, blocked, progress). Receive push notifications when task state changes.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Terminal name (e.g., architect, backend, conductor)',
        },
        task_id: {
          type: 'string',
          description: 'Task message ID to monitor (e.g., MSG-BACKEND-045)',
        },
        events: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['done', 'blocked', 'progress'],
          },
          description: 'Events to subscribe to',
        },
        delivery_method: {
          type: 'string',
          enum: ['sse', 'telegram', 'inbox', 'auto'],
          description: 'Preferred delivery method (default: auto - SSE if active, Telegram if not)',
        },
        expires_in: {
          type: 'number',
          description: 'Expiration in seconds (default: 3600, max: 86400)',
        },
      },
      required: ['terminal', 'task_id', 'events'],
    },
  },
  {
    name: 'subscribe_to_terminal',
    description: 'Subscribe to terminal events (inbox_new, outbox_done, session events). Receive push notifications when terminal state changes.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Subscribing terminal name',
        },
        target_terminal: {
          type: 'string',
          description: 'Terminal to watch',
        },
        events: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['inbox_new', 'outbox_done', 'session_started', 'session_ended'],
          },
          description: 'Events to subscribe to',
        },
        delivery_method: {
          type: 'string',
          enum: ['sse', 'telegram', 'inbox', 'auto'],
          description: 'Preferred delivery method (default: auto)',
        },
        expires_in: {
          type: 'number',
          description: 'Expiration in seconds (default: 3600)',
        },
      },
      required: ['terminal', 'target_terminal', 'events'],
    },
  },
  {
    name: 'unsubscribe',
    description: 'Unsubscribe from events by subscription ID. Stops receiving push notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription_id: {
          type: 'string',
          description: 'Subscription ID to cancel (returned from subscribe_to_task or subscribe_to_terminal)',
        },
      },
      required: ['subscription_id'],
    },
  },
  {
    name: 'get_subscriptions',
    description: 'List active subscriptions for a terminal (or all if no terminal specified). Shows all active event subscriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: {
          type: 'string',
          description: 'Terminal name to filter subscriptions (optional - omit for all subscriptions)',
        },
      },
    },
  },
  {
    name: 'get_checkpoint_status',
    description: 'Get all checkpoint subscriptions status from EPICS.yaml. Shows which checkpoints are pending/done and which terminals are subscribed.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'refresh_checkpoint_subscriptions',
    description: 'Re-scan EPICS.yaml and subscribe to all pending checkpoints. Use after adding new epics or checkpoints.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Handle subscription tool call
 */
export function handleSubscriptionTool(toolName: string, args: any): any {
  switch (toolName) {
    case 'subscribe_to_task':
      return handleSubscribeToTask(args);

    case 'subscribe_to_terminal':
      return handleSubscribeToTerminal(args);

    case 'unsubscribe':
      return handleUnsubscribe(args);

    case 'get_subscriptions':
      return handleGetSubscriptions(args);

    case 'get_checkpoint_status':
      return handleGetCheckpointStatus();

    case 'refresh_checkpoint_subscriptions':
      return handleRefreshCheckpointSubscriptions();

    default:
      return {
        success: false,
        error: `Unknown subscription tool: ${toolName}`,
      };
  }
}
