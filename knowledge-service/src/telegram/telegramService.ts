/**
 * Telegram Service - Core messaging functions
 *
 * Provides:
 * - Direct message sending to Telegram
 * - Terminal injection via tmux
 * - Response queue processing
 *
 * ADR-049 Phase 1: Routes Telegram messages to chat sessions
 */

import { execSync } from 'child_process';
import {
  getPendingResponses,
  markResponseSent,
  markResponseFailed,
  retryFailedResponses,
  expireOldConversations,
  cleanupOldResponses,
} from './conversationManager';
import { startChatSession } from '../chatSessionStarter';
import { sendFromTerminal } from './multiBotManager';

// ─── Constants ───────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
// Don't use any socket - let tmux use default socket which actually has the sessions

// Terminal name → tmux session name mapping
// ADR-049 Phase 1: Telegram messages route to CHAT sessions
const TERMINAL_SESSIONS: Record<string, string> = {
  root: 'spaceos-root-chat',
  conductor: 'spaceos-conductor-chat',
  backend: 'spaceos-backend-chat',
  frontend: 'spaceos-frontend-chat',
  architect: 'spaceos-architect-chat',
  librarian: 'spaceos-librarian-chat',
  explorer: 'spaceos-explorer-chat',
  designer: 'spaceos-designer-chat',
};

// ─── Telegram API Functions ──────────────────────────────────────────────────

/**
 * Send a message to Telegram
 */
export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  options: {
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
    replyToMessageId?: number;
  } = {}
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  if (!TELEGRAM_TOKEN) {
    return { success: false, error: 'No Telegram token configured' };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: options.parseMode || 'HTML',
        reply_to_message_id: options.replyToMessageId,
      }),
    });

    const data = await response.json() as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };

    if (!response.ok || !data.ok) {
      return {
        success: false,
        error: data.description || `HTTP ${response.status}`,
      };
    }

    return {
      success: true,
      messageId: data.result?.message_id,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Send a notification to the default chat
 */
export async function sendNotification(message: string): Promise<boolean> {
  if (!TELEGRAM_CHAT_ID) return false;

  const result = await sendTelegramMessage(TELEGRAM_CHAT_ID, message, {
    parseMode: 'Markdown',
  });

  return result.success;
}

// ─── Tmux Injection Functions ────────────────────────────────────────────────

/**
 * Check if a tmux session exists (uses default socket)
 */
function sessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Inject a message into a tmux session (uses default socket)
 */
function injectToTmuxSession(
  sessionName: string,
  text: string
): boolean {
  if (!sessionExists(sessionName)) {
    console.log(`[TelegramService] Session ${sessionName} not found`);
    return false;
  }

  try {
    // Escape the text for safe shell transmission
    const safeText = text
      .replace(/\r?\n/g, ' ')
      .replace(/'/g, "'\\''");

    // Send text, wait, then send Enter using hex code (0d = carriage return)
    // Using -H 0d instead of Enter keyword to avoid bracketed paste mode swallowing it
    const cmd = `tmux send-keys -t ${sessionName} -l '${safeText}' && sleep 2 && tmux send-keys -t ${sessionName} -H 0d`;
    execSync(cmd, { timeout: 15000 });

    console.log(`[TelegramService] Injected message into ${sessionName}`);
    return true;
  } catch (err) {
    console.error(`[TelegramService] Failed to inject into ${sessionName}:`, err);
    return false;
  }
}

/**
 * Inject a message to a terminal
 * Format: [AGENT @fromTerminal priority] message
 */
export async function injectMessageToTerminal(
  targetTerminal: string,
  message: string,
  fromTerminal: string,
  priority: string = 'medium'
): Promise<boolean> {
  const sessionName = TERMINAL_SESSIONS[targetTerminal];
  if (!sessionName) {
    throw new Error(`Unknown terminal: ${targetTerminal}`);
  }

  // Format the message with metadata
  const priorityEmoji = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢',
  }[priority] || '🟡';

  const formattedMessage = `[AGENT @${fromTerminal} ${priorityEmoji}${priority}] ${message}`;

  return injectToTmuxSession(sessionName, formattedMessage);
}

/**
 * Inject a Telegram user message to a terminal
 * Format: [TG @username conv:ID] message
 *
 * ADR-049 Phase 1: Auto-starts chat session if not running
 */
export async function injectTelegramMessageToTerminal(
  targetTerminal: string,
  username: string,
  conversationId: number | undefined,
  message: string
): Promise<boolean> {
  const sessionName = TERMINAL_SESSIONS[targetTerminal];
  if (!sessionName) {
    console.error(`[TelegramService] Unknown terminal: ${targetTerminal}`);
    return false;
  }

  // ADR-049 Phase 1: Auto-start chat session if not running
  if (!sessionExists(sessionName)) {
    console.log(`[TelegramService] Chat session ${sessionName} not running, starting...`);
    const result = await startChatSession(targetTerminal);
    if (!result.success) {
      console.error(`[TelegramService] Failed to start chat session: ${result.message}`);
      return false;
    }
    console.log(`[TelegramService] ✓ Chat session ${sessionName} started`);

    // Wait a bit for session to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const convPart = conversationId ? ` conv:${conversationId}` : '';
  const formattedMessage = `[TG @${username}${convPart}] ${message}`;

  return injectToTmuxSession(sessionName, formattedMessage);
}

// ─── Response Worker ─────────────────────────────────────────────────────────

let workerInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Process the response queue - send pending messages to Telegram
 * ADR-049: Uses terminal-specific bots when available
 */
async function processResponseQueue(): Promise<void> {
  const pending = getPendingResponses(5);

  for (const item of pending) {
    let success = false;
    let error = 'Unknown error';

    // Try terminal-specific bot first (ADR-049 multi-bot)
    if (item.fromTerminal && item.fromTerminal !== 'unknown') {
      success = await sendFromTerminal(item.fromTerminal, item.chatId, item.message);
      if (success) {
        console.log(`[TelegramService] Sent via ${item.fromTerminal} bot: msg ${item.id}`);
      } else {
        console.log(`[TelegramService] ${item.fromTerminal} bot not active, falling back to global`);
      }
    }

    // Fallback to global bot if terminal bot failed/unavailable
    if (!success) {
      const result = await sendTelegramMessage(item.chatId, item.message, {
        parseMode: item.parseMode,
        replyToMessageId: item.replyToMessageId || undefined,
      });
      success = result.success;
      error = result.error || 'Unknown error';
    }

    if (success) {
      markResponseSent(item.id);
    } else {
      markResponseFailed(item.id, error);
      console.error(`[TelegramService] Failed to send message ${item.id}: ${error}`);
    }

    // Small delay between messages to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Run periodic cleanup tasks
 */
async function runCleanupTasks(): Promise<void> {
  const expired = expireOldConversations();
  const cleaned = cleanupOldResponses();
  const retried = retryFailedResponses();

  if (expired > 0 || cleaned > 0 || retried > 0) {
    console.log(`[TelegramService] Cleanup: expired=${expired}, cleaned=${cleaned}, retried=${retried}`);
  }
}

/**
 * Start the response worker
 */
export function startResponseWorker(): void {
  if (workerInterval) return;

  console.log('[TelegramService] Starting response worker...');

  // Process queue every 1 second
  workerInterval = setInterval(() => {
    processResponseQueue().catch(err => {
      console.error('[TelegramService] Response queue error:', err);
    });
  }, 1000);

  // Run cleanup every 5 minutes
  cleanupInterval = setInterval(() => {
    runCleanupTasks().catch(err => {
      console.error('[TelegramService] Cleanup error:', err);
    });
  }, 5 * 60 * 1000);
}

/**
 * Stop the response worker
 */
export function stopResponseWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  console.log('[TelegramService] Response worker stopped');
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  TERMINAL_SESSIONS,
  sessionExists,
};
