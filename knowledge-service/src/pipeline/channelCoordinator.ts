/**
 * channelCoordinator.ts — Telegram Backfill Coordinator
 *
 * Inspired by Marveen: https://github.com/Szotasz/marveen
 *
 * Hybrid model for Telegram integration:
 * - Primary: Native datahaven-telegram bot handles messages
 * - Backfill: This coordinator polls when native is DOWN
 *
 * State machine: IDLE <-> BACKFILLING
 * - IDLE: Native is UP, coordinator does nothing
 * - BACKFILLING: Native is DOWN, coordinator polls Telegram API
 */

import { log, telegram, getState, setState } from './common';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CoordinatorState = 'idle' | 'backfilling';

export interface TelegramUpdate {
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
    date: number;
    text?: string;
  };
}

export interface CoordinatorConfig {
  enabled: boolean;
  tickMs: number;
  downDebounce: number;
  longPollTimeout: number;
  cooldownMs: number;
}

export interface IncomingEvent {
  update_id: number;
  kind: 'message' | 'command' | 'callback';
  chat_id: number;
  user_id: number;
  username: string | null;
  message_id: number;
  content: string;
  tg_date: number;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CoordinatorConfig = {
  enabled: process.env.ENABLE_TELEGRAM_COORDINATOR === 'true',
  tickMs: 5000,
  downDebounce: 2,
  longPollTimeout: 30,
  cooldownMs: 90000,
};

// ─── State ───────────────────────────────────────────────────────────────────

let state: CoordinatorState = 'idle';
let downStreak = 0;
let stopping = false;
let pollOffset = 0;
let nativeConfirmedUpUntil = 0;

// ─── Telegram API ────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Get updates from Telegram API
 */
async function getUpdates(offset: number, timeout: number, limit = 100): Promise<TelegramUpdate[]> {
  if (!TELEGRAM_TOKEN) {
    throw new Error('TELEGRAM_TOKEN not configured');
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`;
  const params = new URLSearchParams({
    offset: String(offset),
    timeout: String(timeout),
    limit: String(limit),
  });

  const response = await fetch(`${url}?${params}`, {
    method: 'GET',
    signal: AbortSignal.timeout((timeout + 5) * 1000),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 409) {
      throw new ConflictError('409 Conflict - native poller is active');
    }
    if (response.status === 401) {
      throw new FatalError('401 Unauthorized - invalid token');
    }
    throw new Error(`Telegram API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { ok: boolean; result?: TelegramUpdate[] };
  return data.result || [];
}

/**
 * Probe the current high water mark (latest update_id)
 */
async function probeHighWater(): Promise<number | null> {
  const updates = await getUpdates(0, 0, 1);
  if (updates.length === 0) return null;
  return updates[updates.length - 1].update_id;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

class ConflictError extends Error {
  readonly kind = 'conflict';
}

class FatalError extends Error {
  readonly kind = 'fatal';
}

// ─── Native Liveness Check ───────────────────────────────────────────────────

/**
 * Check if the native Telegram bot is running
 * Checks for datahaven-telegram process
 */
async function isNativeDown(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process');
    const result = execSync('pgrep -f "datahaven-telegram" 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return result.trim() === '';
  } catch {
    return true; // Assume down on error
  }
}

/**
 * Check if we're in the 409 cooldown period
 */
function inNative409Cooldown(): boolean {
  return Date.now() < nativeConfirmedUpUntil;
}

// ─── Message Processing ──────────────────────────────────────────────────────

/**
 * Map a Telegram update to an IncomingEvent
 */
function mapUpdate(update: TelegramUpdate): IncomingEvent | null {
  const msg = update.message;
  if (!msg) return null;

  const text = msg.text || '';
  const kind = text.startsWith('/') ? 'command' : 'message';

  return {
    update_id: update.update_id,
    kind,
    chat_id: msg.chat.id,
    user_id: msg.from.id,
    username: msg.from.username || null,
    message_id: msg.message_id,
    content: text,
    tg_date: msg.date,
  };
}

/**
 * Handle a batch of updates
 */
async function processBatch(updates: TelegramUpdate[]): Promise<number | null> {
  let maxUpdateId: number | null = null;

  for (const update of updates) {
    maxUpdateId = maxUpdateId === null ? update.update_id : Math.max(maxUpdateId, update.update_id);

    const event = mapUpdate(update);
    if (!event) continue;

    // Log the incoming message
    log(`[Coordinator] Backfilled: ${event.kind} from @${event.username || event.user_id} - "${event.content.slice(0, 50)}..."`);

    // Forward to the message router or handle directly
    // For now, just log and send acknowledgment
    if (event.kind === 'message' && event.content.trim()) {
      await telegram(`📬 Backfill received: "${event.content.slice(0, 100)}..." from @${event.username || event.user_id}`);
    }
  }

  return maxUpdateId;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

/**
 * Run the coordinator main loop
 */
async function runLoop(config: CoordinatorConfig): Promise<void> {
  while (!stopping) {
    try {
      if (state === 'idle') {
        // Check if native is down
        const down = await isNativeDown() && !inNative409Cooldown();
        downStreak = down ? downStreak + 1 : 0;

        if (downStreak >= config.downDebounce) {
          // Seed poll offset to current high water
          try {
            const hw = await probeHighWater();
            if (hw !== null) {
              pollOffset = hw;
              await setState('telegram_poll_offset', String(hw));
            }
            state = 'backfilling';
            log(`[Coordinator] Native DOWN, entering BACKFILLING (offset: ${pollOffset})`);
          } catch (err) {
            if (err instanceof ConflictError) {
              // 409 means native is actually up
              nativeConfirmedUpUntil = Date.now() + config.cooldownMs;
              downStreak = 0;
              log('[Coordinator] 409 on probe - native is polling, staying idle');
            } else {
              log(`[Coordinator] Probe failed: ${err}`);
            }
          }
        }

        await sleep(config.tickMs);
        continue;
      }

      // state === 'backfilling'
      // Check if native is back
      if (!(await isNativeDown())) {
        log('[Coordinator] Native back UP, yielding (-> idle)');
        state = 'idle';
        downStreak = 0;
        continue;
      }

      // Poll for updates
      try {
        const updates = await getUpdates(pollOffset + 1, config.longPollTimeout);

        if (updates.length === 0) continue;

        // Re-check native before processing
        if (!(await isNativeDown())) {
          log(`[Coordinator] Native recovered mid-batch, discarding ${updates.length} updates`);
          state = 'idle';
          downStreak = 0;
          continue;
        }

        const maxId = await processBatch(updates);
        if (maxId !== null) {
          pollOffset = maxId;
          await setState('telegram_poll_offset', String(maxId));
        }
      } catch (err) {
        if (err instanceof ConflictError) {
          nativeConfirmedUpUntil = Date.now() + config.cooldownMs;
          log('[Coordinator] 409 during backfill - native owns slot, yielding');
          state = 'idle';
          downStreak = 0;
        } else if (err instanceof FatalError) {
          log(`[Coordinator] FATAL: ${err.message}`);
          await telegram(`⚠️ Telegram Coordinator FATAL: ${err.message}`);
          stopping = true;
        } else {
          log(`[Coordinator] Error: ${err}`);
          await sleep(5000); // Backoff on transient errors
        }
      }
    } catch (err) {
      log(`[Coordinator] Loop error: ${err}`);
      await sleep(config.tickMs);
    }
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Scheduler ───────────────────────────────────────────────────────────────

let coordinatorRunning = false;

/**
 * Start the channel coordinator
 */
export function startChannelCoordinator(config: CoordinatorConfig = DEFAULT_CONFIG): void {
  if (!config.enabled) {
    console.log('[ChannelCoordinator] Disabled');
    return;
  }

  if (!TELEGRAM_TOKEN) {
    console.log('[ChannelCoordinator] No TELEGRAM_TOKEN configured, skipping');
    return;
  }

  if (coordinatorRunning) {
    console.log('[ChannelCoordinator] Already running');
    return;
  }

  coordinatorRunning = true;
  stopping = false;

  // Restore poll offset from state
  getState('telegram_poll_offset').then(offset => {
    if (offset) {
      pollOffset = parseInt(offset, 10) || 0;
      log(`[Coordinator] Restored poll offset: ${pollOffset}`);
    }
  });

  // Run in background
  runLoop(config).catch(err => {
    console.error('[ChannelCoordinator] Fatal error:', err);
    coordinatorRunning = false;
  });

  console.log('[ChannelCoordinator] Started (hybrid backfill mode)');
}

/**
 * Stop the channel coordinator
 */
export function stopChannelCoordinator(): void {
  if (coordinatorRunning) {
    stopping = true;
    coordinatorRunning = false;
    console.log('[ChannelCoordinator] Stopping...');
  }
}

/**
 * Get current coordinator state
 */
export function getCoordinatorState(): {
  state: CoordinatorState;
  running: boolean;
  pollOffset: number;
  downStreak: number;
} {
  return {
    state,
    running: coordinatorRunning,
    pollOffset,
    downStreak,
  };
}
