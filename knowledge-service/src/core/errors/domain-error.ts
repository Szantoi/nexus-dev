/**
 * Domain Errors
 * Custom error types for domain-specific failures
 */

// ─── Base Domain Error ────────────────────────────────────────────────────────

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      statusCode: this.statusCode,
    };
  }
}

// ─── Not Found Errors ─────────────────────────────────────────────────────────

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;

  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
  }
}

export class TerminalNotFoundError extends NotFoundError {
  constructor(terminal: string) {
    super('Terminal', terminal);
  }
}

export class MessageNotFoundError extends NotFoundError {
  constructor(messageId: string) {
    super('Message', messageId);
  }
}

// ─── Validation Errors ────────────────────────────────────────────────────────

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;
  readonly fields: Record<string, string>;

  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.fields = fields;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      fields: this.fields,
    };
  }
}

export class InvalidMessageTypeError extends ValidationError {
  constructor(type: string) {
    super(`Invalid message type: ${type}`, { type: `Must be one of: task, question, done, blocked, escalation, info` });
  }
}

export class InvalidPriorityError extends ValidationError {
  constructor(priority: string) {
    super(`Invalid priority: ${priority}`, { priority: `Must be one of: critical, high, medium, low` });
  }
}

// ─── Authorization Errors ─────────────────────────────────────────────────────

export class AuthorizationError extends DomainError {
  readonly code = 'UNAUTHORIZED';
  readonly statusCode = 403;

  constructor(message: string = 'Not authorized to perform this action') {
    super(message);
  }
}

export class TerminalPermissionError extends AuthorizationError {
  constructor(from: string, to: string, action: string) {
    super(`Terminal '${from}' is not authorized to ${action} terminal '${to}'`);
  }
}

// ─── State Errors ─────────────────────────────────────────────────────────────

export class InvalidStateError extends DomainError {
  readonly code = 'INVALID_STATE';
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
  }
}

export class MessageAlreadyReadError extends InvalidStateError {
  constructor(messageId: string) {
    super(`Message already marked as read: ${messageId}`);
  }
}

export class SessionAlreadyActiveError extends InvalidStateError {
  constructor(terminal: string) {
    super(`Session already active for terminal: ${terminal}`);
  }
}

// ─── External Service Errors ──────────────────────────────────────────────────

export class ExternalServiceError extends DomainError {
  readonly code = 'EXTERNAL_SERVICE_ERROR';
  readonly statusCode = 502;
  readonly service: string;

  constructor(service: string, message: string) {
    super(`${service}: ${message}`);
    this.service = service;
  }
}

export class EmbeddingServiceError extends ExternalServiceError {
  constructor(message: string) {
    super('EmbeddingService', message);
  }
}

export class LLMServiceError extends ExternalServiceError {
  constructor(message: string) {
    super('LLMService', message);
  }
}

// ─── Budget Errors ────────────────────────────────────────────────────────────

export class BudgetExceededError extends DomainError {
  readonly code = 'BUDGET_EXCEEDED';
  readonly statusCode = 429;
  readonly terminal: string;
  readonly used: number;
  readonly limit: number;

  constructor(terminal: string, used: number, limit: number) {
    super(`Budget exceeded for ${terminal}: ${used}/${limit} tokens`);
    this.terminal = terminal;
    this.used = used;
    this.limit = limit;
  }
}
