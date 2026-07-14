/**
 * Mailbox Domain Service
 * Encapsulates mailbox business logic
 */

import { MessageEntity, InboxMessageBuilder, OutboxMessageBuilder } from './message.entity';
import { IMailboxRepository } from './mailbox.repository';
import { Message, MessageQuery, InboxMessageInput, OutboxMessageInput } from '../../core/types/message';
import { MessageStatus, BoxType, MessageType, Priority } from '../../core/types/common';
import { MessageNotFoundError, ValidationError } from '../../core/errors';
import { resolveTerminalName } from '../terminal/terminal.entity';

// ─── Service ──────────────────────────────────────────────────────────────────

export class MailboxService {
  constructor(private readonly repository: IMailboxRepository) {}

  // ─── Query Operations ───────────────────────────────────────────────────────

  async getMessage(messageId: string): Promise<MessageEntity> {
    const message = await this.repository.findById(messageId);
    if (!message) {
      throw new MessageNotFoundError(messageId);
    }
    return message;
  }

  async listInbox(
    terminal: string,
    status?: MessageStatus,
    limit?: number,
  ): Promise<MessageEntity[]> {
    const resolved = resolveTerminalName(terminal);
    return this.repository.query({
      terminal: resolved,
      box: 'inbox',
      status,
      limit,
    });
  }

  async listOutbox(
    terminal: string,
    status?: MessageStatus,
    limit?: number,
  ): Promise<MessageEntity[]> {
    const resolved = resolveTerminalName(terminal);
    return this.repository.query({
      terminal: resolved,
      box: 'outbox',
      status,
      limit,
    });
  }

  async getUnreadInbox(terminal: string): Promise<MessageEntity[]> {
    const resolved = resolveTerminalName(terminal);
    return this.repository.getUnread(resolved, 'inbox');
  }

  async getUnreadOutbox(terminal: string): Promise<MessageEntity[]> {
    const resolved = resolveTerminalName(terminal);
    return this.repository.getUnread(resolved, 'outbox');
  }

  async countUnread(terminal: string, box: BoxType): Promise<number> {
    const resolved = resolveTerminalName(terminal);
    return this.repository.countUnread(resolved, box);
  }

  async queryMessages(query: MessageQuery): Promise<MessageEntity[]> {
    return this.repository.query(query);
  }

  async findUnreadDones(): Promise<MessageEntity[]> {
    return this.repository.query({
      box: 'outbox',
      type: 'done',
      status: 'UNREAD',
    });
  }

  async findUnreadBlocked(): Promise<MessageEntity[]> {
    return this.repository.query({
      box: 'outbox',
      type: 'blocked',
      status: 'UNREAD',
    });
  }

  // ─── Command Operations ─────────────────────────────────────────────────────

  async sendMessage(input: InboxMessageInput): Promise<MessageEntity> {
    // Validate terminal names
    const toResolved = resolveTerminalName(input.to);

    // Create the message
    const message = await this.repository.createInboxMessage({
      ...input,
      to: toResolved as any,
    });

    return message;
  }

  async submitDone(input: OutboxMessageInput): Promise<MessageEntity> {
    if (input.type !== 'done') {
      throw new ValidationError('Use submitDone for DONE messages only');
    }

    const resolved = resolveTerminalName(input.terminal);
    return this.repository.createOutboxMessage({
      ...input,
      terminal: resolved as any,
    });
  }

  async submitBlocked(input: OutboxMessageInput): Promise<MessageEntity> {
    if (input.type !== 'blocked') {
      throw new ValidationError('Use submitBlocked for BLOCKED messages only');
    }

    if (!input.blockedBy) {
      throw new ValidationError('blockedBy is required for BLOCKED messages');
    }

    const resolved = resolveTerminalName(input.terminal);
    return this.repository.createOutboxMessage({
      ...input,
      terminal: resolved as any,
    });
  }

  async markAsRead(messageId: string, changedBy?: string): Promise<void> {
    const message = await this.getMessage(messageId);
    message.markAsRead();
    await this.repository.updateStatus(messageId, 'READ', changedBy);
  }

  async batchMarkAsRead(
    messageIds: string[],
    changedBy?: string,
  ): Promise<{ updated: number; failed: string[] }> {
    const updates = messageIds.map(messageId => ({
      messageId,
      status: 'READ' as MessageStatus,
      changedBy,
    }));

    return this.repository.batchUpdateStatus(updates);
  }

  async archive(messageId: string): Promise<void> {
    await this.repository.archive(messageId);
  }

  // ─── Sync Operations ────────────────────────────────────────────────────────

  async syncWithFilesystem(): Promise<{ registered: number; updated: number }> {
    return this.repository.syncWithFilesystem();
  }

  // ─── Builder Helpers ────────────────────────────────────────────────────────

  createInboxMessage(): InboxMessageBuilder {
    return new InboxMessageBuilder();
  }

  createOutboxMessage(): OutboxMessageBuilder {
    return new OutboxMessageBuilder();
  }
}
