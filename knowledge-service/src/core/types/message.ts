/**
 * Message Domain Types
 */

import {
  MessageStatus,
  MessageType,
  Priority,
  ModelType,
  BoxType,
} from './common';
import { TerminalName } from './terminal';

// ─── Message Frontmatter ──────────────────────────────────────────────────────

export interface MessageFrontmatter {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: MessageType;
  readonly priority: Priority;
  readonly status: MessageStatus;
  readonly model?: ModelType;
  readonly ref?: string;           // reference to related message
  readonly created: string;        // YYYY-MM-DD
  readonly epic?: string;          // linked epic ID
  readonly tags?: readonly string[];
}

// ─── Message Entity ───────────────────────────────────────────────────────────

export interface Message {
  readonly id: string;
  readonly terminal: string;
  readonly box: BoxType;
  readonly filePath: string;
  readonly fileName: string;
  readonly frontmatter: MessageFrontmatter;
  readonly content: string;
  readonly contentHash: string;
  readonly registeredAt: Date;
  readonly lastModified: Date;
}

// ─── Inbox Message (for sending) ──────────────────────────────────────────────

export interface InboxMessageInput {
  readonly to: TerminalName;
  readonly from: string;
  readonly type: MessageType;
  readonly priority: Priority;
  readonly model?: ModelType;
  readonly ref?: string;
  readonly epic?: string;
  readonly tags?: string[];
  readonly subject: string;
  readonly body: string;
}

// ─── Outbox Message (DONE/BLOCKED) ────────────────────────────────────────────

export interface OutboxMessageInput {
  readonly terminal: TerminalName;
  readonly type: 'done' | 'blocked';
  readonly ref: string;              // original inbox message ID
  readonly summary: string;
  readonly details?: string;
  readonly filesChanged?: string[];
  readonly nextSteps?: string[];
  readonly blockedBy?: string;       // for blocked messages
}

// ─── Message Query ────────────────────────────────────────────────────────────

export interface MessageQuery {
  readonly terminal?: string;
  readonly box?: BoxType;
  readonly status?: MessageStatus;
  readonly type?: MessageType;
  readonly priority?: Priority;
  readonly from?: string;
  readonly since?: Date;
  readonly limit?: number;
}

// ─── Message Events ───────────────────────────────────────────────────────────

export interface MessageSentEvent {
  readonly messageId: string;
  readonly terminal: string;
  readonly box: BoxType;
  readonly type: MessageType;
  readonly timestamp: Date;
}

export interface MessageReadEvent {
  readonly messageId: string;
  readonly terminal: string;
  readonly box: BoxType;
  readonly readBy: string;
  readonly timestamp: Date;
}
