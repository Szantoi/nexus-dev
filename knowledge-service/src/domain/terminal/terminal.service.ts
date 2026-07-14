/**
 * Terminal Domain Service
 * Encapsulates terminal business logic
 */

import { Terminal, getTerminalInfo, resolveTerminalName, getAllTerminals } from './terminal.entity';
import { ITerminalRepository } from './terminal.repository';
import {
  TerminalName,
  TerminalState,
  TerminalCapabilities,
  FocusItem,
  FocusQueue,
} from '../../core/types/terminal';
import { ModelType, Priority } from '../../core/types/common';
import {
  TerminalNotFoundError,
  TerminalPermissionError,
  ValidationError,
} from '../../core/errors';

// ─── Permission Matrix ────────────────────────────────────────────────────────

const DISPATCH_PERMISSIONS: Record<TerminalName, TerminalName[]> = {
  root: ['conductor', 'backend', 'frontend', 'designer', 'architect', 'librarian', 'explorer'],
  conductor: ['architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer'],
  backend: [],
  frontend: [],
  designer: [],
  architect: [],
  librarian: [],
  explorer: [],
};

// ─── Service ──────────────────────────────────────────────────────────────────

export class TerminalService {
  constructor(private readonly repository: ITerminalRepository) {}

  // ─── Query Operations ───────────────────────────────────────────────────────

  async getTerminal(name: string): Promise<Terminal> {
    const resolved = resolveTerminalName(name);
    const terminal = await this.repository.findByName(resolved);
    if (!terminal) {
      // Create default terminal state
      const info = getTerminalInfo(resolved);
      return Terminal.create(info);
    }
    return terminal;
  }

  async getAllTerminals(): Promise<Terminal[]> {
    return this.repository.findAll();
  }

  async getTerminalState(name: string): Promise<TerminalState> {
    const terminal = await this.getTerminal(name);
    return terminal.toState();
  }

  async getFocusQueue(name: string): Promise<FocusQueue> {
    const terminal = await this.getTerminal(name);
    return terminal.toFocusQueue();
  }

  async getCapabilities(name: string): Promise<TerminalCapabilities> {
    const resolved = resolveTerminalName(name);
    const info = getTerminalInfo(resolved);

    // TODO: Load skills and workflows from filesystem
    return {
      terminal: resolved,
      canDispatch: DISPATCH_PERMISSIONS[resolved] || [],
      skills: [],
      workflows: [],
    };
  }

  async getIdentity(name: string): Promise<string | null> {
    const resolved = resolveTerminalName(name);
    return this.repository.getIdentity(resolved);
  }

  async getMemory(name: string): Promise<string | null> {
    const resolved = resolveTerminalName(name);
    return this.repository.getMemory(resolved);
  }

  // ─── Command Operations ─────────────────────────────────────────────────────

  async registerWorking(
    name: string,
    task: string,
    model?: ModelType,
  ): Promise<TerminalState> {
    const terminal = await this.getTerminal(name);
    terminal.registerWorking(task, model);
    await this.repository.save(terminal);
    return terminal.toState();
  }

  async registerIdle(name: string): Promise<TerminalState> {
    const terminal = await this.getTerminal(name);
    terminal.registerIdle();
    await this.repository.save(terminal);
    return terminal.toState();
  }

  async markStuck(name: string): Promise<TerminalState> {
    const terminal = await this.getTerminal(name);
    terminal.markStuck();
    await this.repository.save(terminal);
    return terminal.toState();
  }

  async updateMemory(name: string, content: string, append: boolean = false): Promise<void> {
    const resolved = resolveTerminalName(name);
    if (append) {
      await this.repository.appendMemory(resolved, content);
    } else {
      await this.repository.writeMemory(resolved, content);
    }
  }

  // ─── Focus Queue Operations ─────────────────────────────────────────────────

  async addFocusItem(
    name: string,
    item: Omit<FocusItem, 'addedAt'>,
  ): Promise<FocusQueue> {
    const terminal = await this.getTerminal(name);
    terminal.addFocusItem(item);
    await this.repository.saveFocusQueue(terminal.name, [...terminal.focusQueue]);
    return terminal.toFocusQueue();
  }

  async setActiveTask(name: string, taskId: string): Promise<FocusItem | null> {
    const terminal = await this.getTerminal(name);
    const item = terminal.setActiveTask(taskId);
    if (item) {
      await this.repository.saveFocusQueue(terminal.name, [...terminal.focusQueue]);
    }
    return item;
  }

  async markTaskDone(name: string, taskId: string): Promise<boolean> {
    const terminal = await this.getTerminal(name);
    const success = terminal.markTaskDone(taskId);
    if (success) {
      await this.repository.saveFocusQueue(terminal.name, [...terminal.focusQueue]);
    }
    return success;
  }

  async markTaskBlocked(
    name: string,
    taskId: string,
    blockedBy: string,
  ): Promise<boolean> {
    const terminal = await this.getTerminal(name);
    const success = terminal.markTaskBlocked(taskId, blockedBy);
    if (success) {
      await this.repository.saveFocusQueue(terminal.name, [...terminal.focusQueue]);
    }
    return success;
  }

  async replaceFocusQueue(name: string, items: FocusItem[]): Promise<FocusQueue> {
    const terminal = await this.getTerminal(name);
    terminal.replaceFocusQueue(items);
    await this.repository.saveFocusQueue(terminal.name, [...terminal.focusQueue]);
    return terminal.toFocusQueue();
  }

  // ─── Permission Checks ──────────────────────────────────────────────────────

  canDispatch(from: string, to: string): boolean {
    const fromResolved = resolveTerminalName(from);
    const toResolved = resolveTerminalName(to);

    if (fromResolved === toResolved) return true; // can always control self

    const allowed = DISPATCH_PERMISSIONS[fromResolved] || [];
    return allowed.includes(toResolved);
  }

  assertCanDispatch(from: string, to: string): void {
    if (!this.canDispatch(from, to)) {
      throw new TerminalPermissionError(from, to, 'dispatch to');
    }
  }
}
