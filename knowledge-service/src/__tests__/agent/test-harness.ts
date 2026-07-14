/**
 * Agent Test Harness
 *
 * Provides utilities for:
 * - Session management (spawn, kill, status)
 * - Terminal discovery
 * - Memory file operations
 * - Inter-agent messaging
 * - Response validation
 */

import { readFile, writeFile, access, mkdir } from 'fs/promises';
import { constants } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  API_CONFIG,
  TERMINALS,
  TERMINAL_PATHS,
  fetchApi,
  measureTime,
} from './agent.config';

const execAsync = promisify(exec);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TerminalStatus {
  terminal: string;
  sessionExists: boolean;
  claudeRunning: boolean;
  status?: 'idle' | 'working' | 'blocked';
  currentTask?: string;
}

export interface SessionStartResult {
  success: boolean;
  terminal: string;
  sessionId?: string;
  error?: string;
}

export interface MessageSendResult {
  success: boolean;
  messageId?: string;
  delivered?: boolean;
  error?: string;
}

export interface MemoryEntry {
  key: string;
  value: string;
  timestamp: Date;
}

// ─── Terminal Discovery ──────────────────────────────────────────────────────

/**
 * Discover available terminals from the API
 */
export async function discoverTerminals(): Promise<string[]> {
  try {
    const res = await fetchApi('/api/dashboard');
    if (res.status !== 200) return TERMINALS.all;

    const data = await res.json();
    if (!data.terminals || !Array.isArray(data.terminals)) {
      return TERMINALS.all;
    }

    return data.terminals.map((t: { name: string }) => t.name);
  } catch {
    return TERMINALS.all;
  }
}

/**
 * Get terminal status
 */
export async function getTerminalStatus(
  terminal: string
): Promise<TerminalStatus> {
  const res = await fetchApi(`/api/session/${terminal}`);
  const data = await res.json();

  return {
    terminal: data.terminal || terminal,
    sessionExists: data.sessionExists ?? false,
    claudeRunning: data.claudeRunning ?? false,
    status: data.status,
    currentTask: data.currentTask,
  };
}

/**
 * Get all terminal statuses
 */
export async function getAllTerminalStatuses(): Promise<TerminalStatus[]> {
  const terminals = await discoverTerminals();
  return Promise.all(terminals.map(getTerminalStatus));
}

// ─── Session Management ──────────────────────────────────────────────────────

/**
 * Start a terminal session with a prompt
 */
export async function startSession(
  terminal: string,
  prompt: string,
  model: 'haiku' | 'sonnet' | 'opus' = 'haiku',
  fromTerminal: string = 'root'
): Promise<SessionStartResult> {
  try {
    const res = await fetchApi('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        model,
        prompt,
        fromTerminal,
      }),
    });

    const data = await res.json();

    if (res.status === 200 || res.status === 201) {
      return {
        success: true,
        terminal,
        sessionId: data.sessionId,
      };
    }

    return {
      success: false,
      terminal,
      error: data.error || `Status ${res.status}`,
    };
  } catch (error) {
    return {
      success: false,
      terminal,
      error: (error as Error).message,
    };
  }
}

/**
 * Inject a prompt into a running session
 */
export async function injectPrompt(
  terminal: string,
  prompt: string,
  fromTerminal: string = 'root'
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetchApi('/api/session/inject', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        prompt,
        fromTerminal,
      }),
    });

    if (res.status === 200) {
      return { success: true };
    }

    const data = await res.json();
    return { success: false, error: data.error || `Status ${res.status}` };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Wake a terminal (start session if not running)
 */
export async function wakeTerminal(
  terminal: string,
  fromTerminal: string = 'root'
): Promise<{ success: boolean; alreadyRunning?: boolean; error?: string }> {
  try {
    const res = await fetchApi('/api/session/wake', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        fromTerminal,
      }),
    });

    const data = await res.json();

    if (res.status === 200) {
      return {
        success: true,
        alreadyRunning: data.alreadyRunning,
      };
    }

    return { success: false, error: data.error || `Status ${res.status}` };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Kill a terminal session using tmux
 */
export async function killSession(terminal: string): Promise<boolean> {
  try {
    const sessionName = `spaceos-${terminal}`;
    await execAsync(`tmux kill-session -t ${sessionName} 2>/dev/null || true`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for a session to reach a specific state
 */
export async function waitForSessionState(
  terminal: string,
  expectedState: 'running' | 'stopped',
  timeoutMs: number = 30000,
  pollIntervalMs: number = 1000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getTerminalStatus(terminal);

    if (expectedState === 'running' && status.claudeRunning) {
      return true;
    }

    if (expectedState === 'stopped' && !status.claudeRunning) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return false;
}

// ─── Memory Operations ───────────────────────────────────────────────────────

/**
 * Read MEMORY.md for a terminal
 */
export async function readMemory(terminal: string): Promise<string | null> {
  const path = TERMINAL_PATHS.getMemoryMd(terminal);

  try {
    await access(path, constants.R_OK);
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Write to MEMORY.md for a terminal
 */
export async function writeMemory(
  terminal: string,
  content: string
): Promise<boolean> {
  const path = TERMINAL_PATHS.getMemoryMd(terminal);

  try {
    await writeFile(path, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Append to MEMORY.md for a terminal
 */
export async function appendToMemory(
  terminal: string,
  entry: string
): Promise<boolean> {
  const existing = (await readMemory(terminal)) || '';
  return writeMemory(terminal, existing + '\n' + entry);
}

/**
 * Check if a specific fact exists in MEMORY.md
 */
export async function factExistsInMemory(
  terminal: string,
  factKey: string,
  factValue: string
): Promise<boolean> {
  const memory = await readMemory(terminal);
  if (!memory) return false;

  // Check for key-value pattern
  const patterns = [
    `${factKey}: ${factValue}`,
    `${factKey}=${factValue}`,
    `"${factKey}": "${factValue}"`,
    `${factKey} = ${factValue}`,
  ];

  return patterns.some((pattern) =>
    memory.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Inject a test fact into MEMORY.md
 */
export async function injectTestFact(
  terminal: string,
  key: string,
  value: string
): Promise<boolean> {
  const entry = `\n### Test Fact (${new Date().toISOString()})\n- ${key}: ${value}\n`;
  return appendToMemory(terminal, entry);
}

// ─── CLAUDE.md Operations ────────────────────────────────────────────────────

/**
 * Read CLAUDE.md for a terminal
 */
export async function readClaudeMd(terminal: string): Promise<string | null> {
  const path = TERMINAL_PATHS.getClaudeMd(terminal);

  try {
    await access(path, constants.R_OK);
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract identity section from CLAUDE.md
 */
export async function extractIdentity(
  terminal: string
): Promise<{ role: string; description: string } | null> {
  const content = await readClaudeMd(terminal);
  if (!content) return null;

  // Extract first heading and first paragraph
  const lines = content.split('\n');
  let role = '';
  let description = '';

  for (const line of lines) {
    if (line.startsWith('# ')) {
      role = line.replace('# ', '').trim();
    } else if (line.startsWith('> ') && !description) {
      description = line.replace('> ', '').trim();
    }

    if (role && description) break;
  }

  return role ? { role, description } : null;
}

// ─── Inter-Agent Messaging ───────────────────────────────────────────────────

/**
 * Send a message from one terminal to another via agent-messages API
 */
export async function sendAgentMessage(
  from: string,
  to: string,
  type: 'task' | 'info' | 'question' | 'done' | 'blocked',
  content: string,
  priority: 'critical' | 'high' | 'medium' | 'low' = 'medium'
): Promise<MessageSendResult> {
  try {
    const res = await fetchApi('/api/agent-messages/send', {
      method: 'POST',
      body: JSON.stringify({
        from,
        to,
        type,
        content,
        priority,
      }),
    });

    const data = await res.json();

    if (res.status === 200 || res.status === 201) {
      return {
        success: true,
        messageId: data.messageId,
        delivered: data.delivered,
      };
    }

    return { success: false, error: data.error || `Status ${res.status}` };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Create a mailbox message (file-based)
 */
export async function createMailboxMessage(
  from: string,
  to: string,
  type: 'task' | 'info' | 'question' | 'done' | 'blocked',
  content: string,
  priority: 'critical' | 'high' | 'medium' | 'low' = 'medium'
): Promise<MessageSendResult> {
  try {
    const res = await fetchApi(`/api/mailbox/${to}/inbox`, {
      method: 'POST',
      body: JSON.stringify({
        from,
        type,
        content,
        priority,
        status: 'UNREAD',
      }),
    });

    const data = await res.json();

    if (res.status === 200 || res.status === 201) {
      return {
        success: true,
        messageId: data.id || data.messageId,
        delivered: true,
      };
    }

    return { success: false, error: data.error || `Status ${res.status}` };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Read inbox messages for a terminal
 */
export async function readInbox(
  terminal: string,
  status?: 'UNREAD' | 'READ'
): Promise<Array<{ id: string; from: string; type: string; status: string }>> {
  try {
    const query = status ? `?status=${status}` : '';
    const res = await fetchApi(`/api/mailbox/${terminal}/inbox${query}`);

    if (res.status !== 200) return [];

    const data = await res.json();
    return (data.messages || []).map((msg: any) => ({
      id: msg.frontmatter?.id || msg.id,
      from: msg.frontmatter?.from || msg.from,
      type: msg.frontmatter?.type || msg.type,
      status: msg.frontmatter?.status || msg.status,
    }));
  } catch {
    return [];
  }
}

// ─── Datahaven Status ────────────────────────────────────────────────────────

/**
 * Update terminal status in Datahaven
 */
export async function updateDatahavenStatus(
  terminal: string,
  status: 'idle' | 'working' | 'blocked',
  currentTask?: string
): Promise<boolean> {
  try {
    const res = await fetchApi('/api/terminal/status', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        status,
        currentTask,
      }),
    });

    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Get terminal status from Datahaven
 */
export async function getDatahavenStatus(
  terminal: string
): Promise<{ status: string; currentTask?: string } | null> {
  try {
    const res = await fetchApi('/api/dashboard');
    if (res.status !== 200) return null;

    const data = await res.json();
    const terminalData = data.terminals?.find(
      (t: { name: string }) => t.name === terminal
    );

    return terminalData
      ? { status: terminalData.status, currentTask: terminalData.currentTask }
      : null;
  } catch {
    return null;
  }
}

// ─── Test Utilities ──────────────────────────────────────────────────────────

/**
 * Generate a unique test ID
 */
export function generateTestId(): string {
  return `TEST-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Clean up test artifacts
 */
export async function cleanupTestArtifacts(terminal: string): Promise<void> {
  // Read current memory
  const memory = await readMemory(terminal);
  if (!memory) return;

  // Remove test fact sections
  const cleaned = memory.replace(
    /\n### Test Fact \([^)]+\)\n- [^\n]+\n/g,
    ''
  );

  await writeMemory(terminal, cleaned);
}

/**
 * Assert with timeout
 */
export async function assertWithTimeout<T>(
  fn: () => Promise<T>,
  validator: (result: T) => boolean,
  timeoutMs: number,
  pollIntervalMs: number = 500
): Promise<{ success: boolean; result?: T; elapsed: number }> {
  const start = Date.now();
  const deadline = start + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (validator(result)) {
        return { success: true, result, elapsed: Date.now() - start };
      }
    } catch {
      // Continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { success: false, elapsed: Date.now() - start };
}
