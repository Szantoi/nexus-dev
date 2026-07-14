/**
 * channelProvider.ts — Multi-channel notification provider
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Unified interface for sending notifications across:
 * - Telegram (primary, existing)
 * - Slack (enterprise workspaces)
 * - Discord (community servers)
 *
 * Each provider handles:
 * - Message sending (text + optional photo)
 * - Token validation
 * - Message formatting (markdown → channel-native)
 * - Message splitting for length limits
 */

import { readFileSync, existsSync } from 'node:fs';
import { log } from './common';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChannelProviderType = 'telegram' | 'slack' | 'discord';

export interface ChannelProvider {
  readonly type: ChannelProviderType;
  readonly maxMessageLength: number;
  sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>;
  sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>;
  validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>;
  formatMessage(text: string): string;
  splitMessage(text: string): string[];
}

export interface ChannelConfig {
  type: ChannelProviderType;
  token: string;
  chatId: string;
  enabled: boolean;
}

// ─── Message Formatting Utilities ────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt === -1 || splitAt < limit * 0.3) {
      splitAt = remaining.lastIndexOf(' ', limit);
    }
    if (splitAt === -1 || splitAt < limit * 0.3) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Format markdown text for Telegram HTML mode
 */
function formatForTelegram(text: string): string {
  // Save code blocks to placeholders
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.trimEnd());
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Save inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // HTML escape text parts
  result = escapeHtml(result);

  // Markdown conversions
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/^- \[ \]/gm, '☐');
  result = result.replace(/^- \[x\]/gm, '☑');

  // Remove separators
  result = result.replace(/^---+$/gm, '');
  result = result.replace(/^\*\*\*+$/gm, '');

  // Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)]);

  return result.trim();
}

/**
 * Format markdown text for Slack mrkdwn
 */
function formatForSlack(text: string): string {
  let result = text;

  // Headings to bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '~$1~');
  // Links
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>');
  // Checkboxes
  result = result.replace(/^- \[ \]/gm, ':white_square: ');
  result = result.replace(/^- \[x\]/gm, ':white_check_mark: ');
  // Remove separators
  result = result.replace(/^---+$/gm, '');
  result = result.replace(/^\*\*\*+$/gm, '');

  return result.trim();
}

/**
 * Format markdown text for Discord (mostly native GFM)
 */
function formatForDiscord(text: string): string {
  let result = text;
  // Only convert task-list checkboxes (Discord doesn't support)
  result = result.replace(/^- \[ \]/gm, '☐');
  result = result.replace(/^- \[x\]/gm, '☑');
  return result;
}

// ─── Telegram Provider ───────────────────────────────────────────────────────

const TELEGRAM_MAX_LENGTH = 4096;

const telegramProvider: ChannelProvider = {
  type: 'telegram',
  maxMessageLength: TELEGRAM_MAX_LENGTH,

  async sendMessage(token, chatId, text, parseMode) {
    const payload: Record<string, string> = { chat_id: chatId, text };
    if (parseMode) payload.parse_mode = parseMode;

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API ${response.status}: ${body.slice(0, 200)}`);
    }
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    const fileData = readFileSync(photoPath);
    const boundary = '----FormBoundary' + Date.now();
    const parts: Buffer[] = [];

    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram sendPhoto ${response.status}: ${text.slice(0, 200)}`);
    }
  },

  async validateToken(token) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await response.json() as { ok: boolean; result?: { username: string } };
      if (data.ok && data.result) {
        return { ok: true, botName: data.result.username };
      }
      return { ok: false, error: 'Invalid bot token' };
    } catch {
      return { ok: false, error: 'Failed to connect to Telegram API' };
    }
  },

  formatMessage: formatForTelegram,
  splitMessage: (text) => splitMessage(text, TELEGRAM_MAX_LENGTH),
};

// ─── Slack Provider ──────────────────────────────────────────────────────────

const SLACK_MAX_LENGTH = 4000;

const slackProvider: ChannelProvider = {
  type: 'slack',
  maxMessageLength: SLACK_MAX_LENGTH,

  async sendMessage(token, chatId, text) {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: chatId,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Slack API HTTP ${response.status}`);
    }

    const data = await response.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    const fileData = readFileSync(photoPath);
    const filename = photoPath.split('/').pop() || 'image.png';

    // Get upload URL
    const urlResponse = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
      },
      body: `filename=${encodeURIComponent(filename)}&length=${fileData.length}`,
    });

    const urlData = await urlResponse.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      throw new Error(`Slack getUploadURL: ${urlData.error || 'unknown error'}`);
    }

    // Upload file
    await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileData,
    });

    // Complete upload
    const completeResponse = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: caption || filename }],
        channel_id: chatId,
        initial_comment: caption || undefined,
      }),
    });

    const completeData = await completeResponse.json() as { ok: boolean; error?: string };
    if (!completeData.ok) {
      throw new Error(`Slack completeUpload: ${completeData.error}`);
    }
  },

  async validateToken(token) {
    try {
      const response = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${token}`,
        },
      });
      const data = await response.json() as { ok: boolean; bot_id?: string; user?: string; error?: string };
      if (data.ok) {
        return { ok: true, botName: data.user || data.bot_id };
      }
      return { ok: false, error: data.error || 'Invalid token' };
    } catch {
      return { ok: false, error: 'Failed to connect to Slack API' };
    }
  },

  formatMessage: formatForSlack,
  splitMessage: (text) => splitMessage(text, SLACK_MAX_LENGTH),
};

// ─── Discord Provider ────────────────────────────────────────────────────────

const DISCORD_MAX_LENGTH = 2000;

const discordProvider: ChannelProvider = {
  type: 'discord',
  maxMessageLength: DISCORD_MAX_LENGTH,

  async sendMessage(token, chatId, text) {
    const response = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${token}`,
      },
      body: JSON.stringify({ content: text }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord API ${response.status}: ${body.slice(0, 200)}`);
    }
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    const fileData = readFileSync(photoPath);
    const filename = photoPath.split('/').pop() || 'image.png';
    const boundary = '----FormBoundary' + Date.now();

    const payloadJson = JSON.stringify({
      content: caption || undefined,
      attachments: [{ id: '0', filename }],
    });

    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payloadJson}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const response = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bot ${token}`,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord sendPhoto ${response.status}: ${text.slice(0, 200)}`);
    }
  },

  async validateToken(token) {
    try {
      const response = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { 'Authorization': `Bot ${token}` },
      });
      const data = await response.json() as { id?: string; username?: string };
      if (response.ok && data.username) {
        return { ok: true, botName: data.username };
      }
      return { ok: false, error: 'Invalid bot token' };
    } catch {
      return { ok: false, error: 'Failed to connect to Discord API' };
    }
  },

  formatMessage: formatForDiscord,
  splitMessage: (text) => splitMessage(text, DISCORD_MAX_LENGTH),
};

// ─── Provider Registry ───────────────────────────────────────────────────────

const providers: Record<ChannelProviderType, ChannelProvider> = {
  telegram: telegramProvider,
  slack: slackProvider,
  discord: discordProvider,
};

/**
 * Get a channel provider by type
 */
export function getProvider(type: ChannelProviderType): ChannelProvider {
  return providers[type];
}

/**
 * Get all available provider types
 */
export function getAvailableProviders(): ChannelProviderType[] {
  return ['telegram', 'slack', 'discord'];
}

// ─── Multi-Channel Notifier ──────────────────────────────────────────────────

export interface NotificationResult {
  channel: ChannelProviderType;
  success: boolean;
  error?: string;
}

/**
 * Configuration for multi-channel notifications
 */
export interface MultiChannelConfig {
  telegram?: { token: string; chatId: string; enabled: boolean };
  slack?: { token: string; chatId: string; enabled: boolean };
  discord?: { token: string; chatId: string; enabled: boolean };
}

let multiChannelConfig: MultiChannelConfig = {};

/**
 * Initialize multi-channel configuration from environment
 */
export function initMultiChannel(): void {
  multiChannelConfig = {
    telegram: {
      token: process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      enabled: !!(process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN) && !!process.env.TELEGRAM_CHAT_ID,
    },
    slack: {
      token: process.env.SLACK_BOT_TOKEN || '',
      chatId: process.env.SLACK_CHANNEL_ID || '',
      enabled: !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_CHANNEL_ID,
    },
    discord: {
      token: process.env.DISCORD_BOT_TOKEN || '',
      chatId: process.env.DISCORD_CHANNEL_ID || '',
      enabled: !!process.env.DISCORD_BOT_TOKEN && !!process.env.DISCORD_CHANNEL_ID,
    },
  };

  const enabled = getAvailableProviders().filter(p => multiChannelConfig[p]?.enabled);
  if (enabled.length > 0) {
    log(`[MultiChannel] Initialized: ${enabled.join(', ')}`);
  } else {
    log('[MultiChannel] No channels configured');
  }
}

/**
 * Get current multi-channel configuration status
 */
export function getMultiChannelStatus(): Record<ChannelProviderType, { enabled: boolean; configured: boolean }> {
  return {
    telegram: {
      enabled: multiChannelConfig.telegram?.enabled || false,
      configured: !!(multiChannelConfig.telegram?.token && multiChannelConfig.telegram?.chatId),
    },
    slack: {
      enabled: multiChannelConfig.slack?.enabled || false,
      configured: !!(multiChannelConfig.slack?.token && multiChannelConfig.slack?.chatId),
    },
    discord: {
      enabled: multiChannelConfig.discord?.enabled || false,
      configured: !!(multiChannelConfig.discord?.token && multiChannelConfig.discord?.chatId),
    },
  };
}

/**
 * Send notification to all enabled channels
 */
export async function notifyAllChannels(message: string): Promise<NotificationResult[]> {
  const results: NotificationResult[] = [];

  for (const providerType of getAvailableProviders()) {
    const config = multiChannelConfig[providerType];
    if (!config?.enabled) continue;

    const provider = getProvider(providerType);
    const formatted = provider.formatMessage(message);
    const chunks = provider.splitMessage(formatted);

    try {
      for (const chunk of chunks) {
        await provider.sendMessage(
          config.token,
          config.chatId,
          chunk,
          providerType === 'telegram' ? 'HTML' : undefined
        );
      }
      results.push({ channel: providerType, success: true });
      log(`[MultiChannel] Sent to ${providerType}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ channel: providerType, success: false, error });
      log(`[MultiChannel] Failed to send to ${providerType}: ${error}`);
    }
  }

  return results;
}

/**
 * Send notification to a specific channel
 */
export async function notifyChannel(
  providerType: ChannelProviderType,
  message: string
): Promise<NotificationResult> {
  const config = multiChannelConfig[providerType];
  if (!config?.enabled) {
    return { channel: providerType, success: false, error: 'Channel not enabled' };
  }

  const provider = getProvider(providerType);
  const formatted = provider.formatMessage(message);
  const chunks = provider.splitMessage(formatted);

  try {
    for (const chunk of chunks) {
      await provider.sendMessage(
        config.token,
        config.chatId,
        chunk,
        providerType === 'telegram' ? 'HTML' : undefined
      );
    }
    log(`[MultiChannel] Sent to ${providerType}`);
    return { channel: providerType, success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[MultiChannel] Failed to send to ${providerType}: ${error}`);
    return { channel: providerType, success: false, error };
  }
}

/**
 * Send photo to all enabled channels
 */
export async function sendPhotoAllChannels(
  photoPath: string,
  caption: string
): Promise<NotificationResult[]> {
  if (!existsSync(photoPath)) {
    return [{ channel: 'telegram', success: false, error: 'Photo file not found' }];
  }

  const results: NotificationResult[] = [];

  for (const providerType of getAvailableProviders()) {
    const config = multiChannelConfig[providerType];
    if (!config?.enabled) continue;

    const provider = getProvider(providerType);

    try {
      await provider.sendPhoto(config.token, config.chatId, photoPath, caption);
      results.push({ channel: providerType, success: true });
      log(`[MultiChannel] Sent photo to ${providerType}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ channel: providerType, success: false, error });
      log(`[MultiChannel] Failed to send photo to ${providerType}: ${error}`);
    }
  }

  return results;
}

/**
 * Validate all configured channel tokens
 */
export async function validateAllTokens(): Promise<Record<ChannelProviderType, { ok: boolean; botName?: string; error?: string }>> {
  const results: Record<string, { ok: boolean; botName?: string; error?: string }> = {};

  for (const providerType of getAvailableProviders()) {
    const config = multiChannelConfig[providerType];
    if (!config?.token) {
      results[providerType] = { ok: false, error: 'No token configured' };
      continue;
    }

    const provider = getProvider(providerType);
    results[providerType] = await provider.validateToken(config.token);
  }

  return results as Record<ChannelProviderType, { ok: boolean; botName?: string; error?: string }>;
}
