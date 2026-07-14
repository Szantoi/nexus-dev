/**
 * Telegram Module - SpaceOS Agent Communication
 *
 * Provides free-form Telegram messaging for:
 * - User → Agent communication (task assignment, questions)
 * - Agent → User responses (via MCP tools)
 * - Agent → Agent broadcasts (inter-terminal messaging)
 */

// Intent parsing
export {
  parseIntent,
  resolveTerminal,
  formatTargets,
  getPriorityEmoji,
  isValidTerminal,
  type ParsedIntent,
  type Priority,
  type IntentType,
} from './intentParser';

// Conversation management
export {
  findActiveConversation,
  createConversation,
  getConversation,
  updateConversationContext,
  closeConversation,
  getOrCreateConversation,
  addMessage,
  getMessage,
  getConversationMessages,
  getLastIncomingMessageId,
  queueResponse,
  getQueueItem,
  getPendingResponses,
  markResponseSent,
  markResponseFailed,
  retryFailedResponses,
  getQueueStats,
  expireOldConversations,
  cleanupOldResponses,
  type Conversation,
  type ConversationMessage,
  type ResponseQueueItem,
  type ConversationStatus,
  type MessageDirection,
  type ResponseStatus,
} from './conversationManager';

// Telegram service
export {
  sendTelegramMessage,
  sendNotification,
  injectMessageToTerminal,
  injectTelegramMessageToTerminal,
  startResponseWorker,
  stopResponseWorker,
  sessionExists,
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  TERMINAL_SESSIONS,
} from './telegramService';
