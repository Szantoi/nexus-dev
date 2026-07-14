/**
 * telegramBot.ts — Telegram Bot Webhook Handler
 *
 * Receives messages from Telegram via webhook and processes them.
 * The webhook endpoint is /api/telegram/webhook
 *
 * Commands:
 *   /status  — Show fleet status (working/idle terminals)
 *   /inbox   — Show pending inbox messages
 *   /queue   — Show planning queue
 *   /health  — System health check
 *   /help    — Show available commands
 *
 * Any other message is forwarded to the root terminal inbox AND
 * the message is injected directly into the root tmux session.
 */

import { log } from './common';
import { getFleetSnapshot, type FleetSnapshot } from './missionControl';
import { execSync } from 'child_process';
import {
  parseIntent,
  formatTargets,
  getPriorityEmoji,
  type ParsedIntent,
} from '../telegram/intentParser';
import {
  getOrCreateConversation,
  addMessage,
  getLastIncomingMessageId,
  getConversation,
} from '../telegram/conversationManager';
import {
  injectTelegramMessageToTerminal,
  TERMINAL_SESSIONS,
} from '../telegram/telegramService';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TelegramBotUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramMessageEntity[];
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: 'bot_command' | 'mention' | 'hashtag' | 'url' | 'bold' | 'italic' | 'code' | 'pre' | string;
  offset: number;
  length: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface WebhookConfig {
  token: string;
  webhookUrl: string;
  allowedChatIds: number[];
  secretToken?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'spaceos-webhook-secret-2026';

// Allowed chat IDs (add more as needed)
const ALLOWED_CHAT_IDS = TELEGRAM_CHAT_ID ? [parseInt(TELEGRAM_CHAT_ID, 10)] : [];

// Message handlers registry
type MessageHandler = (message: TelegramMessage) => Promise<string | null>;
const messageHandlers: Map<string, MessageHandler> = new Map();

// Root session name (priority terminal)
// ADR-049 Phase 1: Root also gets a chat session for Telegram
const ROOT_SESSION = 'spaceos-root-chat';

// ─── Tmux Session Injection ───────────────────────────────────────────────────

/**
 * Check if a tmux session exists
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
 * Send a prompt directly to a tmux session using send-keys
 * This injects the message into the Claude session so it sees it immediately
 */
function sendPromptToTmuxSession(sessionName: string, text: string): boolean {
  if (!sessionExists(sessionName)) {
    log(`[TelegramBot] Session ${sessionName} not found`);
    return false;
  }

  try {
    // Escape the text for safe shell transmission
    // Replace newlines with spaces, escape special characters
    const safeText = text
      .replace(/\r?\n/g, ' ')
      .replace(/'/g, "'\\''");

    // Send the text using tmux send-keys -l (literal mode)
    // Break into chunks to avoid paste detection issues
    const CHUNK_SIZE = 80;
    for (let i = 0; i < safeText.length; i += CHUNK_SIZE) {
      const chunk = safeText.slice(i, i + CHUNK_SIZE);
      execSync(`tmux send-keys -t ${sessionName} -l '${chunk}'`, { timeout: 5000 });
    }

    // Send Enter using hex code 0d to avoid bracketed paste mode issue
    execSync(`tmux send-keys -t ${sessionName} -H 0d`, { timeout: 5000 });

    log(`[TelegramBot] Injected message into ${sessionName}`);
    return true;
  } catch (err) {
    log(`[TelegramBot] Failed to inject into ${sessionName}: ${err}`);
    return false;
  }
}

/**
 * Inject a Telegram message into the root session
 * Format: [TELEGRAM @username] message
 */
function injectTelegramMessageToRoot(username: string, text: string): boolean {
  const prompt = `[TELEGRAM @${username}] ${text}`;
  return sendPromptToTmuxSession(ROOT_SESSION, prompt);
}

// ─── Telegram API ────────────────────────────────────────────────────────────

/**
 * Send a message to a Telegram chat
 */
export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  options: { parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2'; replyToMessageId?: number } = {}
): Promise<boolean> {
  if (!TELEGRAM_TOKEN) {
    log('[TelegramBot] No token configured');
    return false;
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

    if (!response.ok) {
      const body = await response.text();
      log(`[TelegramBot] Send failed: ${response.status} - ${body.slice(0, 200)}`);
      return false;
    }

    return true;
  } catch (err) {
    log(`[TelegramBot] Send error: ${err}`);
    return false;
  }
}

/**
 * Set up webhook
 */
export async function setWebhook(webhookUrl: string): Promise<boolean> {
  if (!TELEGRAM_TOKEN) {
    log('[TelegramBot] No token configured');
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      }),
    });

    const data = await response.json() as { ok: boolean; description?: string };
    if (data.ok) {
      log(`[TelegramBot] Webhook set to: ${webhookUrl}`);
      return true;
    } else {
      log(`[TelegramBot] Webhook failed: ${data.description}`);
      return false;
    }
  } catch (err) {
    log(`[TelegramBot] Webhook error: ${err}`);
    return false;
  }
}

/**
 * Delete webhook (switch to polling mode)
 */
export async function deleteWebhook(): Promise<boolean> {
  if (!TELEGRAM_TOKEN) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`, {
      method: 'POST',
    });
    const data = await response.json() as { ok: boolean };
    return data.ok;
  } catch {
    return false;
  }
}

/**
 * Get webhook info
 */
export async function getWebhookInfo(): Promise<{
  url: string;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
  lastErrorDate?: number;
  lastErrorMessage?: string;
} | null> {
  if (!TELEGRAM_TOKEN) return null;

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    const data = await response.json() as {
      ok: boolean;
      result?: {
        url: string;
        has_custom_certificate: boolean;
        pending_update_count: number;
        last_error_date?: number;
        last_error_message?: string;
      };
    };

    if (data.ok && data.result) {
      return {
        url: data.result.url,
        hasCustomCertificate: data.result.has_custom_certificate,
        pendingUpdateCount: data.result.pending_update_count,
        lastErrorDate: data.result.last_error_date,
        lastErrorMessage: data.result.last_error_message,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Command Handlers ────────────────────────────────────────────────────────

/**
 * Handle /status command
 */
async function handleStatusCommand(_message: TelegramMessage): Promise<string> {
  try {
    const snapshot = await getFleetSnapshot();

    const lines = [
      '<b>🤖 SpaceOS Fleet Status</b>',
      '',
      `<b>Summary:</b>`,
      `  Working: ${snapshot.summary.working}`,
      `  Idle: ${snapshot.summary.idle}`,
      `  Offline: ${snapshot.summary.offline}`,
      `  Unread: ${snapshot.summary.totalUnread}`,
      '',
      '<b>Terminals:</b>',
    ];

    for (const agent of snapshot.agents) {
      const emoji = agent.status === 'working' ? '🟢' : agent.status === 'idle' ? '🟡' : '⚫';
      const task = agent.currentTask ? ` — ${agent.currentTask.slice(0, 30)}` : '';
      lines.push(`  ${emoji} <b>${agent.name}</b>: ${agent.status}${task}`);
    }

    return lines.join('\n');
  } catch (err) {
    return `❌ Error getting status: ${err}`;
  }
}

/**
 * Handle /inbox command
 */
async function handleInboxCommand(_message: TelegramMessage): Promise<string> {
  try {
    const snapshot = await getFleetSnapshot();

    const withUnread = snapshot.agents.filter(a => a.metrics.unreadInbox > 0);

    if (withUnread.length === 0) {
      return '📭 No unread inbox messages';
    }

    const lines = ['<b>📬 Unread Inbox Messages</b>', ''];
    for (const agent of withUnread) {
      lines.push(`  <b>${agent.name}</b>: ${agent.metrics.unreadInbox} unread`);
    }

    return lines.join('\n');
  } catch (err) {
    return `❌ Error: ${err}`;
  }
}

/**
 * Handle /queue command
 */
async function handleQueueCommand(_message: TelegramMessage): Promise<string> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const queueDir = process.env.QUEUE_DIR || `${process.env.SPACEOS_ROOT || '/opt/spaceos'}/docs/planning/queue`;
    const files = await fs.readdir(queueDir).catch(() => [] as string[]);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    if (mdFiles.length === 0) {
      return '📋 Planning queue is empty';
    }

    const lines = ['<b>📋 Planning Queue</b>', '', `${mdFiles.length} item(s):`];
    for (const file of mdFiles.slice(0, 5)) {
      lines.push(`  • ${file.replace('.md', '')}`);
    }
    if (mdFiles.length > 5) {
      lines.push(`  ... and ${mdFiles.length - 5} more`);
    }

    return lines.join('\n');
  } catch (err) {
    return `❌ Error: ${err}`;
  }
}

/**
 * Handle /health command
 */
async function handleHealthCommand(_message: TelegramMessage): Promise<string> {
  try {
    const response = await fetch('http://localhost:3456/health');
    const data = await response.json() as Record<string, unknown>;

    return [
      '<b>💚 System Health</b>',
      '',
      `Status: ${data.status}`,
      `Vector: ${data.vectorBackend}`,
      `Embedding: ${data.embeddingBackend}`,
      `Documents: ${data.documents}`,
    ].join('\n');
  } catch (err) {
    return `❌ Health check failed: ${err}`;
  }
}

/**
 * Handle /help command
 */
async function handleHelpCommand(_message: TelegramMessage): Promise<string> {
  return [
    '<b>🤖 SpaceOS Bot Commands</b>',
    '',
    '/status — Fleet status (working/idle)',
    '/inbox — Unread inbox messages',
    '/queue — Planning queue',
    '/health — System health',
    '/help — This help',
    '',
    'Any other message is forwarded to root.',
  ].join('\n');
}

// Register built-in commands
messageHandlers.set('/status', handleStatusCommand);
messageHandlers.set('/inbox', handleInboxCommand);
messageHandlers.set('/queue', handleQueueCommand);
messageHandlers.set('/health', handleHealthCommand);
messageHandlers.set('/help', handleHelpCommand);

// ─── Message Processing ──────────────────────────────────────────────────────

/**
 * Process an incoming webhook update
 */
export async function processWebhookUpdate(update: TelegramBotUpdate, targetTerminal?: string): Promise<void> {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text || '';
  const username = message.from.username || message.from.first_name || String(message.from.id);

  // Security check: only allow configured chat IDs
  // Skip for terminal-specific bots (they have their own authorization)
  if (!targetTerminal && ALLOWED_CHAT_IDS.length > 0 && !ALLOWED_CHAT_IDS.includes(chatId)) {
    log(`[TelegramBot] Ignored message from unauthorized chat: ${chatId}`);
    await sendTelegramMessage(chatId, '⛔ Unauthorized. This bot is private.');
    return;
  }

  const terminalInfo = targetTerminal ? ` [via ${targetTerminal} bot]` : '';
  log(`[TelegramBot] Message from @${username} (${chatId})${terminalInfo}: ${text.slice(0, 50)}...`);

  // Check for commands
  if (text.startsWith('/')) {
    const command = text.split(' ')[0].split('@')[0].toLowerCase(); // Remove @botname
    const handler = messageHandlers.get(command);

    if (handler) {
      const response = await handler(message);
      if (response) {
        await sendTelegramMessage(chatId, response, { replyToMessageId: message.message_id });
      }
      return;
    }
  }

  // Process free-form messages with intent parsing
  // If targetTerminal is specified, force routing to that terminal
  await processUserMessage(message, username, targetTerminal);
}

/**
 * Process a user message with intent parsing and smart routing
 * @param targetTerminal - If specified (from terminal-specific webhook), forces routing to that terminal
 */
async function processUserMessage(message: TelegramMessage, username: string, targetTerminal?: string): Promise<void> {
  const text = message.text || '';
  const chatId = message.chat.id;
  const userId = message.from.id;

  // Parse the intent (but may be overridden by targetTerminal)
  const intent = parseIntent(text);

  // If targetTerminal is specified (from dedicated bot webhook), override targets
  if (targetTerminal) {
    log(`[TelegramBot] Dedicated bot for terminal: ${targetTerminal} - overriding intent targets`);
    intent.targets = [targetTerminal];
    intent.isBroadcast = false;
    intent.isGroupMessage = false;
  }

  log(`[TelegramBot] Intent: type=${intent.type}, targets=${formatTargets(intent.targets)}, priority=${intent.priority}`);

  // Get or create conversation
  const conversation = getOrCreateConversation({
    chatId,
    userId,
    username,
    contextTerminal: intent.targets[0], // Primary target
  });

  // Record incoming message
  addMessage({
    conversationId: conversation.id,
    telegramMessageId: message.message_id,
    direction: 'in',
    content: text,
  });

  // Try to inject to target terminal(s)
  // ADR-049 Phase 1: injectTelegramMessageToTerminal is now async (auto-starts chat sessions)
  const results: Array<{ terminal: string; success: boolean }> = [];

  for (const target of intent.targets) {
    const injected = await injectTelegramMessageToTerminal(
      target,
      username,
      conversation.id,
      intent.content
    );
    results.push({ terminal: target, success: injected });
  }

  const successCount = results.filter(r => r.success).length;

  // Send confirmation based on results
  if (successCount === intent.targets.length) {
    // All targets received the message
    const emoji = getPriorityEmoji(intent.priority);
    const targetStr = intent.isBroadcast
      ? 'minden terminálnak'
      : intent.isGroupMessage
        ? formatTargets(intent.targets)
        : intent.targets[0];

    await sendTelegramMessage(chatId, `${emoji} Elküldve: ${targetStr}`, {
      replyToMessageId: message.message_id,
    });
  } else if (successCount > 0) {
    // Partial success
    const sent = results.filter(r => r.success).map(r => r.terminal);
    const failed = results.filter(r => !r.success).map(r => r.terminal);

    await sendTelegramMessage(
      chatId,
      `⚠️ Részben sikeres:\n✅ ${sent.join(', ')}\n❌ ${failed.join(', ')} (offline - inbox-ba mentve)`,
      { replyToMessageId: message.message_id }
    );

    // Save to inbox for offline terminals
    await saveToInboxForOfflineTerminals(failed, message, username, intent, conversation.id);
  } else {
    // All targets offline - save to inbox
    log(`[TelegramBot] All targets offline, saving to inbox`);
    await saveToInboxForOfflineTerminals(intent.targets, message, username, intent, conversation.id);

    await sendTelegramMessage(
      chatId,
      `📬 Terminál(ok) offline - mentve inbox-ba: ${formatTargets(intent.targets)}`,
      { replyToMessageId: message.message_id }
    );
  }
}

/**
 * Save message to inbox for offline terminals
 */
async function saveToInboxForOfflineTerminals(
  terminals: string[],
  message: TelegramMessage,
  username: string,
  intent: ParsedIntent,
  conversationId: number
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  for (const terminal of terminals) {
    try {
      const inboxDir = `/opt/spaceos/terminals/${terminal}/inbox`;

      // Find next message number
      const files = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const nums = files
        .map(f => parseInt(f.match(/_(\d{3})_/)?.[1] || '0', 10))
        .filter(n => !isNaN(n));
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;

      const date = new Date().toISOString().slice(0, 10);
      const slug = 'telegram-message';
      const terminalUpper = terminal.toUpperCase();
      const filename = `${date}_${String(nextNum).padStart(3, '0')}_${slug}.md`;

      const content = `---
id: MSG-${terminalUpper}-${nextNum}
from: telegram
to: ${terminal}
type: ${intent.type}
priority: ${intent.priority}
status: UNREAD
model: sonnet
created: ${date}
telegram_chat_id: ${message.chat.id}
telegram_conversation_id: ${conversationId}
---

# Telegram Message

**From:** @${username}
**Date:** ${new Date().toISOString()}
**Priority:** ${intent.priority}
**Conversation:** ${conversationId}

## Message

${intent.content}

---

*Received via Telegram webhook*
*Reply using: mcp__spaceos-knowledge__telegram_reply { chat_id: ${message.chat.id}, conversation_id: ${conversationId}, message: "..." }*
`;

      await fs.writeFile(path.join(inboxDir, filename), content);
      log(`[TelegramBot] Saved to ${terminal} inbox: ${filename}`);
    } catch (err) {
      log(`[TelegramBot] Error saving to ${terminal} inbox: ${err}`);
    }
  }
}

// ─── Express Router ──────────────────────────────────────────────────────────

/**
 * Create Express router for Telegram webhook
 */
export function createTelegramRouter() {
  const express = require('express');
  const router = express.Router();

  // Webhook endpoint (central bot - datahaven_daemon_bot)
  router.post('/webhook', async (req: any, res: any) => {
    // Verify secret token
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    if (WEBHOOK_SECRET && secretHeader !== WEBHOOK_SECRET) {
      log('[TelegramBot] Invalid webhook secret');
      return res.status(403).json({ error: 'Invalid secret' });
    }

    try {
      const update = req.body as TelegramBotUpdate;
      await processWebhookUpdate(update);
      res.json({ ok: true });
    } catch (err) {
      log(`[TelegramBot] Webhook error: ${err}`);
      res.status(500).json({ error: 'Processing failed' });
    }
  });

  // Terminal-specific webhook endpoints (dedicated bots per terminal)
  // Format: /webhook/:terminal (e.g., /webhook/root for Sárkány bot)
  router.post('/webhook/:terminal', async (req: any, res: any) => {
    const terminal = req.params.terminal;
    log(`[TelegramBot] Terminal-specific webhook: ${terminal}`);

    try {
      const update = req.body as TelegramBotUpdate;
      // Add terminal context to the update for routing
      (update as any).target_terminal = terminal;
      await processWebhookUpdate(update, terminal);
      res.json({ ok: true, terminal });
    } catch (err) {
      log(`[TelegramBot] Webhook error (${terminal}): ${err}`);
      res.status(500).json({ error: 'Processing failed', terminal });
    }
  });

  // Get webhook info
  router.get('/info', async (_req: any, res: any) => {
    const info = await getWebhookInfo();
    res.json({
      configured: !!TELEGRAM_TOKEN,
      chatId: TELEGRAM_CHAT_ID,
      webhookInfo: info,
    });
  });

  // Set webhook
  router.post('/setup', async (req: any, res: any) => {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    const success = await setWebhook(url);
    res.json({ success, url });
  });

  // Delete webhook
  router.delete('/webhook', async (_req: any, res: any) => {
    const success = await deleteWebhook();
    res.json({ success });
  });

  // Reply endpoint - sends message and stores in conversation
  // This is the HTTP equivalent of the MCP telegram_reply tool
  router.post('/reply', async (req: any, res: any) => {
    const {
      chat_id,
      conversation_id,
      message,
      parse_mode = 'HTML',
      from_terminal = 'api',
    } = req.body;

    if (!chat_id || !message) {
      return res.status(400).json({
        error: 'chat_id and message are required',
      });
    }

    try {
      // Get last incoming message ID for reply-to (if conversation exists)
      let replyToMessageId: number | undefined;
      if (conversation_id) {
        const lastMsgId = getLastIncomingMessageId(conversation_id);
        if (lastMsgId) {
          replyToMessageId = lastMsgId;
        }
      }

      // Format message with terminal badge
      const terminalBadge = from_terminal && from_terminal !== 'api'
        ? `[${from_terminal.toUpperCase()}] `
        : '';
      const formattedMessage = `${terminalBadge}${message}`;

      // Send immediately (NO queue to avoid duplicate sends)
      const sent = await sendTelegramMessage(chat_id, formattedMessage, {
        parseMode: parse_mode as 'HTML' | 'Markdown' | 'MarkdownV2',
        replyToMessageId,
      });

      // Record in conversation_messages for history (after successful send)
      if (sent && conversation_id) {
        addMessage({
          conversationId: conversation_id,
          telegramMessageId: 0, // Telegram ID not available from sendMessage
          direction: 'out',
          content: message,
          fromTerminal: from_terminal,
          replyToMessageId,
        });
      }

      log(`[TelegramBot] Reply sent via API: chat=${chat_id}, conv=${conversation_id}, sent=${sent}`);

      res.json({
        success: true,
        sent,
        conversationId: conversation_id,
      });
    } catch (err) {
      log(`[TelegramBot] Reply error: ${err}`);
      res.status(500).json({ error: 'Failed to send reply', details: String(err) });
    }
  });

  // ─── Brainstorm Chat Endpoint ─────────────────────────────────────────────────
  // Lightweight endpoint for informal terminal communication
  // No conversation tracking, no queue - just direct send with tag

  const TAG_EMOJIS: Record<string, string> = {
    idea: '💡',
    question: '❓',
    note: '📝',
    alert: '⚠️',
    done: '✅',
    blocked: '🚫',
    info: 'ℹ️',
  };

  router.post('/chat', async (req: any, res: any) => {
    const {
      from,
      message,
      tag = 'note',
    } = req.body;

    if (!from || !message) {
      return res.status(400).json({
        error: 'from and message are required',
      });
    }

    const emoji = TAG_EMOJIS[tag] || '💬';
    const terminalBadge = `[${from.toUpperCase()}]`;
    const formattedMessage = `${emoji} ${terminalBadge} ${message}`;

    try {
      const sent = await sendTelegramMessage(TELEGRAM_CHAT_ID, formattedMessage, {
        parseMode: 'HTML',
      });

      const preview = message.length > 50 ? message.substring(0, 50) + '...' : message;
      log(`[TelegramBot] Chat message: ${from} (${tag}): ${preview}`);

      res.json({
        success: true,
        sent,
        tag,
        from,
      });
    } catch (err) {
      log(`[TelegramBot] Chat error: ${err}`);
      res.status(500).json({ error: 'Failed to send chat', details: String(err) });
    }
  });

  return router;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  WEBHOOK_SECRET,
  ALLOWED_CHAT_IDS,
};
