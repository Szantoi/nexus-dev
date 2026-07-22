/** Transactional terminal context and authenticated runner claim ownership. */

import type Database from 'better-sqlite3';

export interface TerminalContext {
  terminal: string;
  current_island_id?: string;
  current_epic_id?: string;
  current_project_id?: string;
  current_task_id?: string;
  status: 'idle' | 'working' | 'blocked';
  last_task_completed_at?: string;
  consecutive_epic_tasks: number;
  updated_at: string;
}

export type TerminalClaimResult = 'claimed' | 'idempotent' | 'conflict' | 'unknown_terminal';

export class LegacyCompletionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyCompletionRefusedError';
  }
}

export class ScopedClaimMutationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopedClaimMutationRefusedError';
  }
}

export class TerminalContextStore {
  private readonly upsertContext: Database.Statement;
  private readonly getContext: Database.Statement;
  private readonly setContextStatus: Database.Statement;
  private readonly setContextTaskCompleted: Database.Statement;
  private readonly claimUnownedContext: Database.Statement;
  private readonly scopeExistingContext: Database.Statement;
  private readonly releaseScopedContext: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.upsertContext = db.prepare(`
      INSERT INTO terminal_context (
        terminal, current_island_id, current_epic_id, current_project_id,
        current_task_id, status, consecutive_epic_tasks
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(terminal) DO UPDATE SET
        current_island_id = excluded.current_island_id,
        current_epic_id = excluded.current_epic_id,
        current_project_id = excluded.current_project_id,
        current_task_id = excluded.current_task_id,
        status = excluded.status,
        consecutive_epic_tasks = excluded.consecutive_epic_tasks,
        updated_at = datetime('now')
    `);
    this.getContext = db.prepare('SELECT * FROM terminal_context WHERE terminal = ?');
    this.setContextStatus = db.prepare(
      `UPDATE terminal_context SET status = ?, updated_at = datetime('now') WHERE terminal = ?`,
    );
    this.setContextTaskCompleted = db.prepare(`
      UPDATE terminal_context
      SET status = 'idle',
          last_task_completed_at = datetime('now'),
          current_task_id = NULL,
          updated_at = datetime('now')
      WHERE terminal = ?
    `);
    this.claimUnownedContext = db.prepare(`
      UPDATE terminal_context
      SET current_island_id = ?,
          current_epic_id = ?,
          current_project_id = ?,
          current_task_id = ?,
          status = 'working',
          updated_at = datetime('now')
      WHERE terminal = ?
        AND current_task_id IS NULL
        AND current_island_id IS NULL
    `);
    this.scopeExistingContext = db.prepare(`
      UPDATE terminal_context
      SET current_island_id = ?,
          current_epic_id = COALESCE(?, current_epic_id),
          current_project_id = COALESCE(?, current_project_id),
          status = 'working',
          updated_at = datetime('now')
      WHERE terminal = ?
        AND current_task_id = ?
        AND current_island_id IS NULL
    `);
    this.releaseScopedContext = db.prepare(`
      UPDATE terminal_context
      SET current_island_id = NULL,
          current_task_id = NULL,
          status = 'idle',
          updated_at = datetime('now')
      WHERE terminal = ?
        AND current_task_id = ?
        AND current_island_id = ?
    `);
  }

  get(terminal: string): TerminalContext | undefined {
    return this.getContext.get(terminal) as TerminalContext | undefined;
  }

  assertGenericMutationAllowed(terminal: string): void {
    const current = this.get(terminal);
    if (current?.current_island_id) {
      throw new ScopedClaimMutationRefusedError(
        `Generic context mutation refused for scoped claim ${current.current_island_id}/${terminal}/${current.current_task_id || 'unknown'}`,
      );
    }
  }

  /** Guarded compatibility setter. It can never replace an active scoped claim. */
  setGeneric(
    terminal: string,
    epicId: string | null,
    projectId: string | null,
    taskId: string | null,
    status: TerminalContext['status'],
    consecutiveTasks: number,
    islandId: string | null,
  ): void {
    this.db.transaction(() => {
      this.assertGenericMutationAllowed(terminal);
      if (islandId) {
        throw new ScopedClaimMutationRefusedError(
          'Generic context mutation cannot establish a scoped claim; use claimTerminalTask',
        );
      }
      this.replaceAfterOwnedTransition(
        terminal, epicId, projectId, taskId, status, consecutiveTasks, islandId,
      );
    })();
  }

  /** Atomic ownership CAS: only an empty context or the exact tuple may succeed. */
  claim(
    terminal: string,
    messageId: string,
    islandId: string,
    epicId: string | null,
    projectId: string | null,
  ): TerminalClaimResult {
    return this.db.transaction((): TerminalClaimResult => {
      const current = this.get(terminal);
      if (!current) return 'unknown_terminal';
      if (current.current_task_id === messageId && current.current_island_id === islandId) {
        return 'idempotent';
      }
      if (current.current_island_id) return 'conflict';
      if (current.current_task_id && current.current_task_id !== messageId) return 'conflict';
      const result = current.current_task_id === messageId
        ? this.scopeExistingContext.run(islandId, epicId, projectId, terminal, messageId)
        : this.claimUnownedContext.run(islandId, epicId, projectId, messageId, terminal);
      return result.changes === 1 ? 'claimed' : 'conflict';
    })();
  }

  release(terminal: string, messageId: string, islandId: string): boolean {
    return this.db.transaction(() => (
      this.releaseScopedContext.run(terminal, messageId, islandId).changes === 1
    ))();
  }

  markWorking(terminal: string, taskId: string): void {
    const context = this.get(terminal);
    if (!context) return;
    this.setGeneric(
      terminal,
      context.current_epic_id || null,
      context.current_project_id || null,
      taskId,
      'working',
      context.consecutive_epic_tasks,
      context.current_island_id || null,
    );
  }

  markIdle(terminal: string): void {
    const context = this.get(terminal);
    if (context?.current_island_id) {
      throw new LegacyCompletionRefusedError(
        `Direct idle transition refused for island-scoped task ${context.current_island_id}/${terminal}/${context.current_task_id || 'unknown'}`,
      );
    }
    this.setContextTaskCompleted.run(terminal);
  }

  markBlocked(terminal: string): void {
    this.setContextStatus.run('blocked', terminal);
  }

  /** Only a caller already holding the surrounding authoritative DB transaction may use this. */
  replaceAfterOwnedTransition(
    terminal: string,
    epicId: string | null,
    projectId: string | null,
    taskId: string | null,
    status: TerminalContext['status'],
    consecutiveTasks: number,
    islandId: string | null,
  ): void {
    this.upsertContext.run(
      terminal, islandId, epicId, projectId, taskId, status, consecutiveTasks,
    );
  }
}
