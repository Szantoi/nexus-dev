/**
 * Focus Queue MCP tools — conductor priority tracking and task queue management.
 *
 * Tools: get_focus_queue, set_active_task, add_focus_item, set_task_status, set_focus_queue
 */

import { toolRegistry, success, error } from './base-tool';
import { TERMINALS } from '../../../identity';
import {
  setFocusQueue,
  addFocusItem,
  setActiveTask,
  setTaskBlocked,
  setTaskDone,
  removeFocusItem,
  getFocusQueue,
  clearDoneTasks,
  type FocusItem,
} from '../../../terminalStatus';

export function registerFocusQueueTools(): void {
  // ─── get_focus_queue ─────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_focus_queue',
      description:
        "Get the current focus queue - what the system is working on and what's next. Shows active task, queued items, and blocked items.",
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const focus = getFocusQueue();
      return success({
        summary: focus.summary,
        activeTask: focus.activeTask
          ? {
              id: focus.activeTask.id,
              terminal: focus.activeTask.terminal,
              title: focus.activeTask.title,
              priority: focus.activeTask.priority,
              startedAt: focus.activeTask.startedAt,
            }
          : null,
        queue: focus.queue.map((item) => ({
          id: item.id,
          terminal: item.terminal,
          title: item.title,
          priority: item.priority,
          status: item.status,
          blockedReason: item.blockedReason,
        })),
      });
    }
  );

  // ─── set_active_task ─────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'set_active_task',
      description:
        'Set the currently active task. Use this when switching focus to a new task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Task/message ID (e.g., MSG-BACKEND-042)',
          },
        },
        required: ['task_id'],
      },
    },
    async (args) => {
      const taskId = String(args.task_id || '');
      if (!taskId) {
        return error('task_id is required');
      }
      setActiveTask(taskId);
      const focus = getFocusQueue();
      return success({
        success: true,
        activeTask: taskId,
        summary: focus.summary,
      });
    }
  );

  // ─── add_focus_item ──────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'add_focus_item',
      description: 'Add a task to the focus queue.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Task/message ID',
          },
          terminal: {
            type: 'string',
            description: 'Target terminal',
          },
          title: {
            type: 'string',
            description: 'Short description of the task',
          },
          priority: {
            type: 'string',
            description: 'Task priority',
            enum: ['critical', 'high', 'medium', 'low'],
          },
        },
        required: ['id', 'terminal', 'title', 'priority'],
      },
    },
    async (args) => {
      const id = String(args.id || '');
      const terminal = String(args.terminal || '');
      const title = String(args.title || '');
      const priority = args.priority as 'critical' | 'high' | 'medium' | 'low';

      if (!id || !terminal || !title || !priority) {
        return error('id, terminal, title, and priority are required');
      }

      addFocusItem({ id, terminal, title, priority });
      const focus = getFocusQueue();
      return success({
        success: true,
        added: { id, terminal, title, priority },
        queueLength: focus.queue.length,
        summary: focus.summary,
      });
    }
  );

  // ─── set_task_status ─────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'set_task_status',
      description:
        'Update task status in the focus queue (blocked or done).',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Task/message ID',
          },
          status: {
            type: 'string',
            description: 'New status',
            enum: ['blocked', 'done'],
          },
          reason: {
            type: 'string',
            description: 'Reason for blocking (required if status=blocked)',
          },
        },
        required: ['task_id', 'status'],
      },
    },
    async (args) => {
      const taskId = String(args.task_id || '');
      const status = args.status as 'blocked' | 'done';
      const reason = args.reason ? String(args.reason) : undefined;

      if (!taskId || !status) {
        return error('task_id and status are required');
      }

      if (status === 'blocked') {
        if (!reason) {
          return error('reason is required when status is blocked');
        }
        setTaskBlocked(taskId, reason);
      } else if (status === 'done') {
        setTaskDone(taskId);
      }

      const focus = getFocusQueue();
      return success({
        success: true,
        taskId,
        newStatus: status,
        reason: reason || undefined,
        summary: focus.summary,
      });
    }
  );

  // ─── set_focus_queue ─────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'set_focus_queue',
      description:
        'Replace the entire focus queue with a new list. Used by Conductor to set priorities.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Array of focus items',
            items: {
              type: 'object',
            },
          },
        },
        required: ['items'],
      },
    },
    async (args) => {
      const items = args.items as Array<{
        id: string;
        terminal: string;
        title: string;
        priority: 'critical' | 'high' | 'medium' | 'low';
        status: 'queued' | 'active' | 'blocked' | 'done';
        blockedReason?: string;
      }>;

      if (!items || !Array.isArray(items)) {
        return error('items array is required');
      }

      setFocusQueue(items);
      const focus = getFocusQueue();
      return success({
        success: true,
        itemCount: items.length,
        activeTask: focus.activeTask?.id || null,
        summary: focus.summary,
      });
    }
  );
}
