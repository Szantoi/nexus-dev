/**
 * Terminal Domain Types
 */

import { TerminalStatus, ModelType, Priority } from './common';

// ─── Terminal Identity ────────────────────────────────────────────────────────

export interface TerminalInfo {
  readonly name: string;
  readonly canonical: string;  // spaceos-<name>
  readonly workdir: string;
  readonly role: TerminalRole;
  readonly aliases: readonly string[];
}

export type TerminalRole =
  | 'priority'      // root - always running
  | 'coordinator'   // conductor - orchestrates others
  | 'developer'     // backend, frontend, designer
  | 'support';      // architect, librarian, explorer

export const TERMINAL_NAMES = [
  'root',
  'conductor',
  'backend',
  'frontend',
  'designer',
  'architect',
  'librarian',
  'explorer',
] as const;

export type TerminalName = typeof TERMINAL_NAMES[number];

// ─── Terminal State ───────────────────────────────────────────────────────────

export interface TerminalState {
  readonly terminal: TerminalName;
  readonly status: TerminalStatus;
  readonly currentTask: string | null;
  readonly model: ModelType | null;
  readonly sessionActive: boolean;
  readonly lastActivity: Date | null;
  readonly unreadInbox: number;
  readonly unreadOutbox: number;
}

// ─── Focus Queue ──────────────────────────────────────────────────────────────

export interface FocusItem {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  readonly status: 'pending' | 'in_progress' | 'blocked' | 'done';
  readonly blockedBy?: string;
  readonly addedAt: Date;
}

export interface FocusQueue {
  readonly terminal: TerminalName;
  readonly activeTask: FocusItem | null;
  readonly queue: readonly FocusItem[];
}

// ─── Terminal Capabilities ────────────────────────────────────────────────────

export interface TerminalCapabilities {
  readonly terminal: TerminalName;
  readonly canDispatch: readonly TerminalName[];  // which terminals it can control
  readonly skills: readonly string[];
  readonly workflows: readonly string[];
}

// ─── Terminal Session ─────────────────────────────────────────────────────────

export interface TerminalSession {
  readonly terminal: TerminalName;
  readonly tmuxSession: string;
  readonly pid: number | null;
  readonly startedAt: Date;
  readonly model: ModelType;
  readonly prompt?: string;
}
