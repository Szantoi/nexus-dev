/**
 * Terminal Entity
 * Aggregate root for terminal domain
 */

import {
  TerminalName,
  TerminalRole,
  TerminalInfo,
  TerminalState,
  FocusItem,
  FocusQueue,
  TERMINAL_NAMES,
} from '../../core/types/terminal';
import { TerminalStatus, ModelType, Priority } from '../../core/types/common';
import { TerminalNotFoundError, ValidationError } from '../../core/errors';

// Environment-based paths
const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const TERMINALS_PATH = process.env.TERMINALS_PATH || `${SPACEOS_ROOT}/terminals`;

// ─── Terminal Entity ──────────────────────────────────────────────────────────

export class Terminal {
  private constructor(
    private readonly _info: TerminalInfo,
    private _state: TerminalState,
    private _focusQueue: FocusItem[],
  ) {}

  // ─── Getters ────────────────────────────────────────────────────────────────

  get name(): TerminalName {
    return this._info.name as TerminalName;
  }

  get canonical(): string {
    return this._info.canonical;
  }

  get workdir(): string {
    return this._info.workdir;
  }

  get role(): TerminalRole {
    return this._info.role;
  }

  get status(): TerminalStatus {
    return this._state.status;
  }

  get currentTask(): string | null {
    return this._state.currentTask;
  }

  get model(): ModelType | null {
    return this._state.model;
  }

  get isSessionActive(): boolean {
    return this._state.sessionActive;
  }

  get lastActivity(): Date | null {
    return this._state.lastActivity;
  }

  get unreadInbox(): number {
    return this._state.unreadInbox;
  }

  get unreadOutbox(): number {
    return this._state.unreadOutbox;
  }

  get focusQueue(): readonly FocusItem[] {
    return this._focusQueue;
  }

  get activeTask(): FocusItem | null {
    return this._focusQueue.find(item => item.status === 'in_progress') ?? null;
  }

  // ─── State Transitions ──────────────────────────────────────────────────────

  registerWorking(task: string, model?: ModelType): void {
    this._state = {
      ...this._state,
      status: 'working',
      currentTask: task,
      model: model ?? this._state.model,
      sessionActive: true,
      lastActivity: new Date(),
    };
  }

  registerIdle(): void {
    this._state = {
      ...this._state,
      status: 'idle',
      currentTask: null,
      sessionActive: false,
      lastActivity: new Date(),
    };
  }

  markStuck(): void {
    this._state = {
      ...this._state,
      status: 'stuck',
      lastActivity: new Date(),
    };
  }

  updateMailboxCounts(inbox: number, outbox: number): void {
    this._state = {
      ...this._state,
      unreadInbox: inbox,
      unreadOutbox: outbox,
    };
  }

  // ─── Focus Queue Management ─────────────────────────────────────────────────

  addFocusItem(item: Omit<FocusItem, 'addedAt'>): void {
    this._focusQueue.push({
      ...item,
      addedAt: new Date(),
    });
    this.sortFocusQueue();
  }

  removeFocusItem(itemId: string): boolean {
    const index = this._focusQueue.findIndex(item => item.id === itemId);
    if (index === -1) return false;
    this._focusQueue.splice(index, 1);
    return true;
  }

  setActiveTask(itemId: string): FocusItem | null {
    // Clear any existing in_progress
    this._focusQueue = this._focusQueue.map(item => ({
      ...item,
      status: item.status === 'in_progress' ? 'pending' : item.status,
    }));

    // Set new active
    const item = this._focusQueue.find(i => i.id === itemId);
    if (!item) return null;

    const index = this._focusQueue.indexOf(item);
    this._focusQueue[index] = { ...item, status: 'in_progress' };
    return this._focusQueue[index];
  }

  markTaskDone(itemId: string): boolean {
    const item = this._focusQueue.find(i => i.id === itemId);
    if (!item) return false;

    const index = this._focusQueue.indexOf(item);
    this._focusQueue[index] = { ...item, status: 'done' };
    return true;
  }

  markTaskBlocked(itemId: string, blockedBy: string): boolean {
    const item = this._focusQueue.find(i => i.id === itemId);
    if (!item) return false;

    const index = this._focusQueue.indexOf(item);
    this._focusQueue[index] = { ...item, status: 'blocked', blockedBy };
    return true;
  }

  replaceFocusQueue(items: FocusItem[]): void {
    this._focusQueue = items;
    this.sortFocusQueue();
  }

  private sortFocusQueue(): void {
    const priorityOrder: Record<Priority, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };

    this._focusQueue.sort((a, b) => {
      // in_progress always first
      if (a.status === 'in_progress') return -1;
      if (b.status === 'in_progress') return 1;
      // blocked/done at end
      if (a.status === 'blocked' || a.status === 'done') return 1;
      if (b.status === 'blocked' || b.status === 'done') return -1;
      // by priority
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  // ─── Snapshot ───────────────────────────────────────────────────────────────

  toState(): TerminalState {
    return { ...this._state };
  }

  toFocusQueue(): FocusQueue {
    return {
      terminal: this.name,
      activeTask: this.activeTask,
      queue: [...this._focusQueue],
    };
  }

  // ─── Factory ────────────────────────────────────────────────────────────────

  static create(info: TerminalInfo, state?: Partial<TerminalState>): Terminal {
    const defaultState: TerminalState = {
      terminal: info.name as TerminalName,
      status: 'idle',
      currentTask: null,
      model: null,
      sessionActive: false,
      lastActivity: null,
      unreadInbox: 0,
      unreadOutbox: 0,
      ...state,
    };

    return new Terminal(info, defaultState, []);
  }

  static restore(
    info: TerminalInfo,
    state: TerminalState,
    focusQueue: FocusItem[],
  ): Terminal {
    return new Terminal(info, state, focusQueue);
  }
}

// ─── Terminal Info Registry ───────────────────────────────────────────────────

const TERMINAL_REGISTRY: Record<TerminalName, TerminalInfo> = {
  root: {
    name: 'root',
    canonical: 'spaceos-root',
    workdir: SPACEOS_ROOT,
    role: 'priority',
    aliases: [],
  },
  conductor: {
    name: 'conductor',
    canonical: 'spaceos-conductor',
    workdir: `${TERMINALS_PATH}/conductor`,
    role: 'coordinator',
    aliases: [],
  },
  backend: {
    name: 'backend',
    canonical: 'spaceos-backend',
    workdir: `${TERMINALS_PATH}/backend`,
    role: 'developer',
    aliases: ['kernel', 'orch', 'joinery', 'cutting', 'identity', 'inventory', 'procurement', 'sales', 'abstractions', 'infra', 'e2e', 'nexus'],
  },
  frontend: {
    name: 'frontend',
    canonical: 'spaceos-frontend',
    workdir: `${TERMINALS_PATH}/frontend`,
    role: 'developer',
    aliases: ['fe', 'fe2', 'portal'],
  },
  designer: {
    name: 'designer',
    canonical: 'spaceos-designer',
    workdir: `${TERMINALS_PATH}/designer`,
    role: 'developer',
    aliases: [],
  },
  architect: {
    name: 'architect',
    canonical: 'spaceos-architect',
    workdir: `${TERMINALS_PATH}/architect`,
    role: 'support',
    aliases: [],
  },
  librarian: {
    name: 'librarian',
    canonical: 'spaceos-librarian',
    workdir: `${TERMINALS_PATH}/librarian`,
    role: 'support',
    aliases: [],
  },
  explorer: {
    name: 'explorer',
    canonical: 'spaceos-explorer',
    workdir: `${TERMINALS_PATH}/explorer`,
    role: 'support',
    aliases: [],
  },
};

export function getTerminalInfo(name: string): TerminalInfo {
  // Direct match
  const direct = TERMINAL_REGISTRY[name as TerminalName];
  if (direct) return direct;

  // Alias match
  for (const terminal of Object.values(TERMINAL_REGISTRY)) {
    if (terminal.aliases.includes(name)) {
      return terminal;
    }
  }

  throw new TerminalNotFoundError(name);
}

export function isValidTerminal(name: string): boolean {
  try {
    getTerminalInfo(name);
    return true;
  } catch {
    return false;
  }
}

export function getAllTerminals(): TerminalInfo[] {
  return Object.values(TERMINAL_REGISTRY);
}

export function resolveTerminalName(name: string): TerminalName {
  return getTerminalInfo(name).name as TerminalName;
}
