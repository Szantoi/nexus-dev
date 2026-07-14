/**
 * Mailbox Repository Interface
 * Defines the contract for message persistence
 */

import { MessageEntity } from './message.entity';
import { Message, MessageQuery, InboxMessageInput, OutboxMessageInput } from '../../core/types/message';
import { MessageStatus, BoxType } from '../../core/types/common';

// ─── Repository Interface ─────────────────────────────────────────────────────

export interface IMailboxRepository {
  /**
   * Find a message by ID
   */
  findById(messageId: string): Promise<MessageEntity | null>;

  /**
   * Find a message by file path
   */
  findByFilePath(filePath: string): Promise<MessageEntity | null>;

  /**
   * Query messages with filters
   */
  query(query: MessageQuery): Promise<MessageEntity[]>;

  /**
   * Get unread messages for a terminal
   */
  getUnread(terminal: string, box: BoxType): Promise<MessageEntity[]>;

  /**
   * Count unread messages
   */
  countUnread(terminal: string, box: BoxType): Promise<number>;

  /**
   * Save a message (create or update)
   */
  save(message: MessageEntity): Promise<void>;

  /**
   * Update message status
   */
  updateStatus(messageId: string, status: MessageStatus, changedBy?: string): Promise<void>;

  /**
   * Batch update message status
   */
  batchUpdateStatus(
    updates: Array<{ messageId: string; status: MessageStatus; changedBy?: string }>
  ): Promise<{ updated: number; failed: string[] }>;

  /**
   * Create inbox message file
   */
  createInboxMessage(input: InboxMessageInput): Promise<MessageEntity>;

  /**
   * Create outbox message file
   */
  createOutboxMessage(input: OutboxMessageInput): Promise<MessageEntity>;

  /**
   * Get next sequence number for terminal
   */
  getNextSequence(terminal: string, box: BoxType): Promise<number>;

  /**
   * Archive a message (move to archive folder)
   */
  archive(messageId: string): Promise<void>;

  /**
   * Check if message content has changed (by hash)
   */
  hasContentChanged(messageId: string, contentHash: string): Promise<boolean>;

  /**
   * Sync with filesystem (for initial load)
   */
  syncWithFilesystem(): Promise<{ registered: number; updated: number }>;
}

// ─── Repository Events ────────────────────────────────────────────────────────

export interface MessageCreatedEvent {
  messageId: string;
  terminal: string;
  box: BoxType;
  type: string;
  timestamp: Date;
}

export interface MessageStatusChangedEvent {
  messageId: string;
  terminal: string;
  box: BoxType;
  previousStatus: MessageStatus;
  newStatus: MessageStatus;
  changedBy?: string;
  timestamp: Date;
}

export interface MessageArchivedEvent {
  messageId: string;
  terminal: string;
  box: BoxType;
  timestamp: Date;
}
