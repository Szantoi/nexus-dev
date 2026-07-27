/**
 * dispatchGate.ts — durable, single-use runner dispatch grants.
 *
 * The static terminal allowlist remains the normal policy. This small local
 * gate is for an isolated canary: an operator grants one exact message ID,
 * the poll loop consumes it only after the local session is successfully
 * started, and the gate immediately closes again. The file has no secret and
 * is safe to inspect from the status command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { RuntimeStateError, ValidationError } from '../core/errors';

const VERSION = 1;
const SAFE_TERMINAL = /^[a-z][a-z0-9-]*$/;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface DispatchGateState {
  version: 1;
  terminals: Record<string, string[]>;
}

export interface DispatchGate {
  allows(terminal: string, messageId: string): boolean;
  consume(terminal: string, messageId: string): void;
}

export class FileDispatchGate implements DispatchGate {
  constructor(readonly filePath: string) {}

  allows(terminal: string, messageId: string): boolean {
    validateIdentity(terminal, messageId);
    return this.read().terminals[terminal]?.includes(messageId) ?? false;
  }

  grant(terminal: string, messageId: string): void {
    validateIdentity(terminal, messageId);
    this.withExclusiveLock(() => {
      const state = this.read();
      const grants = state.terminals[terminal] ?? [];
      if (!grants.includes(messageId)) grants.push(messageId);
      state.terminals[terminal] = grants;
      this.write(state);
    });
  }

  consume(terminal: string, messageId: string): void {
    validateIdentity(terminal, messageId);
    this.withExclusiveLock(() => {
      const state = this.read();
      const grants = state.terminals[terminal] ?? [];
      const remaining = grants.filter((id) => id !== messageId);
      if (remaining.length === 0) delete state.terminals[terminal];
      else state.terminals[terminal] = remaining;
      this.write(state);
    });
  }

  pause(terminal: string): void {
    if (!SAFE_TERMINAL.test(terminal)) throw new ValidationError(`unsafe terminal: ${terminal}`);
    this.withExclusiveLock(() => {
      const state = this.read();
      delete state.terminals[terminal];
      this.write(state);
    });
  }

  snapshot(): DispatchGateState {
    return this.read();
  }

  private read(): DispatchGateState {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!isState(parsed)) throw new ValidationError('dispatch gate file has invalid shape');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: VERSION, terminals: {} };
      }
      throw error;
    }
  }

  private write(state: DispatchGateState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  /**
   * Gate mutations can originate from the runner and the operator CLI. Atomic
   * rename alone protects readers, but not concurrent read-modify-write
   * sequences: a simultaneous pause could otherwise be overwritten by a
   * consume. Contention is deliberately fail-closed; the operation is tiny,
   * so the caller can retry rather than guessing ownership of a stale lock.
   */
  private withExclusiveLock<T>(operation: () => T): T {
    const lockPath = `${this.filePath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new RuntimeStateError('dispatch gate is busy; retry the operation', this.filePath);
      }
      throw error;
    }
    try {
      return operation();
    } finally {
      fs.rmdirSync(lockPath);
    }
  }
}

function validateIdentity(terminal: string, messageId: string): void {
  if (!SAFE_TERMINAL.test(terminal)) throw new ValidationError(`unsafe terminal: ${terminal}`);
  if (!SAFE_MESSAGE_ID.test(messageId)) throw new ValidationError(`unsafe message ID: ${messageId}`);
}

function isState(value: unknown): value is DispatchGateState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== VERSION || !record.terminals || typeof record.terminals !== 'object' || Array.isArray(record.terminals)) return false;
  return Object.entries(record.terminals).every(
    ([terminal, ids]) =>
      SAFE_TERMINAL.test(terminal) &&
      Array.isArray(ids) &&
      ids.every((id) => typeof id === 'string' && SAFE_MESSAGE_ID.test(id)),
  );
}
