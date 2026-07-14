/**
 * TaskMessageBox MCP Tools
 *
 * MCP tool handlers for TaskMessageBox operations.
 * These replace the old file-based mailbox tools.
 */

import {
  createTask,
  getMessage,
  readMessage,
  completeMessage,
  appendNote,
  getInbox,
  getOutbox,
  queryMessages,
} from './store';
import {
  CreateTaskInput,
  CompleteMessageInput,
  AppendNoteInput,
  Priority,
  Model,
  NoteSection,
} from './types';

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const TASK_MESSAGE_BOX_TOOLS = [
  {
    name: 'tmb_create_task',
    description: 'Create a task in TaskMessageBox (DB-backed). Auto-renders to .md file.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender terminal' },
        to: { type: 'string', description: 'Target terminal' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description (markdown)' },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Acceptance criteria list',
        },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
        epic_id: { type: 'string' },
        project_id: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['from', 'to', 'title', 'description', 'priority'],
    },
  },
  {
    name: 'tmb_read_message',
    description: 'Read a message by ID (marks as read). Returns full content.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID (e.g., MSG-BACKEND-042)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'tmb_complete_message',
    description: 'Complete a task with done/blocked status. Appends completion report.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'blocked'] },
        summary: { type: 'string' },
        details: { type: 'string' },
        files_changed: { type: 'array', items: { type: 'string' } },
        blocked_reason: { type: 'string' },
        next_steps: { type: 'string' },
      },
      required: ['message_id', 'status', 'summary'],
    },
  },
  {
    name: 'tmb_append_note',
    description: 'Append a note/progress to a message.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        section: { type: 'string', enum: ['notes', 'implementation', 'feedback', 'blockers', 'progress'] },
        content: { type: 'string' },
        author: { type: 'string' },
      },
      required: ['message_id', 'section', 'content'],
    },
  },
  {
    name: 'tmb_get_inbox',
    description: 'Get inbox messages for a terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: { type: 'string' },
        status: { type: 'string', enum: ['unread', 'read', 'all'] },
      },
      required: ['terminal'],
    },
  },
  {
    name: 'tmb_get_outbox',
    description: 'Get outbox messages (done/blocked) from a terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal: { type: 'string' },
      },
      required: ['terminal'],
    },
  },
];

// ─── Tool Handlers ───────────────────────────────────────────────────────────

export async function handleTaskMessageBoxTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    switch (toolName) {
      case 'tmb_create_task': {
        const input: CreateTaskInput = {
          from: String(args.from),
          to: String(args.to),
          title: String(args.title),
          description: String(args.description),
          acceptance_criteria: args.acceptance_criteria as string[] | undefined,
          priority: args.priority as Priority,
          model: args.model as Model | undefined,
          epic_id: args.epic_id ? String(args.epic_id) : undefined,
          project_id: args.project_id ? String(args.project_id) : undefined,
          context: args.context ? String(args.context) : undefined,
        };
        const result = await createTask(input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'tmb_read_message': {
        const result = await readMessage(String(args.message_id));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'tmb_complete_message': {
        const input: CompleteMessageInput = {
          message_id: String(args.message_id),
          status: args.status as 'completed' | 'blocked',
          summary: String(args.summary),
          details: args.details ? String(args.details) : undefined,
          files_changed: args.files_changed as string[] | undefined,
          blocked_reason: args.blocked_reason ? String(args.blocked_reason) : undefined,
          next_steps: args.next_steps ? String(args.next_steps) : undefined,
        };
        const result = await completeMessage(input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'tmb_append_note': {
        const input: AppendNoteInput = {
          message_id: String(args.message_id),
          section: args.section as NoteSection,
          content: String(args.content),
          author: args.author ? String(args.author) : undefined,
        };
        const result = await appendNote(input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'tmb_get_inbox': {
        const result = await getInbox(
          String(args.terminal),
          args.status as 'unread' | 'read' | 'all' | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'tmb_get_outbox': {
        const result = await getOutbox(String(args.terminal));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
        };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
    };
  }
}
