// watchInbox.ts - TypeScript equivalent of watch-inbox.sh
// Handles inbox nudge for running sessions and auto-starts sessions with UNREAD inbox
// 2026-07-04: Migrated to NWT (Nightwatch Tick) time units
// 2026-07-08: FIX (MSG-BACKEND-193) - Use MCP API instead of tmux send-keys to prevent "bash: command not found" errors

import { promises as fs } from 'fs';
import * as path from 'path';
import {
  SESSIONS,
  hasSession,
  getState,
  setState,
  getInboxModel,
  getInboxPath,
  log,
  telegram,
  isPrioritySession
} from './common';
import { NWT_TIMEOUTS, nwtToMs } from '../constants/nwt';

// NWT-based timeouts (1 NWT = 2 minutes = 120 seconds)
// INBOX_NUDGE = 3 NWT ≈ 6 minutes, but we use 2.5 NWT for ~5 min nudge cooldown
const NUDGE_COOLDOWN_SEC = Math.floor(nwtToMs(NWT_TIMEOUTS.INBOX_NUDGE) * 0.83 / 1000); // ~5 minutes
// TASK_RETRY = 15 NWT = 30 minutes for auto-start cooldown
const AUTOSTART_COOLDOWN_SEC = Math.floor(nwtToMs(NWT_TIMEOUTS.TASK_RETRY) / 1000); // ~30 minutes
// Inbox age thresholds
const NUDGE_AGE_THRESHOLD = Math.floor(nwtToMs(NWT_TIMEOUTS.INBOX_NUDGE) * 0.5 / 1000); // ~3 minutes
const AUTOSTART_AGE_THRESHOLD = Math.floor(nwtToMs(1) / 1000); // 1 NWT = 2 minutes

// ── Types ───────────────────────────────────────────────────────────────────

interface WatchInboxResult {
  nudged: string[];
  autoStarted: string[];
  skipped: string[];
}

interface UnreadInfo {
  path: string;
  age: number;
  files: string[];
}

// ── Find oldest UNREAD inbox ────────────────────────────────────────────────

async function findOldestUnread(terminal: string): Promise<UnreadInfo | null> {
  const inboxPath = getInboxPath(terminal);

  try {
    const files = await fs.readdir(inboxPath);
    let oldestUnread: { path: string; mtime: Date; files: string[] } | null = null;

    for (const file of files.sort()) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(inboxPath, file);
      const content = await fs.readFile(filePath, 'utf-8');

      // FIX: Only check frontmatter for status, not the entire file content
      // This prevents false matches when "status: UNREAD" appears in code examples
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) continue;
      const frontmatter = frontmatterMatch[1];
      if (!frontmatter.includes('status: UNREAD')) continue;

      const stat = await fs.stat(filePath);

      // Extract files: from frontmatter
      const filesMatch = content.match(/files:\s*\n((?:\s*-\s*.+\n?)+)/);
      const filesList: string[] = [];
      if (filesMatch) {
        const lines = filesMatch[1].split('\n');
        for (const line of lines) {
          const match = line.match(/^\s*-\s*(.+)/);
          if (match) filesList.push(match[1].trim());
        }
      }

      if (!oldestUnread || stat.mtime < oldestUnread.mtime) {
        oldestUnread = { path: filePath, mtime: stat.mtime, files: filesList };
      }
    }

    if (!oldestUnread) return null;

    const now = Date.now();
    const age = Math.floor((now - oldestUnread.mtime.getTime()) / 1000);

    return {
      path: oldestUnread.path,
      age,
      files: oldestUnread.files
    };
  } catch {
    return null;
  }
}

// ── Nudge running session ───────────────────────────────────────────────────

async function nudgeSession(
  sessionName: string,
  terminal: string,
  unread: UnreadInfo
): Promise<boolean> {
  const nudgeKey = `${sessionName}_inbox_nudge`;
  const lastNudge = parseInt(await getState(nudgeKey) || '0', 10);
  const now = Math.floor(Date.now() / 1000);

  // Only nudge every ~5 minutes (2.5 NWT)
  if (now - lastNudge < NUDGE_COOLDOWN_SEC) return false;

  // Build nudge message with timestamp
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let nudgeMsg = `[${timestamp}] [INBOX] Te a ${terminal.toUpperCase()} terminál vagy. Olvasd be: MEMORY.md — Inbox: ${path.basename(unread.path)}`;
  if (unread.files.length > 0) {
    nudgeMsg += ` Fájlok: ${unread.files.join(' ').substring(0, 500)}`;
  }

  // FIX (MSG-BACKEND-193): Use MCP API instead of tmux send-keys
  // Previous implementation sent bash-formatted text to tmux, causing "bash: command not found" errors
  // Now we inject the prompt via MCP API to Claude session directly
  try {
    const response = await fetch('http://localhost:3456/api/session/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        terminal,
        prompt: nudgeMsg,
        fromTerminal: 'watchInbox'
      })
    });

    if (!response.ok) {
      const error = await response.text();
      await log(`[WatchInbox] Nudge failed: ${sessionName} → ${error}`);
      return false;
    }

    await setState(nudgeKey, String(now));
    await log(`[WatchInbox] Nudge: ${sessionName} → ${path.basename(unread.path)} (MCP API)`);
    return true;
  } catch (error) {
    await log(`[WatchInbox] Nudge error: ${sessionName} → ${error}`);
    return false;
  }
}

// ── Auto-start session ──────────────────────────────────────────────────────

async function autoStartSession(
  sessionName: string,
  terminal: string,
  unread: UnreadInfo
): Promise<boolean> {
  const startKey = `${sessionName}_autostart`;
  const lastStart = parseInt(await getState(startKey) || '0', 10);
  const now = Math.floor(Date.now() / 1000);

  // Only attempt every ~30 minutes (15 NWT)
  if (now - lastStart < AUTOSTART_COOLDOWN_SEC) return false;

  const wantedModel = await getInboxModel(terminal);

  // FIX (MSG-BACKEND-193): Use MCP API /api/session/start instead of tmux send-keys
  // Previous implementation:
  // 1. Created tmux session manually (newSession)
  // 2. Sent "claude --model X" to bash shell (sendKeys)
  // 3. Sent Enter to bash shell (sendEnter)
  // → Result: bash tried to interpret the prompt as a command
  //
  // New implementation: Use MCP API to start Claude session properly
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const initialPrompt = `[${timestamp}] [INBOX] Te a ${terminal.toUpperCase()} terminál vagy. Olvasd be: MEMORY.md — Inbox: ${path.basename(unread.path)}`;

  try {
    const response = await fetch('http://localhost:3456/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        terminal,
        model: wantedModel,
        prompt: initialPrompt,
        fromTerminal: 'watchInbox'
      })
    });

    if (!response.ok) {
      const error = await response.text();
      await log(`[WatchInbox] Auto-start failed: ${sessionName} → ${error}`);
      return false;
    }

    await setState(startKey, String(now));
    await log(`[WatchInbox] Auto-started: ${sessionName} (model: ${wantedModel}, inbox: ${path.basename(unread.path)}) (MCP API)`);

    await telegram(`🚀 *${terminal.toUpperCase()} auto-indítva*\nModell: \`${wantedModel}\`\nInbox: \`${path.basename(unread.path)}\``);

    return true;
  } catch (error) {
    await log(`[WatchInbox] Auto-start error: ${sessionName} → ${error}`);
    return false;
  }
}

// ── Main function ───────────────────────────────────────────────────────────

export async function runWatchInbox(): Promise<WatchInboxResult> {
  const result: WatchInboxResult = {
    nudged: [],
    autoStarted: [],
    skipped: []
  };

  for (const [sessionName, terminal] of Object.entries(SESSIONS)) {
    const unread = await findOldestUnread(terminal);
    if (!unread) {
      result.skipped.push(sessionName);
      continue;
    }

    const sessionRunning = await hasSession(sessionName);
    const isPriority = isPrioritySession(sessionName);

    if (sessionRunning) {
      // SKIP auto-nudge for priority sessions (root, conductor, monitor)
      // Priority sessions should only be triggered explicitly, not by inbox auto-nudge
      if (isPriority) {
        result.skipped.push(sessionName);
        continue;
      }

      // A) Session running, inbox 1.5+ NWT old (~3 min) → nudge (non-priority only)
      if (unread.age > NUDGE_AGE_THRESHOLD) {
        const nudged = await nudgeSession(sessionName, terminal, unread);
        if (nudged) {
          result.nudged.push(sessionName);
        }
      }
    } else {
      // B) Session not running
      if (isPriority) {
        // Priority sessions are handled by watchPriority - skip auto-start
        // but still log that we detected UNREAD inbox
        await log(`[WatchInbox] Priority session ${sessionName} has UNREAD inbox but not running (watchPriority will handle)`);
        result.skipped.push(sessionName);
      } else {
        // Non-priority: inbox 1+ NWT old (~2 min) → auto-start
        if (unread.age >= AUTOSTART_AGE_THRESHOLD) {
          const started = await autoStartSession(sessionName, terminal, unread);
          if (started) {
            result.autoStarted.push(sessionName);
          }
        }
      }
    }
  }

  return result;
}

// ── Standalone execution ────────────────────────────────────────────────────

if (require.main === module) {
  runWatchInbox().then(result => {
    console.log('WatchInbox result:', JSON.stringify(result, null, 2));
  });
}
