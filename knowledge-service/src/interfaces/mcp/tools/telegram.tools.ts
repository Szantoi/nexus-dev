/**
 * Telegram MCP tools — messaging, broadcast, and conversation history.
 *
 * Tools: telegram_reply, telegram_broadcast, get_telegram_history, request_review
 */

import { toolRegistry, success, error, type ToolContext } from './base-tool';
import { TERMINALS } from '../../../identity';
import { logger } from '../../../core/logger';
import {
  queueResponse,
  getConversation,
  findActiveConversation,
  createConversation,
  getConversationMessages,
  addMessage,
  getLastIncomingMessageId,
} from '../../../telegram/conversationManager';
import { sendTelegramMessage, injectMessageToTerminal } from '../../../telegram/telegramService';

export function registerTelegramTools(): void {
  // ─── telegram_reply ──────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'telegram_reply',
      description:
        'Send a reply to a Telegram user. Use this to respond to messages from Telegram. The message will be queued and sent asynchronously. IMPORTANT: Include from_terminal to route via the correct bot.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'number',
            description: 'Telegram chat ID to send to',
          },
          message: {
            type: 'string',
            description: 'Message content to send',
          },
          from_terminal: {
            type: 'string',
            description: 'Terminal sending this reply (conductor, backend, frontend, architect, librarian). Required for routing to correct bot.',
          },
          conversation_id: {
            type: 'number',
            description: 'Optional conversation ID for threading context',
          },
          reply_to_message_id: {
            type: 'number',
            description: 'Optional Telegram message ID to reply to (for threading)',
          },
          parse_mode: {
            type: 'string',
            description: 'Message format (default: HTML)',
            enum: ['HTML', 'Markdown'],
          },
        },
        required: ['chat_id', 'message'],
      },
    },
    async (args, ctx) => {
      const callerTerminal = ctx.terminal;
      const chatId = Number(args.chat_id);
      const message = String(args.message || '');
      const fromTerminal = args.from_terminal ? String(args.from_terminal) : (callerTerminal || 'unknown');
      let conversationId = args.conversation_id ? Number(args.conversation_id) : undefined;
      const replyToMessageId = args.reply_to_message_id ? Number(args.reply_to_message_id) : undefined;
      const parseMode = (args.parse_mode as 'HTML' | 'Markdown') || 'HTML';

      if (!chatId || !message) {
        return error('chat_id and message are required');
      }

      // ADR-060: Always record outgoing messages in DB
      if (!conversationId) {
        try {
          const existingConv = findActiveConversation(chatId);
          if (existingConv) {
            conversationId = existingConv.id;
          } else {
            const newConv = createConversation({
              chatId,
              userId: 0,
              username: undefined,
              contextTerminal: fromTerminal,
            });
            conversationId = newConv.id;
          }
        } catch (err) {
          logger.warn('[MCP] telegram_reply: Failed to get/create conversation:', err);
        }
      }

      const queueItem = queueResponse({
        chatId,
        conversationId,
        message,
        replyToMessageId,
        fromTerminal,
        parseMode,
      });

      if (conversationId) {
        try {
          const lastMsgId = getLastIncomingMessageId(conversationId);
          addMessage({
            conversationId,
            telegramMessageId: 0,
            direction: 'out',
            content: message,
            fromTerminal,
            replyToMessageId: replyToMessageId || lastMsgId || undefined,
          });
          logger.info(`[MCP] telegram_reply: Saved outgoing message to conversation ${conversationId}`);
        } catch (err) {
          logger.warn('[MCP] telegram_reply: Failed to save message to conversation:', err);
        }
      }

      return success({
        success: true,
        queueId: queueItem.id,
        chatId,
        conversationId,
        fromTerminal,
        status: 'queued',
        messageRecorded: !!conversationId,
      });
    }
  );

  // ─── telegram_broadcast ──────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'telegram_broadcast',
      description:
        'Broadcast a message to specific terminals via Telegram. The message will be injected into the target terminal(s) tmux session(s).',
      inputSchema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            description: 'Terminal names to send to (e.g., ["backend", "frontend"])',
            items: { type: 'string' },
          },
          message: {
            type: 'string',
            description: 'Message content to broadcast',
          },
          priority: {
            type: 'string',
            description: 'Message priority (default: medium)',
            enum: ['critical', 'high', 'medium', 'low'],
          },
        },
        required: ['targets', 'message'],
      },
    },
    async (args, ctx) => {
      const callerTerminal = ctx.terminal;
      const targets = args.targets as string[];
      const message = String(args.message || '');
      const priority = (args.priority as string) || 'medium';

      if (!targets || targets.length === 0 || !message) {
        return error('targets array and message are required');
      }

      const results: Array<{ terminal: string; success: boolean; error?: string }> = [];

      for (const target of targets) {
        try {
          const injected = await injectMessageToTerminal(
            target,
            message,
            callerTerminal || 'unknown',
            priority
          );
          results.push({ terminal: target, success: injected });
        } catch (err) {
          results.push({
            terminal: target,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const successCount = results.filter(r => r.success).length;

      return success({
        success: successCount > 0,
        totalTargets: targets.length,
        successCount,
        failedCount: targets.length - successCount,
        results,
        fromTerminal: callerTerminal,
      });
    }
  );

  // ─── get_telegram_history ────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'get_telegram_history',
      description:
        'Get conversation history from Telegram. Returns recent messages from a specific chat or conversation for context-aware responses.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'number',
            description: 'Telegram chat ID to fetch history from',
          },
          conversation_id: {
            type: 'number',
            description: 'Optional conversation ID to filter by specific conversation thread',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of messages to return (default: 10, max: 50)',
          },
        },
        required: ['chat_id'],
      },
    },
    async (args) => {
      const chatId = Number(args.chat_id);
      const conversationId = args.conversation_id ? Number(args.conversation_id) : undefined;
      const limit = args.limit ? Math.min(Number(args.limit), 50) : 10;

      if (!chatId) {
        return error('chat_id is required');
      }

      let conversation: ReturnType<typeof getConversation> | ReturnType<typeof findActiveConversation>;
      if (conversationId) {
        conversation = getConversation(conversationId);
      } else {
        conversation = findActiveConversation(chatId);
      }

      if (!conversation) {
        return success({
          success: false,
          error: 'No conversation found for this chat_id',
          chatId,
        });
      }

      const messages = getConversationMessages(conversation.id, limit);

      return success({
        success: true,
        chatId: conversation.chatId,
        conversationId: conversation.id,
        username: conversation.username,
        contextTerminal: conversation.contextTerminal,
        totalMessages: messages.length,
        messages: messages.map(msg => ({
          id: msg.id,
          direction: msg.direction,
          content: msg.content,
          fromTerminal: msg.fromTerminal,
          timestamp: msg.createdAt,
        })),
      });
    }
  );

  // ─── request_review ──────────────────────────────────────────────────────────
  toolRegistry.register(
    {
      name: 'request_review',
      description:
        'Request review from architect or librarian terminal. Returns APPROVE/REJECT verdict with feedback. Replaces tmux-based review with MCP session management.',
      inputSchema: {
        type: 'object',
        properties: {
          reviewer: {
            type: 'string',
            description: 'Which terminal performs the review',
            enum: ['architect', 'librarian'],
          },
          inbox_message_id: {
            type: 'string',
            description: 'Original inbox task message ID (e.g., MSG-BACKEND-042)',
          },
          done_message_id: {
            type: 'string',
            description: 'DONE outbox message ID to review (e.g., MSG-BACKEND-042-DONE)',
          },
        },
        required: ['reviewer', 'inbox_message_id', 'done_message_id'],
      },
    },
    async (args) => {
      const reviewer = String(args.reviewer || '');
      const inboxMessageId = String(args.inbox_message_id || '');
      const doneMessageId = String(args.done_message_id || '');

      if (!['architect', 'librarian'].includes(reviewer)) {
        return error(`Invalid reviewer: ${reviewer}. Must be "architect" or "librarian"`);
      }

      if (!inboxMessageId || !doneMessageId) {
        return error('inbox_message_id and done_message_id are required');
      }

      // For now, create a review task in the reviewer's inbox
      // Full implementation would spawn a review session
      const { createTask } = await import('../../../mailbox');
      const result = await createTask({
        from: 'system',
        to: reviewer,
        title: `Review: ${doneMessageId}`,
        description: `Please review the completed task:\n\n- Original task: ${inboxMessageId}\n- DONE message: ${doneMessageId}`,
        priority: 'high',
      });

      return success({
        success: true,
        reviewer,
        inboxMessageId,
        doneMessageId,
        reviewTaskId: result.id,
        message: `Review request sent to ${reviewer}`,
      });
    }
  );
}
