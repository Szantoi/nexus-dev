/**
 * File-based Terminal Repository
 * Implements ITerminalRepository using filesystem
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ITerminalRepository } from '../../../domain/terminal/terminal.repository';
import {
  Terminal,
  getTerminalInfo,
  getAllTerminals as getAllTerminalInfos,
} from '../../../domain/terminal/terminal.entity';
import {
  TerminalName,
  TerminalState,
  FocusItem,
  FocusQueue,
  TERMINAL_NAMES,
} from '../../../core/types/terminal';
import { TerminalNotFoundError } from '../../../core/errors';

// ─── Constants ────────────────────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const TERMINALS_ROOT = process.env.TERMINALS_PATH || `${SPACEOS_ROOT}/terminals`;
const ROOT_WORKDIR = SPACEOS_ROOT;
const FOCUS_QUEUE_FILE = 'FOCUS_QUEUE.json';
const MEMORY_FILE = 'MEMORY.md';
const CLAUDE_MD = 'CLAUDE.md';

// ─── In-Memory State Cache ────────────────────────────────────────────────────

interface TerminalStateCache {
  state: TerminalState;
  lastUpdated: Date;
}

const stateCache = new Map<TerminalName, TerminalStateCache>();
const STATE_CACHE_TTL_MS = 5000; // 5 seconds

// ─── Repository Implementation ────────────────────────────────────────────────

export class FileTerminalRepository implements ITerminalRepository {
  constructor(private readonly terminalsRoot: string = TERMINALS_ROOT) {}

  async findByName(name: TerminalName): Promise<Terminal | null> {
    try {
      const info = getTerminalInfo(name);
      const state = await this.getState(name);
      const focusQueue = await this.getFocusQueue(name);

      if (!state) {
        return Terminal.create(info);
      }

      return Terminal.restore(info, state, focusQueue?.queue ? [...focusQueue.queue] : []);
    } catch (error) {
      if (error instanceof TerminalNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async findAll(): Promise<Terminal[]> {
    const terminals: Terminal[] = [];

    for (const name of TERMINAL_NAMES) {
      const terminal = await this.findByName(name);
      if (terminal) {
        terminals.push(terminal);
      }
    }

    return terminals;
  }

  async save(terminal: Terminal): Promise<void> {
    const state = terminal.toState();

    // Update cache
    stateCache.set(terminal.name, {
      state,
      lastUpdated: new Date(),
    });

    // Save focus queue
    const focusQueue = terminal.toFocusQueue();
    await this.saveFocusQueue(terminal.name, [...focusQueue.queue]);
  }

  async getState(name: TerminalName): Promise<TerminalState | null> {
    // Check cache first
    const cached = stateCache.get(name);
    if (cached && Date.now() - cached.lastUpdated.getTime() < STATE_CACHE_TTL_MS) {
      return cached.state;
    }

    // Build state from filesystem
    const info = getTerminalInfo(name);
    const sessionActive = await this.isSessionActive(name);
    const focusQueue = await this.getFocusQueue(name);

    const state: TerminalState = {
      terminal: name,
      status: sessionActive ? 'working' : 'idle',
      currentTask: focusQueue?.activeTask?.title ?? null,
      model: null,
      sessionActive,
      lastActivity: null,
      unreadInbox: 0,
      unreadOutbox: 0,
    };

    // Update cache
    stateCache.set(name, { state, lastUpdated: new Date() });

    return state;
  }

  async updateState(name: TerminalName, update: Partial<TerminalState>): Promise<void> {
    const current = await this.getState(name);
    if (!current) return;

    const newState: TerminalState = {
      ...current,
      ...update,
    };

    stateCache.set(name, {
      state: newState,
      lastUpdated: new Date(),
    });
  }

  async getFocusQueue(name: TerminalName): Promise<FocusQueue | null> {
    const workdir = this.getWorkdir(name);
    const queuePath = path.join(workdir, FOCUS_QUEUE_FILE);

    if (!fs.existsSync(queuePath)) {
      return {
        terminal: name,
        activeTask: null,
        queue: [],
      };
    }

    try {
      const content = fs.readFileSync(queuePath, 'utf-8');
      const data = JSON.parse(content);

      const queue: FocusItem[] = (data.queue || []).map((item: any) => ({
        id: item.id,
        title: item.title,
        priority: item.priority || 'medium',
        status: item.status || 'pending',
        blockedBy: item.blockedBy,
        addedAt: new Date(item.addedAt || Date.now()),
      }));

      const activeTask = queue.find(item => item.status === 'in_progress') ?? null;

      return {
        terminal: name,
        activeTask,
        queue,
      };
    } catch {
      return {
        terminal: name,
        activeTask: null,
        queue: [],
      };
    }
  }

  async saveFocusQueue(name: TerminalName, queue: FocusItem[]): Promise<void> {
    const workdir = this.getWorkdir(name);
    const queuePath = path.join(workdir, FOCUS_QUEUE_FILE);

    const data = {
      terminal: name,
      updatedAt: new Date().toISOString(),
      queue: queue.map(item => ({
        ...item,
        addedAt: item.addedAt.toISOString(),
      })),
    };

    fs.writeFileSync(queuePath, JSON.stringify(data, null, 2));
  }

  async isSessionActive(name: TerminalName): Promise<boolean> {
    const sessionName = `spaceos-${name}`;

    try {
      const result = execSync(`tmux has-session -t ${sessionName} 2>/dev/null && echo "active"`, {
        encoding: 'utf-8',
        timeout: 2000,
      });
      return result.trim() === 'active';
    } catch {
      return false;
    }
  }

  async getMemory(name: TerminalName): Promise<string | null> {
    const workdir = this.getWorkdir(name);
    const memoryPath = path.join(workdir, MEMORY_FILE);

    if (!fs.existsSync(memoryPath)) {
      return null;
    }

    return fs.readFileSync(memoryPath, 'utf-8');
  }

  async writeMemory(name: TerminalName, content: string): Promise<void> {
    const workdir = this.getWorkdir(name);
    const memoryPath = path.join(workdir, MEMORY_FILE);

    fs.writeFileSync(memoryPath, content);
  }

  async appendMemory(name: TerminalName, content: string): Promise<void> {
    const workdir = this.getWorkdir(name);
    const memoryPath = path.join(workdir, MEMORY_FILE);

    const existing = fs.existsSync(memoryPath)
      ? fs.readFileSync(memoryPath, 'utf-8')
      : '';

    const separator = existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(memoryPath, existing + separator + content);
  }

  async getIdentity(name: TerminalName): Promise<string | null> {
    const workdir = this.getWorkdir(name);
    const claudePath = path.join(workdir, CLAUDE_MD);

    if (!fs.existsSync(claudePath)) {
      return null;
    }

    return fs.readFileSync(claudePath, 'utf-8');
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private getWorkdir(name: TerminalName): string {
    if (name === 'root') {
      return ROOT_WORKDIR;
    }
    return path.join(this.terminalsRoot, name);
  }
}

// ─── Cache Invalidation ───────────────────────────────────────────────────────

export function invalidateTerminalCache(name: TerminalName): void {
  stateCache.delete(name);
}

export function invalidateAllTerminalCaches(): void {
  stateCache.clear();
}
