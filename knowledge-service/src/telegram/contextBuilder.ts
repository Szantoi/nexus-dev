/**
 * Context Builder for Telegram CLI Injection
 *
 * ADR-060: CLI-Agnosztikus Telegram Architektúra
 *
 * Builds formatted conversation context for injection into CLI sessions.
 * The CLI agent receives the full conversation history (in + out messages)
 * to maintain context across multiple turns.
 *
 * Output format:
 * ```
 * [TG @username conv:ID]
 *
 * --- Conversation History ---
 * [HH:MM] 👤 @user: message
 * [HH:MM] 🤖 terminal: response
 * --- End History ---
 *
 * Új üzenet: <latest message>
 * ```
 */

import { ConversationMessage, Conversation, getConversationMessages } from './conversationManager';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IncomingTelegramMessage {
  chatId: number;
  userId: number;
  username: string;
  text: string;
  messageId: number;
  conversationId: number;
  receivedByBot?: string;
}

export interface ContextBuildOptions {
  /** Maximum number of history messages to include (default: 10) */
  maxHistory?: number;
  /** Include timestamp in history entries (default: true) */
  includeTimestamps?: boolean;
  /** Language for labels (default: 'hu') */
  language?: 'hu' | 'en';
}

interface ContextLabels {
  historyStart: string;
  historyEnd: string;
  newMessage: string;
  userPrefix: string;
  botPrefix: string;
}

const LABELS: Record<'hu' | 'en', ContextLabels> = {
  hu: {
    historyStart: '--- Conversation History ---',
    historyEnd: '--- End History ---',
    newMessage: 'Új üzenet:',
    userPrefix: '👤',
    botPrefix: '🤖',
  },
  en: {
    historyStart: '--- Conversation History ---',
    historyEnd: '--- End History ---',
    newMessage: 'New message:',
    userPrefix: '👤',
    botPrefix: '🤖',
  },
};

// ─── Context Builder ─────────────────────────────────────────────────────────

/**
 * Build formatted context for CLI injection
 *
 * This is the main function used by the injection layer to create
 * the prompt that gets sent to the CLI session via tmux send-keys.
 */
export function buildContextForInjection(
  newMessage: IncomingTelegramMessage,
  history: ConversationMessage[],
  options: ContextBuildOptions = {}
): string {
  const {
    maxHistory = 10,
    includeTimestamps = true,
    language = 'hu',
  } = options;

  const labels = LABELS[language];
  const lines: string[] = [];

  // Header with user info and conversation ID
  lines.push(`[TG @${newMessage.username} conv:${newMessage.conversationId}]`);
  lines.push('');

  // Conversation history (if any)
  const limitedHistory = history.slice(-maxHistory);
  if (limitedHistory.length > 0) {
    lines.push(labels.historyStart);

    for (const msg of limitedHistory) {
      const line = formatHistoryLine(msg, newMessage.username, includeTimestamps, labels);
      lines.push(line);
    }

    lines.push(labels.historyEnd);
    lines.push('');
  }

  // New message
  lines.push(`${labels.newMessage} ${newMessage.text}`);

  return lines.join('\n');
}

/**
 * Build context using conversation ID (fetches history from DB)
 */
export function buildContextFromConversation(
  newMessage: IncomingTelegramMessage,
  options: ContextBuildOptions = {}
): string {
  const maxHistory = options.maxHistory ?? 10;

  // Fetch history from database
  const history = getConversationMessages(newMessage.conversationId, maxHistory + 1);

  // Remove the new message from history if it's already there
  // (it might have been saved before this call)
  const filteredHistory = history.filter(
    msg => msg.telegramMessageId !== newMessage.messageId
  );

  return buildContextForInjection(newMessage, filteredHistory, options);
}

/**
 * Build minimal context (just header + message, no history)
 */
export function buildMinimalContext(newMessage: IncomingTelegramMessage): string {
  return `[TG @${newMessage.username} conv:${newMessage.conversationId}]\n\n${newMessage.text}`;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function formatHistoryLine(
  msg: ConversationMessage,
  currentUsername: string,
  includeTimestamp: boolean,
  labels: ContextLabels
): string {
  const parts: string[] = [];

  // Timestamp
  if (includeTimestamp) {
    const time = msg.createdAt.slice(11, 16); // Extract HH:MM from ISO string
    parts.push(`[${time}]`);
  }

  // Direction prefix (user or bot)
  if (msg.direction === 'in') {
    parts.push(`${labels.userPrefix} @${currentUsername}:`);
  } else {
    const terminal = msg.fromTerminal || 'agent';
    parts.push(`${labels.botPrefix} ${terminal}:`);
  }

  // Message content (truncate if too long)
  const content = truncateMessage(msg.content, 200);
  parts.push(content);

  return parts.join(' ');
}

function truncateMessage(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}

// ─── CLI Injection Formatting ────────────────────────────────────────────────

/**
 * Escape special characters for tmux send-keys
 *
 * tmux send-keys interprets certain characters specially.
 * This function escapes them for safe injection.
 */
export function escapeForTmux(text: string): string {
  return text
    // Escape backslashes first
    .replace(/\\/g, '\\\\')
    // Escape single quotes
    .replace(/'/g, "'\\''")
    // Escape semicolons (tmux command separator)
    .replace(/;/g, '\\;')
    // Escape dollar signs (variable expansion)
    .replace(/\$/g, '\\$')
    // Replace newlines with literal \n for tmux
    .replace(/\n/g, '\n');
}

/**
 * Build the full tmux send-keys command
 */
export function buildTmuxCommand(
  sessionName: string,
  context: string
): string {
  const escapedContext = escapeForTmux(context);
  // Use heredoc-style injection for multi-line content
  return `tmux send-keys -t ${sessionName} -H 0x0D 0x0D '${escapedContext}'`;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate incoming message has required fields
 */
export function validateIncomingMessage(msg: Partial<IncomingTelegramMessage>): msg is IncomingTelegramMessage {
  return (
    typeof msg.chatId === 'number' &&
    typeof msg.userId === 'number' &&
    typeof msg.username === 'string' &&
    typeof msg.text === 'string' &&
    typeof msg.messageId === 'number' &&
    typeof msg.conversationId === 'number'
  );
}

// ─── Export Types ────────────────────────────────────────────────────────────

export type { ConversationMessage, Conversation };
