/**
 * Multi-Bot Manager - ADR-060 CLI-Agnostic Telegram Architecture
 *
 * Manages multiple Telegram bots, one per terminal.
 * Each bot has its own polling loop and routes messages to the appropriate chat session.
 *
 * ADR-060 changes:
 * - Stores incoming messages in DB (conversation_messages)
 * - Injects full conversation context (history in + out)
 * - Uses contextBuilder for formatted injection
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { startChatSession, injectTelegramWithContext } from '../chatSessionStarter';
import {
  getOrCreateConversation,
  addMessage,
} from './conversationManager';
import type { IncomingTelegramMessage } from './contextBuilder';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BotConfig {
  username: string;
  token: string;
  terminal: string;
  model: string;
  aliases?: string[];
}

interface BotsConfigFile {
  bots: Record<string, BotConfig>;
  defaults: {
    chat_session_suffix: string;
    work_session_suffix: string;
  };
  allowed_users: number[];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      username?: string;
      first_name?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    date: number;
  };
}

interface BotInstance {
  config: BotConfig;
  lastUpdateId: number;
  isRunning: boolean;
  pollInterval?: NodeJS.Timeout;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SPACEOS_ROOT = process.env.SPACEOS_ROOT || '/opt/spaceos';
const CONFIG_PATH = process.env.TELEGRAM_BOTS_CONFIG || `${SPACEOS_ROOT}/config/telegram-bots.yaml`;
const POLL_INTERVAL = 2000; // 2 seconds

// ─── State ───────────────────────────────────────────────────────────────────

const activeBots: Map<string, BotInstance> = new Map();
let configData: BotsConfigFile | null = null;

// ─── Config Loading ──────────────────────────────────────────────────────────

export function loadBotsConfig(): BotsConfigFile | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('[MultiBotManager] Config file not found:', CONFIG_PATH);
      return null;
    }

    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    configData = yaml.load(content) as BotsConfigFile;
    console.log(`[MultiBotManager] Loaded config with ${Object.keys(configData.bots).length} bots`);
    return configData;
  } catch (err) {
    console.error('[MultiBotManager] Failed to load config:', err);
    return null;
  }
}

// ─── Telegram API ────────────────────────────────────────────────────────────

async function getUpdates(token: string, offset: number): Promise<TelegramUpdate[]> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=1`
    );
    const data = await response.json() as { ok: boolean; result?: TelegramUpdate[] };

    if (data.ok && data.result) {
      return data.result;
    }
    return [];
  } catch (err) {
    console.error('[MultiBotManager] getUpdates error:', err);
    return [];
  }
}

async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId?: number
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    };

    if (replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean };
    return data.ok;
  } catch (err) {
    console.error('[MultiBotManager] sendMessage error:', err);
    return false;
  }
}

// ─── Session Management ──────────────────────────────────────────────────────

function sessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function injectToTmuxSession(sessionName: string, text: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    const safeText = text.replace(/\r?\n/g, ' ').replace(/'/g, "'\\''");
    const cmd = `tmux send-keys -t ${sessionName} -l '${safeText}' && sleep 0.5 && tmux send-keys -t ${sessionName} -H 0d`;
    execSync(cmd, { timeout: 15000 });
    return true;
  } catch (err) {
    console.error(`[MultiBotManager] Failed to inject into ${sessionName}:`, err);
    return false;
  }
}

// ─── Message Handler ─────────────────────────────────────────────────────────

async function handleMessage(bot: BotInstance, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.text) return;

  const userId = message.from.id;
  const username = message.from.username || message.from.first_name || 'User';
  const chatId = message.chat.id;
  const text = message.text;
  const messageId = message.message_id;

  // Check if user is allowed
  if (configData && !configData.allowed_users.includes(userId)) {
    console.log(`[MultiBotManager] Unauthorized user ${userId} (${username}) on ${bot.config.terminal}`);
    await sendMessage(bot.config.token, chatId, '❌ Nincs jogosultságod ehhez a bothoz.');
    return;
  }

  console.log(`[MultiBotManager] ${bot.config.terminal} received from @${username}: ${text.substring(0, 50)}...`);

  const terminal = bot.config.terminal;
  const chatSessionName = `spaceos-${terminal}-chat`;

  // ADR-060: Store incoming message in DB
  let conversationId: number;
  try {
    const conversation = getOrCreateConversation({
      chatId,
      userId,
      username,
      contextTerminal: terminal,
    });
    conversationId = conversation.id;

    // Save the incoming message
    addMessage({
      conversationId,
      telegramMessageId: messageId,
      direction: 'in',
      content: text,
    });

    console.log(`[MultiBotManager] Saved message to conversation ${conversationId}`);
  } catch (err) {
    console.error(`[MultiBotManager] Failed to save message to DB:`, err);
    // Continue anyway - injection can still work
    conversationId = 0;
  }

  // Start chat session if not running
  if (!sessionExists(chatSessionName)) {
    console.log(`[MultiBotManager] Starting chat session for ${terminal}...`);

    await sendMessage(bot.config.token, chatId, `⏳ Chat session indítása...`);

    const result = await startChatSession(terminal);
    if (!result.success) {
      await sendMessage(bot.config.token, chatId, `❌ Nem sikerült indítani: ${result.message}`);
      return;
    }

    // Wait for session to be ready
    await new Promise(resolve => setTimeout(resolve, 5000));
    await sendMessage(bot.config.token, chatId, `✅ ${terminal.toUpperCase()} chat session elindult!`);
  }

  // ADR-060: Inject with full conversation context
  const telegramMessage: IncomingTelegramMessage = {
    chatId,
    userId,
    username,
    text,
    messageId,
    conversationId,
    receivedByBot: bot.config.username,
  };

  const injected = await injectTelegramWithContext(terminal, telegramMessage);

  if (!injected) {
    await sendMessage(bot.config.token, chatId, `❌ Nem sikerült elküldeni a ${terminal} terminálnak.`);
  }
  // Note: Response will come from the terminal via MCP telegram_reply
}

// ─── Bot Polling ─────────────────────────────────────────────────────────────

async function pollBot(botName: string): Promise<void> {
  const bot = activeBots.get(botName);
  if (!bot || !bot.isRunning) return;

  try {
    const updates = await getUpdates(bot.config.token, bot.lastUpdateId + 1);

    for (const update of updates) {
      bot.lastUpdateId = update.update_id;
      await handleMessage(bot, update);
    }
  } catch (err) {
    console.error(`[MultiBotManager] Poll error for ${botName}:`, err);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a single bot
 */
export async function startBot(terminalName: string): Promise<{ success: boolean; message: string }> {
  if (!configData) {
    loadBotsConfig();
  }

  if (!configData || !configData.bots[terminalName]) {
    return { success: false, message: `Bot config not found for ${terminalName}` };
  }

  if (activeBots.has(terminalName) && activeBots.get(terminalName)!.isRunning) {
    return { success: true, message: `Bot ${terminalName} already running` };
  }

  const config = configData.bots[terminalName];
  const bot: BotInstance = {
    config,
    lastUpdateId: 0,
    isRunning: true,
  };

  // Get current update_id to avoid processing old messages
  const updates = await getUpdates(config.token, 0);
  if (updates.length > 0) {
    bot.lastUpdateId = updates[updates.length - 1].update_id;
  }

  // Start polling
  bot.pollInterval = setInterval(() => pollBot(terminalName), POLL_INTERVAL);
  activeBots.set(terminalName, bot);

  console.log(`[MultiBotManager] ✓ Started bot @${config.username} for ${terminalName}`);
  return { success: true, message: `Bot @${config.username} started` };
}

/**
 * Stop a single bot
 */
export function stopBot(terminalName: string): void {
  const bot = activeBots.get(terminalName);
  if (bot) {
    bot.isRunning = false;
    if (bot.pollInterval) {
      clearInterval(bot.pollInterval);
    }
    activeBots.delete(terminalName);
    console.log(`[MultiBotManager] Stopped bot for ${terminalName}`);
  }
}

/**
 * Start all configured bots
 */
export async function startAllBots(): Promise<void> {
  const config = loadBotsConfig();
  if (!config) {
    console.error('[MultiBotManager] No config loaded, cannot start bots');
    return;
  }

  console.log(`[MultiBotManager] Starting ${Object.keys(config.bots).length} bots...`);

  for (const terminalName of Object.keys(config.bots)) {
    const result = await startBot(terminalName);
    console.log(`[MultiBotManager] ${terminalName}: ${result.message}`);

    // Small delay between bot starts to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('[MultiBotManager] All bots started');
}

/**
 * Stop all bots
 */
export function stopAllBots(): void {
  for (const terminalName of activeBots.keys()) {
    stopBot(terminalName);
  }
  console.log('[MultiBotManager] All bots stopped');
}

/**
 * Get status of all bots
 */
export function getBotsStatus(): Record<string, { running: boolean; username: string; terminal: string }> {
  const status: Record<string, { running: boolean; username: string; terminal: string }> = {};

  if (configData) {
    for (const [name, config] of Object.entries(configData.bots)) {
      const bot = activeBots.get(name);
      status[name] = {
        running: bot?.isRunning || false,
        username: config.username,
        terminal: config.terminal,
      };
    }
  }

  return status;
}

/**
 * Send a message from a terminal's bot
 */
export async function sendFromTerminal(
  terminal: string,
  chatId: number,
  text: string
): Promise<boolean> {
  const bot = activeBots.get(terminal);
  if (!bot) {
    console.error(`[MultiBotManager] No active bot for ${terminal}`);
    return false;
  }

  return sendMessage(bot.config.token, chatId, text);
}
