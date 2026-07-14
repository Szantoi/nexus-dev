// Pipeline Common Utilities - TypeScript equivalent of common.sh
// 2026-06-24: Optimized to use messageRegistry DB for queries
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as terminalsConfig from '../config/terminals';
import { getUnreadMessages, queryMessages } from '../messageRegistry';

const execAsync = promisify(exec);

// Environment
export const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
export const LOG_DIR = path.join(SPACEOS_ROOT, 'logs/dispatcher');
export const STATE_FILE = path.join(SPACEOS_ROOT, 'scripts/.nightwatch-state');

// ─── Config-driven exports (loaded from config/terminals.json) ───────────────

// Tmux socket path
export const TMUX_SOCKET = terminalsConfig.getTmuxSocket();

// Session → Terminal mappings
export const SESSIONS: Record<string, string> = terminalsConfig.getSessionsMap();

// Priority sessions - these always run
export const PRIORITY_SESSIONS: string[] = terminalsConfig.getPrioritySessions();

// Session → Working directory
export const SESSION_WORKDIR: Record<string, string> = terminalsConfig.getSessionWorkdirs();

// Task-only terminals (not priority) - wake-on-inbox
export const TASK_ONLY_TERMINALS: string[] = terminalsConfig.getTaskOnlyTerminals();

// Re-export config functions for direct use
export const getInboxPath = terminalsConfig.getInboxPath;
export const getOutboxPath = terminalsConfig.getOutboxPath;
export const resolveTerminalName = terminalsConfig.resolveTerminalName;
export const getDefaultModel = terminalsConfig.getDefaultModel;
export const getTerminal = terminalsConfig.getTerminal;
export const isPrioritySession = terminalsConfig.isPrioritySession;

// Tmux wrapper - always uses spaceos socket
export async function tmux(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execAsync(`tmux -S ${TMUX_SOCKET} ${args.join(' ')}`);
    return stdout.trim();
  } catch (error) {
    return '';
  }
}

// Check if session exists
// Checks both the configured socket AND the default tmux socket for compatibility
export async function hasSession(sessionName: string): Promise<boolean> {
  // First try configured socket
  try {
    await execAsync(`tmux -S ${TMUX_SOCKET} has-session -t ${sessionName}`);
    return true;
  } catch {
    // Fall through to check default socket
  }

  // Fallback: try default tmux socket (sessions might be running there)
  try {
    await execAsync(`tmux has-session -t ${sessionName}`);
    return true;
  } catch {
    return false;
  }
}

// List all running sessions
// Checks both configured socket AND default tmux socket
export async function listSessions(): Promise<string[]> {
  const sessions = new Set<string>();

  // Try configured socket
  try {
    const { stdout } = await execAsync(`tmux -S ${TMUX_SOCKET} list-sessions -F '#{session_name}'`);
    stdout.trim().split('\n').filter(s => s).forEach(s => sessions.add(s));
  } catch {
    // Continue to check default socket
  }

  // Also try default tmux socket
  try {
    const { stdout } = await execAsync(`tmux list-sessions -F '#{session_name}'`);
    stdout.trim().split('\n').filter(s => s).forEach(s => sessions.add(s));
  } catch {
    // No sessions on default socket either
  }

  return Array.from(sessions);
}

// Get session activity timestamp
export async function getSessionActivity(sessionName: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `tmux -S ${TMUX_SOCKET} display-message -p -t ${sessionName} '#{session_activity}'`
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// Capture pane output
export async function capturePane(sessionName: string, lines = 10): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `tmux -S ${TMUX_SOCKET} capture-pane -t ${sessionName} -p | tail -${lines}`
    );
    return stdout;
  } catch {
    return '';
  }
}

// Send keys to session (tries both sockets)
export async function sendKeys(sessionName: string, keys: string): Promise<void> {
  const escaped = keys.replace(/"/g, '\\"');
  // Try configured socket first
  try {
    await execAsync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} "${escaped}"`);
    return;
  } catch {
    // Try default socket as fallback
  }
  try {
    await execAsync(`tmux send-keys -t ${sessionName} "${escaped}"`);
  } catch {
    // Ignore errors
  }
}

// Send Enter key (tries both sockets)
// Uses -H 0d (hex carriage return) instead of Enter keyword to avoid bracketed paste mode issue
export async function sendEnter(sessionName: string): Promise<void> {
  // Try configured socket first
  try {
    await execAsync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} -H 0d`);
    return;
  } catch {
    // Try default socket as fallback
  }
  try {
    await execAsync(`tmux send-keys -t ${sessionName} -H 0d`);
  } catch {
    // Ignore errors
  }
}

// Kill session (tries both sockets)
export async function killSession(sessionName: string): Promise<void> {
  // Try configured socket first
  try {
    await execAsync(`tmux -S ${TMUX_SOCKET} kill-session -t ${sessionName}`);
  } catch {
    // Try default socket as fallback
  }
  try {
    await execAsync(`tmux kill-session -t ${sessionName}`);
  } catch {
    // Ignore errors
  }
}

// Create new session (uses default socket for compatibility with manual tmux attach)
export async function newSession(sessionName: string, workdir: string): Promise<void> {
  // Use default tmux socket so sessions are visible with plain `tmux attach`
  try {
    await execAsync(`tmux new-session -d -s ${sessionName} -c "${workdir}"`);
  } catch {
    // Ignore errors
  }
}

// Telegram notification
export async function telegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  try {
    await execAsync(
      `curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" ` +
      `-d chat_id="${chatId}" --data-urlencode "text=${message}" ` +
      `-d parse_mode="Markdown" -o /dev/null`
    );
  } catch {
    // Ignore errors
  }
}

// Get inbox model from frontmatter - now uses DB query
export async function getInboxModel(terminal: string): Promise<string> {
  try {
    // Query DB for UNREAD inbox messages, sorted by priority
    const unread = getUnreadMessages(terminal, 'inbox');
    if (unread.length > 0) {
      // Return model from highest priority unread message
      const msg = unread[0];
      if (msg.model) return msg.model;
    }
  } catch {
    // Fallback to filesystem if DB not ready
    const inboxPath = getInboxPath(terminal);
    try {
      const files = await fs.readdir(inboxPath);
      for (const file of files.sort().reverse()) {
        if (!file.endsWith('.md')) continue;

        const content = await fs.readFile(path.join(inboxPath, file), 'utf-8');
        if (!content.includes('status: UNREAD')) continue;

        const modelMatch = content.match(/^model:\s*(\w+)/m);
        if (modelMatch) return modelMatch[1];
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return 'sonnet';
}

// Check if terminal has UNREAD inbox - now uses DB query (O(1) instead of O(n) file reads)
export async function hasUnreadInbox(terminal: string): Promise<boolean> {
  try {
    const unread = getUnreadMessages(terminal, 'inbox');
    return unread.length > 0;
  } catch {
    // Fallback to filesystem if DB not ready
    const inboxPath = getInboxPath(terminal);
    try {
      const files = await fs.readdir(inboxPath);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const content = await fs.readFile(path.join(inboxPath, file), 'utf-8');
        if (content.includes('status: UNREAD')) return true;
      }
    } catch {
      // Directory doesn't exist
    }
    return false;
  }
}

// State file operations
export async function getState(key: string): Promise<string | null> {
  try {
    const content = await fs.readFile(STATE_FILE, 'utf-8');
    const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function setState(key: string, value: string): Promise<void> {
  try {
    let content = '';
    try {
      content = await fs.readFile(STATE_FILE, 'utf-8');
    } catch {
      // File doesn't exist
    }

    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `${key}=${value}\n`;
    }

    await fs.writeFile(STATE_FILE, content);
  } catch {
    // Ignore errors
  }
}

export async function deleteState(key: string): Promise<void> {
  try {
    const content = await fs.readFile(STATE_FILE, 'utf-8');
    const newContent = content.split('\n').filter(line => !line.startsWith(`${key}=`)).join('\n');
    await fs.writeFile(STATE_FILE, newContent);
  } catch {
    // Ignore errors
  }
}

// Logging
export async function log(message: string): Promise<void> {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const logFile = path.join(LOG_DIR, 'nightwatch.log');

  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(logFile, `${timestamp} ${message}\n`);
  } catch {
    console.log(`[Pipeline] ${message}`);
  }
}

// Note: isPrioritySession is now imported from config/terminals.ts
