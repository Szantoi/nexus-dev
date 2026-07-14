/**
 * Common Types & Enums
 * Shared across all domain modules
 */

// ─── Status Enums ─────────────────────────────────────────────────────────────

export type MessageStatus = 'UNREAD' | 'READ' | 'ARCHIVED';

export type MessageType = 'task' | 'question' | 'done' | 'blocked' | 'escalation' | 'info';

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export type ModelType = 'opus' | 'sonnet' | 'haiku';

export type BoxType = 'inbox' | 'outbox';

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export type TerminalStatus = 'idle' | 'working' | 'stuck' | 'offline';

export type DispatchMode = 'AUTO' | 'MANUAL' | 'PAUSED' | 'EMERGENCY_STOP';

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type GraphNodeStatus = 'pending' | 'active' | 'done' | 'blocked';

export type MemoryTier = 'session' | 'terminal' | 'project' | 'global';

// ─── Base Value Objects ───────────────────────────────────────────────────────

export interface Timestamp {
  readonly value: Date;
  toISO(): string;
}

export function createTimestamp(date: Date = new Date()): Timestamp {
  return {
    value: date,
    toISO: () => date.toISOString(),
  };
}

export interface MessageId {
  readonly value: string;
  readonly terminal: string;
  readonly sequence: number;
}

export function parseMessageId(id: string): MessageId | null {
  // Format: MSG-<TERMINAL>-<NNN>
  const match = id.match(/^MSG-([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return {
    value: id,
    terminal: match[1].toLowerCase(),
    sequence: parseInt(match[2], 10),
  };
}

// ─── Result Type (for error handling without exceptions) ──────────────────────

export type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { success: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { success: false, error };
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationParams {
  offset?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ─── Query/Command Markers ────────────────────────────────────────────────────

export interface Query<TResult> {
  readonly _queryBrand: TResult;
}

export interface Command<TResult = void> {
  readonly _commandBrand: TResult;
}
