/**
 * Message Entity
 * Aggregate root for mailbox domain
 */

import {
  Message,
  MessageFrontmatter,
  InboxMessageInput,
  OutboxMessageInput,
} from '../../core/types/message';
import {
  MessageStatus,
  MessageType,
  Priority,
  ModelType,
  BoxType,
} from '../../core/types/common';
import { ValidationError, MessageAlreadyReadError } from '../../core/errors';
import * as crypto from 'crypto';

// ─── Message Entity ───────────────────────────────────────────────────────────

export class MessageEntity {
  private constructor(
    private readonly _id: string,
    private readonly _terminal: string,
    private readonly _box: BoxType,
    private readonly _filePath: string,
    private readonly _fileName: string,
    private readonly _frontmatter: MessageFrontmatter,
    private readonly _content: string,
    private readonly _contentHash: string,
    private readonly _registeredAt: Date,
    private _status: MessageStatus,
    private _lastModified: Date,
  ) {}

  // ─── Getters ────────────────────────────────────────────────────────────────

  get id(): string {
    return this._id;
  }

  get terminal(): string {
    return this._terminal;
  }

  get box(): BoxType {
    return this._box;
  }

  get filePath(): string {
    return this._filePath;
  }

  get fileName(): string {
    return this._fileName;
  }

  get frontmatter(): MessageFrontmatter {
    return this._frontmatter;
  }

  get content(): string {
    return this._content;
  }

  get contentHash(): string {
    return this._contentHash;
  }

  get status(): MessageStatus {
    return this._status;
  }

  get type(): MessageType {
    return this._frontmatter.type;
  }

  get priority(): Priority {
    return this._frontmatter.priority;
  }

  get model(): ModelType | undefined {
    return this._frontmatter.model;
  }

  get from(): string {
    return this._frontmatter.from;
  }

  get to(): string {
    return this._frontmatter.to;
  }

  get registeredAt(): Date {
    return this._registeredAt;
  }

  get lastModified(): Date {
    return this._lastModified;
  }

  get isUnread(): boolean {
    return this._status === 'UNREAD';
  }

  get isDone(): boolean {
    return this._frontmatter.type === 'done';
  }

  get isBlocked(): boolean {
    return this._frontmatter.type === 'blocked';
  }

  // ─── State Transitions ──────────────────────────────────────────────────────

  markAsRead(): void {
    if (this._status === 'READ') {
      throw new MessageAlreadyReadError(this._id);
    }
    this._status = 'READ';
    this._lastModified = new Date();
  }

  archive(): void {
    this._status = 'ARCHIVED';
    this._lastModified = new Date();
  }

  // ─── Snapshot ───────────────────────────────────────────────────────────────

  toMessage(): Message {
    return {
      id: this._id,
      terminal: this._terminal,
      box: this._box,
      filePath: this._filePath,
      fileName: this._fileName,
      frontmatter: this._frontmatter,
      content: this._content,
      contentHash: this._contentHash,
      registeredAt: this._registeredAt,
      lastModified: this._lastModified,
    };
  }

  // ─── Factory ────────────────────────────────────────────────────────────────

  static fromMessage(message: Message): MessageEntity {
    return new MessageEntity(
      message.id,
      message.terminal,
      message.box,
      message.filePath,
      message.fileName,
      message.frontmatter,
      message.content,
      message.contentHash,
      message.registeredAt,
      message.frontmatter.status,
      message.lastModified,
    );
  }

  static create(params: {
    terminal: string;
    box: BoxType;
    filePath: string;
    fileName: string;
    frontmatter: MessageFrontmatter;
    content: string;
  }): MessageEntity {
    const contentHash = crypto
      .createHash('sha256')
      .update(params.content)
      .digest('hex')
      .substring(0, 12);

    return new MessageEntity(
      params.frontmatter.id,
      params.terminal,
      params.box,
      params.filePath,
      params.fileName,
      params.frontmatter,
      params.content,
      contentHash,
      new Date(),
      params.frontmatter.status,
      new Date(),
    );
  }
}

// ─── Message Builder ──────────────────────────────────────────────────────────

export class InboxMessageBuilder {
  private _to: string = '';
  private _from: string = '';
  private _type: MessageType = 'task';
  private _priority: Priority = 'medium';
  private _model?: ModelType;
  private _ref?: string;
  private _epic?: string;
  private _tags: string[] = [];
  private _subject: string = '';
  private _body: string = '';

  to(terminal: string): this {
    this._to = terminal;
    return this;
  }

  from(terminal: string): this {
    this._from = terminal;
    return this;
  }

  type(type: MessageType): this {
    this._type = type;
    return this;
  }

  priority(priority: Priority): this {
    this._priority = priority;
    return this;
  }

  model(model: ModelType): this {
    this._model = model;
    return this;
  }

  ref(ref: string): this {
    this._ref = ref;
    return this;
  }

  epic(epic: string): this {
    this._epic = epic;
    return this;
  }

  tags(tags: string[]): this {
    this._tags = tags;
    return this;
  }

  subject(subject: string): this {
    this._subject = subject;
    return this;
  }

  body(body: string): this {
    this._body = body;
    return this;
  }

  build(): InboxMessageInput {
    if (!this._to) throw new ValidationError('to is required');
    if (!this._from) throw new ValidationError('from is required');
    if (!this._subject) throw new ValidationError('subject is required');

    return {
      to: this._to as any,
      from: this._from,
      type: this._type,
      priority: this._priority,
      model: this._model,
      ref: this._ref,
      epic: this._epic,
      tags: this._tags.length > 0 ? this._tags : undefined,
      subject: this._subject,
      body: this._body,
    };
  }
}

export class OutboxMessageBuilder {
  private _terminal: string = '';
  private _type: 'done' | 'blocked' = 'done';
  private _ref: string = '';
  private _summary: string = '';
  private _details?: string;
  private _filesChanged: string[] = [];
  private _nextSteps: string[] = [];
  private _blockedBy?: string;

  terminal(terminal: string): this {
    this._terminal = terminal;
    return this;
  }

  done(): this {
    this._type = 'done';
    return this;
  }

  blocked(by: string): this {
    this._type = 'blocked';
    this._blockedBy = by;
    return this;
  }

  ref(ref: string): this {
    this._ref = ref;
    return this;
  }

  summary(summary: string): this {
    this._summary = summary;
    return this;
  }

  details(details: string): this {
    this._details = details;
    return this;
  }

  filesChanged(files: string[]): this {
    this._filesChanged = files;
    return this;
  }

  nextSteps(steps: string[]): this {
    this._nextSteps = steps;
    return this;
  }

  build(): OutboxMessageInput {
    if (!this._terminal) throw new ValidationError('terminal is required');
    if (!this._ref) throw new ValidationError('ref is required');
    if (!this._summary) throw new ValidationError('summary is required');

    return {
      terminal: this._terminal as any,
      type: this._type,
      ref: this._ref,
      summary: this._summary,
      details: this._details,
      filesChanged: this._filesChanged.length > 0 ? this._filesChanged : undefined,
      nextSteps: this._nextSteps.length > 0 ? this._nextSteps : undefined,
      blockedBy: this._blockedBy,
    };
  }
}
