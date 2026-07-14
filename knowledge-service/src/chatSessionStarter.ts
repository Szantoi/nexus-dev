/**
 * Chat Session Starter - ADR-060 CLI-Agnostic Telegram Architecture
 *
 * Starts Haiku-powered chat sessions for Telegram interactions.
 * Session naming: spaceos-{terminal}-chat (e.g., spaceos-backend-chat)
 *
 * ADR-060 changes:
 * - Uses CLAUDE-CHAT.md for chat session identity (separate from work session)
 * - Injects full conversation context (in + out messages)
 * - CLI-agnostic design (works with any CLI that reads stdin)
 *
 * Responsibilities:
 * - Telegram message responses
 * - Status reports
 * - Quick coordination
 * - Work session spawning via MCP
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as terminalsConfig from './config/terminals';
import { MemoryStore } from './memoryStore';
import { buildContextFromConversation, IncomingTelegramMessage } from './telegram/contextBuilder';

const execAsync = promisify(exec);

const TMUX_SOCKET = terminalsConfig.getTmuxSocket();
const TERMINALS_DIR = terminalsConfig.getTerminalsRoot();

// ─── Session State Detection ──────────────────────────────────────────────────

/**
 * Check if a chat session is running
 */
async function isChatSessionRunning(terminal: string): Promise<boolean> {
  const sessionName = `spaceos-${terminal}-chat`;

  // Try configured socket
  try {
    await execAsync(`tmux -S ${TMUX_SOCKET} has-session -t ${sessionName}`);
    return true;
  } catch {
    // Fall through to default socket
  }

  // Fallback: try default tmux socket
  try {
    await execAsync(`tmux has-session -t ${sessionName}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send keys to a chat session (both sockets)
 */
function tmuxSendKeys(sessionName: string, keys: string, literal: boolean = false): void {
  const safeKeys = keys.replace(/'/g, "'\\''");

  // Special handling for Enter key - use hex code
  const isEnter = keys === 'Enter';
  const cmdSuffix = isEnter
    ? '-H 0d'
    : literal
      ? `-l '${safeKeys}'`
      : keys;

  // First try configured socket
  try {
    execSync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} ${cmdSuffix}`, { timeout: 5000 });
    return;
  } catch {
    // Fall through to default socket
  }

  // Fallback: try default socket
  execSync(`tmux send-keys -t ${sessionName} ${cmdSuffix}`, { timeout: 5000 });
}

// ─── Chat Session Prompt Builder ──────────────────────────────────────────────

/**
 * Build the initialization prompt for a chat session
 *
 * ADR-060: Uses CLAUDE-CHAT.md for identity instead of hardcoded prompt.
 * Falls back to basic prompt if CLAUDE-CHAT.md doesn't exist.
 */
async function buildChatSessionPrompt(terminal: string): Promise<string> {
  const terminalDir = path.join(TERMINALS_DIR, terminal);
  const chatMdPath = path.join(terminalDir, 'CLAUDE-CHAT.md');

  try {
    // Check if CLAUDE-CHAT.md exists
    await fs.access(chatMdPath);
    // If it exists, just reference it - Claude will read it automatically
    return `Olvasd el: CLAUDE-CHAT.md (chat session identity)

Ez egy Telegram CHAT session. A CLAUDE-CHAT.md-ben van minden instrukció.
Session típus: CHAT (Haiku, gyors válaszok)
Terminál: ${terminal}`;
  } catch {
    // Fallback: CLAUDE-CHAT.md doesn't exist, use hardcoded prompt
    console.warn(`[ChatSessionStarter] CLAUDE-CHAT.md not found for ${terminal}, using fallback prompt`);

    return `Te a ${terminal.toUpperCase()} terminál CHAT session-je vagy.

FONTOS - TELEGRAM VÁLASZ:
Ha [TG @user conv:ID] formátumú üzenetet kapsz, MINDIG használd az MCP telegram_reply tool-t a válaszhoz!
MINDIG add meg a from_terminal paramétert: "${terminal}"
Példa: mcp__spaceos-knowledge__telegram_reply(chat_id: ID, message: "válasz", from_terminal: "${terminal}")
NE írj a konzolra, CSAK az MCP tool-lal válaszolj!

FELADATAID:
1. Telegram üzenetek megválaszolása (gyors válaszok, státusz)
2. Egyszerű kérdések megválaszolása
3. Ha ÖSSZETETT feladat érkezik (kód írás, fájl módosítás, hosszú munka):
   → Használd: mcp__spaceos-knowledge__request_work_session
   → Tájékoztasd: "A kérést átadtam a work session-nek."

Session típus: CHAT (Haiku, gyors válaszok)
Te NEM írsz kódot - csak koordinálsz és válaszolsz!`;
  }
}

// ─── Chat Session Starter ─────────────────────────────────────────────────────

/**
 * Start a chat session for a terminal
 *
 * @param terminal - Terminal name (e.g., 'backend', 'conductor')
 * @returns Promise with success status and message
 */
export async function startChatSession(
  terminal: string
): Promise<{ success: boolean; message: string }> {
  // SECURITY: Validate terminal name
  if (!terminalsConfig.getTerminal(terminal)) {
    console.error(`[ChatSessionStarter] SECURITY: Invalid terminal name: ${terminal}`);
    return {
      success: false,
      message: `Invalid terminal name: ${terminal}`,
    };
  }

  const sessionName = `spaceos-${terminal}-chat`;
  const workdir = path.join(TERMINALS_DIR, terminal);

  // Check if already running
  if (await isChatSessionRunning(terminal)) {
    console.log(`[ChatSessionStarter] ${sessionName} already running`);
    return {
      success: true,
      message: `Chat session ${sessionName} already running`,
    };
  }

  console.log(`[ChatSessionStarter] Starting chat session: ${sessionName} (Haiku, continuous)`);

  try {
    // 1. Create tmux session
    await execAsync(`tmux -S ${TMUX_SOCKET} new-session -d -s ${sessionName} -c "${workdir}"`);
    console.log(`[ChatSessionStarter] ✓ Created tmux session ${sessionName}`);

    // Wait for session to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. Load recent chat memories from MemoryStore AND Telegram conversation history
    let chatMemoryContext = '';

    // 2a. Load from MemoryStore (tiered memory)
    try {
      const memStore = new MemoryStore(terminal);
      const recentChat = memStore.read('chat', 10); // Last 10 chat entries
      memStore.close();

      if (recentChat.length > 0) {
        chatMemoryContext = '\n\n## Legutóbbi Chat Memóriák\n\n';
        for (const entry of recentChat.reverse()) {
          chatMemoryContext += `**${entry.timestamp}** (${entry.author}): ${entry.content}\n\n`;
        }
      }
    } catch (err) {
      console.warn(`[ChatSessionStarter] Failed to load chat memories:`, err);
    }

    // 2b. Load from Telegram conversation history (telegram.db)
    try {
      const { getRecentMessagesForTerminal } = await import('./telegram/conversationManager');
      const telegramHistory = getRecentMessagesForTerminal(terminal, 15);

      if (telegramHistory.length > 0) {
        chatMemoryContext += '\n\n## Legutóbbi Telegram Beszélgetés\n\n';
        for (const msg of telegramHistory) {
          const direction = msg.direction === 'in' ? '👤 User' : `🤖 ${terminal}`;
          chatMemoryContext += `**${msg.createdAt}** (${direction}): ${msg.content.slice(0, 300)}${msg.content.length > 300 ? '...' : ''}\n\n`;
        }
      }
    } catch (err) {
      console.warn(`[ChatSessionStarter] Failed to load Telegram history:`, err);
    }

    // 3. Send claude command with Haiku model
    await execAsync(`tmux -S ${TMUX_SOCKET} send-keys -t ${sessionName} "claude --model haiku" Enter`);
    console.log(`[ChatSessionStarter] ✓ Started claude with Haiku model`);

    // Wait for claude to initialize
    await new Promise(resolve => setTimeout(resolve, 10000));

    // 4. Build and inject initialization prompt
    const initPrompt = await buildChatSessionPrompt(terminal) + chatMemoryContext;

    // Send prompt in chunks (Marveen pattern)
    const CHUNK_SIZE = 80;
    const oneLine = initPrompt.replace(/\r?\n/g, ' ');
    for (let i = 0; i < oneLine.length; i += CHUNK_SIZE) {
      const chunk = oneLine.slice(i, i + CHUNK_SIZE);
      tmuxSendKeys(sessionName, chunk, true);
      execSync('sleep 0.03'); // Avoid paste detection
    }

    // Send Enter to submit
    tmuxSendKeys(sessionName, 'Enter');
    console.log(`[ChatSessionStarter] ✓ Injected initialization prompt`);

    // 5. Wait for response
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`[ChatSessionStarter] ✓ Chat session ${sessionName} ready`);

    return {
      success: true,
      message: `Chat session ${sessionName} started successfully`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[ChatSessionStarter] Failed to start ${sessionName}:`, msg);
    return {
      success: false,
      message: `Failed to start chat session: ${msg}`,
    };
  }
}

/**
 * Inject a message into a running chat session
 *
 * @param terminal - Terminal name
 * @param message - Message to inject
 * @returns Success status
 */
export async function injectToChatSession(
  terminal: string,
  message: string
): Promise<boolean> {
  const sessionName = `spaceos-${terminal}-chat`;

  // Check if session is running
  if (!await isChatSessionRunning(terminal)) {
    console.error(`[ChatSessionStarter] Session ${sessionName} not running`);
    return false;
  }

  try {
    console.log(`[ChatSessionStarter] Injecting message to ${sessionName}: ${message.slice(0, 50)}...`);

    // Clear input buffer first
    tmuxSendKeys(sessionName, 'Escape');
    execSync('sleep 0.1');
    tmuxSendKeys(sessionName, 'C-u');
    execSync('sleep 0.1');

    // Send message in chunks
    const CHUNK_SIZE = 80;
    const oneLine = message.replace(/\r?\n/g, ' ');
    for (let i = 0; i < oneLine.length; i += CHUNK_SIZE) {
      const chunk = oneLine.slice(i, i + CHUNK_SIZE);
      tmuxSendKeys(sessionName, chunk, true);
      execSync('sleep 0.03');
    }

    // Submit with Enter
    tmuxSendKeys(sessionName, 'Enter');

    console.log(`[ChatSessionStarter] ✓ Message injected to ${sessionName}`);
    return true;
  } catch (error) {
    console.error(`[ChatSessionStarter] Failed to inject to ${sessionName}:`, error);
    return false;
  }
}

/**
 * Inject a Telegram message with full conversation context
 *
 * ADR-060: This is the main entry point for Telegram message injection.
 * It fetches conversation history and builds a formatted context.
 *
 * @param terminal - Terminal name
 * @param telegramMessage - Incoming Telegram message with conversation ID
 * @returns Success status
 */
export async function injectTelegramWithContext(
  terminal: string,
  telegramMessage: IncomingTelegramMessage
): Promise<boolean> {
  const sessionName = `spaceos-${terminal}-chat`;

  // Check if session is running
  if (!await isChatSessionRunning(terminal)) {
    // Try to start the session
    console.log(`[ChatSessionStarter] ${sessionName} not running, starting...`);
    const result = await startChatSession(terminal);
    if (!result.success) {
      console.error(`[ChatSessionStarter] Failed to start ${sessionName}: ${result.message}`);
      return false;
    }
    // Wait for session to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  try {
    // Build context with conversation history
    const context = buildContextFromConversation(telegramMessage, {
      maxHistory: 10,
      includeTimestamps: true,
      language: 'hu',
    });

    console.log(`[ChatSessionStarter] Injecting Telegram message with context to ${sessionName}`);
    console.log(`[ChatSessionStarter] Context length: ${context.length} chars`);

    // Clear input buffer first
    tmuxSendKeys(sessionName, 'Escape');
    execSync('sleep 0.1');
    tmuxSendKeys(sessionName, 'C-u');
    execSync('sleep 0.1');

    // Send context in chunks
    const CHUNK_SIZE = 80;
    const oneLine = context.replace(/\r?\n/g, ' ');
    for (let i = 0; i < oneLine.length; i += CHUNK_SIZE) {
      const chunk = oneLine.slice(i, i + CHUNK_SIZE);
      tmuxSendKeys(sessionName, chunk, true);
      execSync('sleep 0.03');
    }

    // Submit with Enter
    tmuxSendKeys(sessionName, 'Enter');

    console.log(`[ChatSessionStarter] ✓ Telegram message injected with context to ${sessionName}`);
    return true;
  } catch (error) {
    console.error(`[ChatSessionStarter] Failed to inject Telegram message to ${sessionName}:`, error);
    return false;
  }
}

/**
 * Get the session name for a chat session
 */
export function getChatSessionName(terminal: string): string {
  return `spaceos-${terminal}-chat`;
}
