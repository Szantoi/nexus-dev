/**
 * Mailbox MCP tools — inbox/outbox message management and task routing.
 *
 * Tools: list_inbox, create_task, send_message, submit_done, read_inbox_message,
 *        complete_inbox_message, append_to_message, get_task_status,
 *        fetch_task, ack_task, complete_task
 */

import { toolRegistry, success, error, type ToolContext } from './base-tool';
import { TERMINALS } from '../../../identity';
import {
  listInbox,
  listInboxMetadata,
  sendMessage,
  submitDone,
  getTaskStatus,
  readInboxMessage,
  completeInboxMessage,
  appendToMessage,
  createTask,
} from '../../../mailbox';
import {
  fetchTaskForMcp,
  ackTaskForMcp,
  completeTaskForMcp,
} from '../../http/routes/epic-router.routes';

export function registerMailboxTools(): void {
  // ─── list_inbox ──────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'list_inbox',
      description:
        'List inbox messages for a terminal. Returns metadata (frontmatter + filename) by default. Set include_content=true for full message content (10× heavier).',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          status: {
            type: 'string',
            description: 'Filter by status (default: all)',
            enum: ['UNREAD', 'READ', 'all'],
          },
          include_content: {
            type: 'boolean',
            description: 'Include full message content (default: false, metadata only for performance)',
          },
        },
        required: ['terminal'],
      },
    },
    async (args) => {
      const terminal = String(args.terminal || '');
      const status = (args.status as 'UNREAD' | 'READ' | 'all') || 'all';
      const includeContent = args.include_content === true;

      if (includeContent) {
        const messages = await listInbox(terminal, status);
        return success({ terminal, status, count: messages.length, messages });
      } else {
        const messages = await listInboxMetadata(terminal, status);
        return success({ terminal, status, count: messages.length, messages });
      }
    }
  );

  // ─── create_task ─────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'create_task',
      description:
        'Create a structured task for a terminal. Includes title, description, acceptance criteria, and tracks sender. Generates content hash for integrity.',
      inputSchema: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: 'Sender terminal name (e.g., "root", "conductor")',
          },
          to: {
            type: 'string',
            description: `Target terminal: ${TERMINALS.slice(0, 10).join(', ')}...`,
          },
          title: {
            type: 'string',
            description: 'Short task title',
          },
          description: {
            type: 'string',
            description: 'Task description (markdown)',
          },
          acceptance_criteria: {
            type: 'array',
            description: 'List of acceptance criteria (what defines "done")',
            items: { type: 'string' },
          },
          priority: {
            type: 'string',
            description: 'Task priority',
            enum: ['critical', 'high', 'medium', 'low'],
          },
          model: {
            type: 'string',
            description: 'Suggested model for processing',
            enum: ['opus', 'sonnet', 'haiku'],
          },
          ref: {
            type: 'string',
            description: 'Reference to related message ID (optional)',
          },
          epic_id: {
            type: 'string',
            description: 'Epic ID (e.g., "EPIC-CUTTING-Q3")',
          },
          project_id: {
            type: 'string',
            description: 'Project ID',
          },
          context: {
            type: 'string',
            description: 'Additional context (markdown)',
          },
          queue_only: {
            type: 'boolean',
            description: 'Add to queue instead of immediate dispatch',
          },
        },
        required: ['from', 'to', 'title', 'description', 'priority'],
      },
    },
    async (args, context) => {
      const callerTerminal = context.terminal;
      const fromTerminal = args.from ? String(args.from) : (callerTerminal || 'unknown');

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      // Root and conductor can create tasks for anyone
      if (callerTerminal !== 'root' && callerTerminal !== 'conductor') {
        return error(`Terminal ${callerTerminal} cannot create tasks. Only root and conductor can dispatch tasks.`);
      }

      const result = await createTask({
        from: fromTerminal,
        to: String(args.to),
        title: String(args.title),
        description: String(args.description),
        acceptance_criteria: args.acceptance_criteria as string[] | undefined,
        priority: String(args.priority) as 'critical' | 'high' | 'medium' | 'low',
        model: args.model ? String(args.model) as 'haiku' | 'sonnet' | 'opus' : undefined,
        ref: args.ref ? String(args.ref) : undefined,
        epic_id: args.epic_id ? String(args.epic_id) : undefined,
        project_id: args.project_id ? String(args.project_id) : undefined,
        context: args.context ? String(args.context) : undefined,
        queue_only: args.queue_only === true,
      });
      return success(result);
    }
  );

  // ─── send_message ────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'send_message',
      description:
        '[LEGACY - use create_task for tasks] Send a new inbox message to a terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Target terminal name',
          },
          type: {
            type: 'string',
            description: 'Message type',
            enum: ['task', 'question', 'info', 'blocked'],
          },
          content: {
            type: 'string',
            description: 'Message content (markdown)',
          },
          priority: {
            type: 'string',
            description: 'Message priority',
            enum: ['critical', 'high', 'medium', 'low'],
          },
          model: {
            type: 'string',
            description: 'Suggested model for processing',
            enum: ['opus', 'sonnet', 'haiku'],
          },
          ref: {
            type: 'string',
            description: 'Reference to related message ID (optional)',
          },
        },
        required: ['to', 'type', 'content', 'priority'],
      },
    },
    async (args) => {
      const result = await sendMessage({
        to: String(args.to),
        type: String(args.type) as 'task' | 'question' | 'done' | 'blocked',
        content: String(args.content),
        priority: String(args.priority) as 'critical' | 'high' | 'medium' | 'low',
        model: args.model ? String(args.model) as 'haiku' | 'sonnet' | 'opus' : undefined,
        ref: args.ref ? String(args.ref) : undefined,
      });
      return success({ success: true, ...result });
    }
  );

  // ─── submit_done ─────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'submit_done',
      description:
        'Submit a DONE message to the outbox. Used when a task is completed.',
      inputSchema: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: 'Terminal name submitting the DONE',
          },
          task_id: {
            type: 'string',
            description: 'Original task message ID (e.g., MSG-KERNEL-042)',
          },
          summary: {
            type: 'string',
            description: 'Summary of what was done',
          },
          files_changed: {
            type: 'array',
            description: 'List of files that were changed',
            items: { type: 'string' },
          },
        },
        required: ['from', 'task_id', 'summary', 'files_changed'],
      },
    },
    async (args) => {
      const result = await submitDone({
        from: String(args.from),
        task_id: String(args.task_id),
        summary: String(args.summary),
        files_changed: args.files_changed as string[],
      });
      return success({ success: true, ...result });
    }
  );

  // ─── read_inbox_message ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'read_inbox_message',
      description:
        'Read a specific inbox message by ID. Automatically marks as READ. Use this instead of direct file access for audit trail.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          message_id: {
            type: 'string',
            description: 'Message ID to read (e.g., MSG-BACKEND-042)',
          },
        },
        required: ['terminal', 'message_id'],
      },
    },
    async (args, context) => {
      const terminal = String(args.terminal || '');
      const messageId = String(args.message_id || '');
      const callerTerminal = context.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== terminal) {
        return error(`Terminal ${callerTerminal} cannot read inbox for terminal ${terminal}`);
      }

      const result = await readInboxMessage(terminal, messageId);
      return success(result);
    }
  );

  // ─── complete_inbox_message ──────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'complete_inbox_message',
      description:
        'Complete a task with DONE or BLOCKED status. Server appends completion report to original inbox AND creates outbox summary. Terminal only sends response data.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          message_id: {
            type: 'string',
            description: 'Original inbox message ID to complete (e.g., MSG-BACKEND-042)',
          },
          status: {
            type: 'string',
            description: 'Completion status',
            enum: ['done', 'blocked'],
          },
          summary: {
            type: 'string',
            description: 'Short summary of what was done or why blocked',
          },
          details: {
            type: 'string',
            description: 'Detailed implementation notes (optional)',
          },
          files_changed: {
            type: 'array',
            description: 'List of changed files (for DONE)',
            items: { type: 'string' },
          },
          blocked_reason: {
            type: 'string',
            description: 'Why the task is blocked (for BLOCKED)',
          },
          next_steps: {
            type: 'string',
            description: 'Suggested next steps (optional)',
          },
        },
        required: ['terminal', 'message_id', 'status', 'summary'],
      },
    },
    async (args, context) => {
      const terminal = String(args.terminal || '');
      const callerTerminal = context.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== terminal) {
        return error(`Terminal ${callerTerminal} cannot complete tasks for terminal ${terminal}`);
      }

      const result = await completeInboxMessage({
        terminal,
        message_id: String(args.message_id || ''),
        status: args.status as 'done' | 'blocked',
        summary: String(args.summary || ''),
        details: args.details ? String(args.details) : undefined,
        files_changed: args.files_changed as string[] | undefined,
        blocked_reason: args.blocked_reason ? String(args.blocked_reason) : undefined,
        next_steps: args.next_steps ? String(args.next_steps) : undefined,
      });
      return success(result);
    }
  );

  // ─── append_to_message ───────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'append_to_message',
      description:
        'Append notes, implementation details, feedback, or progress to an existing inbox/outbox message. Makes the task file a living document.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          message_id: {
            type: 'string',
            description: 'Message ID to append to',
          },
          box: {
            type: 'string',
            description: 'Which box the message is in',
            enum: ['inbox', 'outbox'],
          },
          section: {
            type: 'string',
            description: 'Type of content being appended',
            enum: ['notes', 'implementation', 'feedback', 'blockers', 'progress'],
          },
          content: {
            type: 'string',
            description: 'Content to append (markdown)',
          },
          author: {
            type: 'string',
            description: 'Author of the note (optional, defaults to terminal name)',
          },
        },
        required: ['terminal', 'message_id', 'box', 'section', 'content'],
      },
    },
    async (args, context) => {
      const terminal = String(args.terminal || '');
      const callerTerminal = context.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== terminal) {
        return error(`Terminal ${callerTerminal} cannot append to messages for terminal ${terminal}`);
      }

      const result = await appendToMessage({
        terminal,
        messageId: String(args.message_id || ''),
        box: args.box as 'inbox' | 'outbox',
        section: args.section as 'notes' | 'implementation' | 'feedback' | 'blockers' | 'progress',
        content: String(args.content || ''),
        author: args.author ? String(args.author) : callerTerminal,
      });
      return success(result);
    }
  );

  // ─── get_task_status ─────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_task_status',
      description:
        'Get status of tasks from docs/tasks/. Returns task metadata and status.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Specific task ID to query (optional, returns all if omitted)',
          },
        },
      },
    },
    async (args) => {
      const taskId = args.task_id ? String(args.task_id) : undefined;
      const tasks = await getTaskStatus(taskId);
      return success({ count: tasks.length, tasks });
    }
  );

  // ─── fetch_task ──────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'fetch_task',
      description:
        'Fetch assigned task content. Terminal can ONLY fetch the task currently assigned to it. Token authentication via MCP config.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          message_id: {
            type: 'string',
            description: 'The task message ID (e.g., MSG-BACKEND-045)',
          },
        },
        required: ['terminal', 'message_id'],
      },
    },
    async (args, context) => {
      const terminal = String(args.terminal || '');
      const messageId = String(args.message_id || '');
      const callerTerminal = context.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== terminal) {
        return error(`Terminal ${callerTerminal} cannot fetch tasks for terminal ${terminal}`);
      }

      const result = await fetchTaskForMcp(terminal, messageId);
      return success(result);
    }
  );

  // ─── ack_task ────────────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'ack_task',
      description:
        'Acknowledge task receipt. Marks the task as READ. Terminal must be authenticated.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          message_id: {
            type: 'string',
            description: 'The task message ID to acknowledge',
          },
        },
        required: ['terminal', 'message_id'],
      },
    },
    async (args, context) => {
      const terminal = String(args.terminal || '');
      const messageId = String(args.message_id || '');
      const callerTerminal = context.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== terminal) {
        return error(`Terminal ${callerTerminal} cannot acknowledge tasks for terminal ${terminal}`);
      }

      const result = await ackTaskForMcp(terminal, messageId);
      return success(result);
    }
  );

  // ─── complete_task ───────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'complete_task',
      description:
        'Mark task as completed. Triggers epic-aware routing to find next task. In cold mode, terminates session after completion. Terminal must be authenticated.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: {
            type: 'string',
            description: `Terminal name: ${TERMINALS.join(', ')}`,
          },
          message_id: {
            type: 'string',
            description: 'The task message ID to complete',
          },
          summary: {
            type: 'string',
            description: 'Task summary for memory save (used in cold session mode to persist session context)',
          },
        },
        required: ['terminal', 'message_id'],
      },
    },
    async (args, context) => {
      const terminal = String(args.terminal || '');
      const messageId = String(args.message_id || '');
      const summary = args.summary ? String(args.summary) : undefined;
      const callerTerminal = context.terminal;

      if (!callerTerminal) {
        return error('Caller terminal not identified. Check MCP token configuration.');
      }

      if (callerTerminal !== 'root' && callerTerminal !== terminal) {
        return error(`Terminal ${callerTerminal} cannot complete tasks for terminal ${terminal}`);
      }

      const result = await completeTaskForMcp(terminal, messageId, summary, context.island);
      return success(result);
    }
  );
}
