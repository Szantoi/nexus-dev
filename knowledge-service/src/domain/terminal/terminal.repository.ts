/**
 * Terminal Repository Interface
 * Defines the contract for terminal persistence
 */

import { Terminal } from './terminal.entity';
import { TerminalName, TerminalState, FocusItem, FocusQueue } from '../../core/types/terminal';

// ─── Repository Interface ─────────────────────────────────────────────────────

export interface ITerminalRepository {
  /**
   * Get a terminal by name
   */
  findByName(name: TerminalName): Promise<Terminal | null>;

  /**
   * Get all terminals
   */
  findAll(): Promise<Terminal[]>;

  /**
   * Save terminal state
   */
  save(terminal: Terminal): Promise<void>;

  /**
   * Get terminal state (status, current task, etc.)
   */
  getState(name: TerminalName): Promise<TerminalState | null>;

  /**
   * Update terminal state
   */
  updateState(name: TerminalName, state: Partial<TerminalState>): Promise<void>;

  /**
   * Get focus queue for a terminal
   */
  getFocusQueue(name: TerminalName): Promise<FocusQueue | null>;

  /**
   * Save focus queue
   */
  saveFocusQueue(name: TerminalName, queue: FocusItem[]): Promise<void>;

  /**
   * Check if terminal session is active (tmux)
   */
  isSessionActive(name: TerminalName): Promise<boolean>;

  /**
   * Get terminal memory file content
   */
  getMemory(name: TerminalName): Promise<string | null>;

  /**
   * Write terminal memory
   */
  writeMemory(name: TerminalName, content: string): Promise<void>;

  /**
   * Append to terminal memory
   */
  appendMemory(name: TerminalName, content: string): Promise<void>;

  /**
   * Get terminal identity (CLAUDE.md content)
   */
  getIdentity(name: TerminalName): Promise<string | null>;
}

// ─── Repository Events ────────────────────────────────────────────────────────

export interface TerminalStateChangedEvent {
  terminal: TerminalName;
  previousState: TerminalState;
  newState: TerminalState;
  timestamp: Date;
}

export interface FocusQueueChangedEvent {
  terminal: TerminalName;
  queue: FocusQueue;
  timestamp: Date;
}
