// Inbox Watcher - Real-time file system monitoring for SpaceOS mailbox
// Watches terminals/*/inbox/ directories for new UNREAD messages
// and emits SSE events to wake up the appropriate terminal.
// Also registers messages in the central MessageRegistry for tracking.

import { watch, type FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  registerMessage,
  updateStatus,
  syncWithFilesystem,
  invalidateModelCache,
  type MessageType,
  type MessagePriority,
  type MessageStatus,
  type ModelType,
} from './messageRegistry';
import { emitOutboxEvent } from './pipeline/eventBus';

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
// New terminal structure (2026-06-21)
const TERMINALS_PATH = path.join(SPACEOS_ROOT, 'terminals');
// Legacy path for backward compatibility (symlink)
const LEGACY_MAILBOX_PATH = path.join(SPACEOS_ROOT, 'docs/mailbox');

// Event emitter for inbox changes
export const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(100);

export interface InboxEvent {
  type: 'new_inbox' | 'inbox_updated';
  terminal: string;
  messageId: string;
  filePath: string;
  status: string;
  priority?: string;
  messageType?: string;
  timestamp: string;
}

// Parse YAML frontmatter from markdown file
async function parseFrontmatter(filePath: string): Promise<Record<string, string> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const frontmatter: Record<string, string> = {};
    const lines = match[1].split('\n');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        frontmatter[key] = value;
      }
    }
    return frontmatter;
  } catch {
    return null;
  }
}

// Extract terminal name from file path
// e.g., /opt/spaceos/terminals/backend/inbox/file.md -> backend
function extractTerminal(filePath: string): string | null {
  // Try new structure first
  const newMatch = filePath.match(/\/terminals\/([^/]+)\/inbox\//);
  if (newMatch) return newMatch[1];

  // Fallback to legacy structure
  const legacyMatch = filePath.match(/\/mailbox\/([^/]+)\/inbox\//);
  return legacyMatch ? legacyMatch[1] : null;
}

// Extract title and content preview from file
async function extractContentInfo(filePath: string): Promise<{ title?: string; contentPreview?: string }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Extract title from first heading
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : undefined;

    // Get content preview (first 200 chars after frontmatter)
    const contentStart = content.indexOf('---', 3);
    const bodyContent = contentStart > 0 ? content.slice(contentStart + 3).trim() : '';
    const contentPreview = bodyContent.slice(0, 200);

    return { title, contentPreview };
  } catch {
    return {};
  }
}

// Handle new or modified inbox file
async function handleInboxChange(filePath: string, eventType: 'add' | 'change'): Promise<void> {
  // Only process .md files
  if (!filePath.endsWith('.md')) return;

  const terminal = extractTerminal(filePath);
  if (!terminal) return;

  // Invalidate cache for this terminal immediately
  invalidateModelCache(terminal);

  const frontmatter = await parseFrontmatter(filePath);
  if (!frontmatter) return;

  const messageId = frontmatter.id || path.basename(filePath, '.md');

  // Register message in the central registry (for ALL statuses, not just UNREAD)
  if (eventType === 'add') {
    try {
      const { title, contentPreview } = await extractContentInfo(filePath);

      await registerMessage({
        messageId,
        terminal,
        box: 'inbox',
        fromTerminal: frontmatter.from || 'unknown',
        toTerminal: frontmatter.to || terminal,
        type: (frontmatter.type as MessageType) || 'task',
        priority: (frontmatter.priority as MessagePriority) || 'medium',
        status: (frontmatter.status as MessageStatus) || 'UNREAD',
        model: frontmatter.model as ModelType | undefined,
        refMessageId: frontmatter.ref,
        filePath,
        title,
        contentPreview,
        createdAt: frontmatter.created || new Date().toISOString().split('T')[0],
      });
    } catch (err) {
      console.error(`[InboxWatcher] Failed to register message ${messageId}:`, err);
    }
  } else if (eventType === 'change') {
    // Update status if it changed
    try {
      await updateStatus(
        messageId,
        frontmatter.status as MessageStatus,
        'filesystem',
        'File changed'
      );
    } catch (err) {
      console.error(`[InboxWatcher] Failed to update message ${messageId}:`, err);
    }
  }

  // ─── FIX #1: Prevent re-injection of already-processed messages (MSG-121) ───
  // CRITICAL: Guard against READ/COMPLETED/INJECTED status
  if (frontmatter.status === 'READ' ||
      frontmatter.status === 'COMPLETED' ||
      frontmatter.status === 'INJECTED' ||
      frontmatter.injected) {
    console.log(`[InboxWatcher] Skipping ${messageId} - already processed (status=${frontmatter.status}, injected=${frontmatter.injected})`);
    return;
  }

  // Only emit wake-up events for UNREAD messages
  if (frontmatter.status !== 'UNREAD') return;

  // ─── FIX #2: Age-based filtering - skip messages >7 days old (MSG-121) ───
  // Prevents re-injection of old messages after file system events
  const messageAge = Date.now() - new Date(frontmatter.created || Date.now()).getTime();
  const MAX_AGE_DAYS = 7;

  if (messageAge > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
    const ageDays = Math.round(messageAge / (24 * 60 * 60 * 1000));
    console.log(`[InboxWatcher] Skipping old message ${messageId} (${ageDays}d old, threshold=${MAX_AGE_DAYS}d)`);
    return;
  }

  // ─── FIX #3: DONE outbox cross-check (MSG-121) ───
  // If DONE outbox exists, message is already completed - don't trigger
  const isDone = await hasDoneOutbox(terminal, messageId);
  if (isDone) {
    console.log(`[InboxWatcher] Skipping ${messageId} - DONE outbox exists`);
    return;
  }

  const event: InboxEvent = {
    type: eventType === 'add' ? 'new_inbox' : 'inbox_updated',
    terminal,
    messageId,
    filePath,
    status: frontmatter.status,
    priority: frontmatter.priority,
    messageType: frontmatter.type,
    timestamp: new Date().toISOString(),
  };

  console.log(`[InboxWatcher] ${event.type}: ${terminal} <- ${event.messageId} (${event.priority || 'normal'})`);
  inboxEvents.emit('inbox_change', event);
}

// ─── Helper: Check if DONE outbox exists for a message (Fix #3) ───
async function hasDoneOutbox(terminal: string, messageId: string): Promise<boolean> {
  const outboxPath = path.join(TERMINALS_PATH, terminal, 'outbox');
  try {
    const files = await fs.readdir(outboxPath);
    // Check for files containing 'done' and the message ID (case-insensitive)
    const msgIdLower = messageId.toLowerCase();
    return files.some(f =>
      f.toLowerCase().includes('done') &&
      f.toLowerCase().includes(msgIdLower)
    );
  } catch {
    return false;
  }
}

// Handle outbox file changes (for registry tracking)
async function handleOutboxChange(filePath: string, eventType: 'add' | 'change'): Promise<void> {
  if (!filePath.endsWith('.md')) return;

  // Extract terminal from outbox path
  const match = filePath.match(/\/terminals\/([^/]+)\/outbox\//);
  if (!match) return;

  const terminal = match[1];

  // Invalidate cache for this terminal immediately
  invalidateModelCache(terminal);

  const frontmatter = await parseFrontmatter(filePath);
  if (!frontmatter) return;

  const messageId = frontmatter.id || path.basename(filePath, '.md');

  if (eventType === 'add') {
    try {
      const { title, contentPreview } = await extractContentInfo(filePath);

      await registerMessage({
        messageId,
        terminal,
        box: 'outbox',
        fromTerminal: frontmatter.from || terminal,
        toTerminal: frontmatter.to || 'root',
        type: (frontmatter.type as MessageType) || 'done',
        priority: (frontmatter.priority as MessagePriority) || 'high',
        status: (frontmatter.status as MessageStatus) || 'UNREAD',
        model: frontmatter.model as ModelType | undefined,
        refMessageId: frontmatter.ref,
        filePath,
        title,
        contentPreview,
        createdAt: frontmatter.created || new Date().toISOString().split('T')[0],
      });

      console.log(`[InboxWatcher] Outbox registered: ${terminal} -> ${messageId}`);

      // ADR-053: Emit event to trigger subscriptions
      // Use 'ref' field as the original task ID for subscription matching
      // Also pass epic_id and checkpoint_id for checkpoint completion tracking
      const messageType = (frontmatter.type as string) || 'done';
      const refTaskId = frontmatter.ref || messageId; // Fall back to messageId if no ref

      // Try to get epic_id and checkpoint_id from outbox first
      let epicId = frontmatter.epic_id;
      let checkpointId = frontmatter.checkpoint_id;

      // If not in outbox, try to read from the original inbox task
      if (!epicId && frontmatter.ref) {
        const inboxPath = path.join(TERMINALS_PATH, terminal, 'inbox');
        try {
          const inboxFiles = await fs.readdir(inboxPath);
          for (const file of inboxFiles) {
            if (file.endsWith('.md')) {
              const inboxFilePath = path.join(inboxPath, file);
              const inboxFm = await parseFrontmatter(inboxFilePath);
              if (inboxFm?.id === frontmatter.ref) {
                epicId = inboxFm.epic_id;
                checkpointId = inboxFm.checkpoint_id;
                console.log(`[InboxWatcher] Found epic context from inbox: epic=${epicId}, cp=${checkpointId}`);
                break;
              }
            }
          }
        } catch {
          // Inbox not found, continue without epic context
        }
      }

      if (messageType === 'done') {
        emitOutboxEvent('outbox:done', terminal, refTaskId, {
          filePath,
          priority: frontmatter.priority,
          originalMessageId: messageId,
          ref: frontmatter.ref,
          epicId,
          checkpointId,
        });
        console.log(`[InboxWatcher] Emitted outbox:done event for ${refTaskId} (outbox: ${messageId})${epicId ? ` [epic: ${epicId}, cp: ${checkpointId}]` : ''}`);
      } else if (messageType === 'blocked') {
        emitOutboxEvent('outbox:blocked', terminal, refTaskId, {
          filePath,
          priority: frontmatter.priority,
          originalMessageId: messageId,
          ref: frontmatter.ref,
          epicId,
          checkpointId,
        });
        console.log(`[InboxWatcher] Emitted outbox:blocked event for ${refTaskId} (outbox: ${messageId})${epicId ? ` [epic: ${epicId}, cp: ${checkpointId}]` : ''}`);
      }
    } catch (err) {
      console.error(`[InboxWatcher] Failed to register outbox ${messageId}:`, err);
    }
  } else if (eventType === 'change') {
    try {
      await updateStatus(messageId, frontmatter.status as MessageStatus, 'filesystem', 'File changed');
    } catch (err) {
      console.error(`[InboxWatcher] Failed to update outbox ${messageId}:`, err);
    }
  }
}

// Start watching all inbox AND outbox directories
// 2026-06-24: Optimized to use native fs events (inotify on Linux) instead of polling
export function startInboxWatcher(): FSWatcher {
  // Watch the new terminals directory recursively
  // Use native fs events (inotify) on Linux - much more efficient than polling
  const useNativeEvents = process.platform === 'linux';

  console.log(`[InboxWatcher] Starting recursive watch on: ${TERMINALS_PATH}`);
  console.log(`[InboxWatcher] Using ${useNativeEvents ? 'native inotify' : 'polling'} mode`);

  const watcher = watch(TERMINALS_PATH, {
    persistent: true,
    ignoreInitial: true, // Don't emit for existing files on startup
    // Use native fs events on Linux (inotify), fallback to polling on other platforms
    usePolling: !useNativeEvents,
    interval: useNativeEvents ? undefined : 2000, // If polling, use 2s interval (was 1s)
    depth: 3, // Only need to go 3 levels: terminals/terminal/inbox|outbox/file.md
    awaitWriteFinish: {
      stabilityThreshold: 300, // Reduced from 500ms - files are small
      pollInterval: 100,
    },
    // Use atomic writes detection for better reliability
    atomic: true,
    // Filter to only watch inbox and outbox directories
    ignored: (pathStr: string) => {
      // Allow the terminals directory itself
      if (pathStr === TERMINALS_PATH) return false;
      // Allow terminal directories (terminals/terminal)
      if (pathStr.startsWith(TERMINALS_PATH) && !pathStr.includes('/inbox') && !pathStr.includes('/outbox')) {
        const relative = pathStr.slice(TERMINALS_PATH.length + 1);
        if (!relative.includes('/')) return false;
      }
      // Allow inbox and outbox directories
      if (pathStr.endsWith('/inbox') || pathStr.endsWith('/outbox')) return false;
      // Allow .md files in inbox or outbox directories
      if ((pathStr.includes('/inbox/') || pathStr.includes('/outbox/')) && pathStr.endsWith('.md')) return false;
      // Ignore everything else
      return true;
    },
  });

  watcher.on('add', (filePath: string) => {
    if (filePath.includes('/inbox/') && filePath.endsWith('.md')) {
      console.log(`[InboxWatcher] Inbox file detected: ${filePath}`);
      handleInboxChange(filePath, 'add');
    } else if (filePath.includes('/outbox/') && filePath.endsWith('.md')) {
      console.log(`[InboxWatcher] Outbox file detected: ${filePath}`);
      handleOutboxChange(filePath, 'add');
    }
  });

  watcher.on('change', (filePath: string) => {
    if (filePath.includes('/inbox/') && filePath.endsWith('.md')) {
      handleInboxChange(filePath, 'change');
    } else if (filePath.includes('/outbox/') && filePath.endsWith('.md')) {
      handleOutboxChange(filePath, 'change');
    }
  });

  watcher.on('error', (error: unknown) => {
    console.error('[InboxWatcher] Error:', error);
  });

  watcher.on('ready', () => {
    console.log('[InboxWatcher] Ready and watching for inbox/outbox changes');
  });

  return watcher;
}

// Sync registry with filesystem on startup
export async function initializeRegistry(): Promise<void> {
  console.log('[InboxWatcher] Initializing message registry...');
  const result = await syncWithFilesystem();
  console.log(`[InboxWatcher] Registry sync complete: ${result.registered} registered, ${result.updated} updated`);
}

// Scan for existing UNREAD messages (call on startup if needed)
export async function scanExistingUnread(): Promise<InboxEvent[]> {
  const events: InboxEvent[] = [];

  try {
    const terminals = await fs.readdir(TERMINALS_PATH);

    for (const terminal of terminals) {
      // Skip hidden directories and _legacy_archive
      if (terminal.startsWith('.') || terminal.startsWith('_')) continue;

      const inboxPath = path.join(TERMINALS_PATH, terminal, 'inbox');

      try {
        const files = await fs.readdir(inboxPath);

        for (const file of files) {
          if (!file.endsWith('.md')) continue;

          const filePath = path.join(inboxPath, file);
          const frontmatter = await parseFrontmatter(filePath);

          if (frontmatter?.status === 'UNREAD') {
            events.push({
              type: 'new_inbox',
              terminal,
              messageId: frontmatter.id || path.basename(file, '.md'),
              filePath,
              status: 'UNREAD',
              priority: frontmatter.priority,
              messageType: frontmatter.type,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch {
        // Inbox directory doesn't exist for this terminal
      }
    }
  } catch (error) {
    console.error('[InboxWatcher] Error scanning existing:', error);
  }

  return events;
}
