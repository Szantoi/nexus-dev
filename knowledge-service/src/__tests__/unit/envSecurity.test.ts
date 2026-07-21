/**
 * config/env security + fail-closed tests (TASK-QC-006).
 *
 * Complements unit/configCentralization.test.ts (QC-007): that file pins the
 * schema semantics; THIS file pins
 *  - the module-load fail-fast path (invalid env => process.exit(1)),
 *  - the lazy `secrets` accessors (every getter, incl. fallback aliases),
 *  - getSpaceosMode and the CHROMADB_URL legacy alias.
 *
 * Hermetic: only process.env is touched, saved and restored per test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const TOUCHED = [
  'PORT',
  'CHROMA_URL',
  'CHROMADB_URL',
  'SPACEOS_MODE',
  'MCP_AUTH_TOKEN',
  'ADMIN_SECRET',
  'TERMINAL_TOKEN_SECRET',
  'DASHBOARD_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'VOYAGE_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_CHANNEL_ID',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CHANNEL_ID',
  'DATAHAVEN_TOKEN',
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of TOUCHED) saved[k] = process.env[k];

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

async function freshEnv() {
  vi.resetModules();
  return await import('../../config/env');
}

describe('module load fails fast on invalid configuration', () => {
  it('an invalid PORT terminates the process instead of starting misconfigured', async () => {
    process.env.PORT = 'not-a-port';
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.resetModules();
    await expect(import('../../config/env')).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The failure is reported per-variable before exiting.
    const printed = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('PORT');
  });
});

describe('legacy aliases and dynamic reads', () => {
  it('CHROMADB_URL legacy alias wins over CHROMA_URL', async () => {
    process.env.CHROMA_URL = 'http://primary:8001';
    process.env.CHROMADB_URL = 'http://legacy:8002';
    const cfg = await freshEnv();
    expect(cfg.CHROMA_EFFECTIVE_URL).toBe('http://legacy:8002');

    delete process.env.CHROMADB_URL;
    const cfg2 = await freshEnv();
    expect(cfg2.CHROMA_EFFECTIVE_URL).toBe('http://primary:8001');
  });

  it('getSpaceosMode observes runtime mutations (lazy read)', async () => {
    delete process.env.SPACEOS_MODE;
    const cfg = await freshEnv();
    expect(cfg.getSpaceosMode()).toBeUndefined();
    process.env.SPACEOS_MODE = 'autopilot';
    expect(cfg.getSpaceosMode()).toBe('autopilot');
  });
});

describe('secrets accessors (lazy, never cached)', () => {
  it('returns empty/undefined when nothing is configured, values at call time otherwise', async () => {
    for (const k of TOUCHED) delete process.env[k];
    const { secrets } = await freshEnv();

    // Fail-safe defaults when unset:
    expect(secrets.mcpAuthToken).toBe('');
    expect(secrets.adminSecret).toBeUndefined();
    expect(secrets.terminalTokenSecret).toBeUndefined();
    expect(secrets.anthropicApiKey).toBeUndefined();
    expect(secrets.voyageApiKey).toBeUndefined();
    expect(secrets.googleApiKey).toBeUndefined();
    expect(secrets.telegramBotToken).toBe('');
    expect(secrets.telegramChatId).toBe('');
    expect(secrets.slackBotToken).toBe('');
    expect(secrets.slackChannelId).toBe('');
    expect(secrets.discordBotToken).toBe('');
    expect(secrets.discordChannelId).toBe('');
    // Documented QC-003 legacy dev-token defaults (behavior-compat, pinned):
    expect(secrets.dashboardAuthToken).toBe('dev-token-spaceos-dashboard-2026');
    expect(secrets.datahavenToken).toBe('dev-token-spaceos-dashboard-2026');
    expect(secrets.telegramWebhookSecret).toBe('spaceos-webhook-secret-2026');

    // Values are read at call time (runtime reload support):
    process.env.MCP_AUTH_TOKEN = 'm';
    process.env.ADMIN_SECRET = 'a';
    process.env.TERMINAL_TOKEN_SECRET = 't';
    process.env.DASHBOARD_AUTH_TOKEN = 'd';
    process.env.ANTHROPIC_API_KEY = 'anthropic';
    process.env.VOYAGE_API_KEY = 'v';
    process.env.TELEGRAM_CHAT_ID = 'chat';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'hook';
    process.env.SLACK_BOT_TOKEN = 'sb';
    process.env.SLACK_CHANNEL_ID = 'sc';
    process.env.DISCORD_BOT_TOKEN = 'db';
    process.env.DISCORD_CHANNEL_ID = 'dc';
    process.env.DATAHAVEN_TOKEN = 'dh';
    expect(secrets.mcpAuthToken).toBe('m');
    expect(secrets.adminSecret).toBe('a');
    expect(secrets.terminalTokenSecret).toBe('t');
    expect(secrets.dashboardAuthToken).toBe('d');
    expect(secrets.anthropicApiKey).toBe('anthropic');
    expect(secrets.voyageApiKey).toBe('v');
    expect(secrets.telegramChatId).toBe('chat');
    expect(secrets.telegramWebhookSecret).toBe('hook');
    expect(secrets.slackBotToken).toBe('sb');
    expect(secrets.slackChannelId).toBe('sc');
    expect(secrets.discordBotToken).toBe('db');
    expect(secrets.discordChannelId).toBe('dc');
    expect(secrets.datahavenToken).toBe('dh');
  });

  it('honors documented fallback aliases (GEMINI_API_KEY, TELEGRAM_TOKEN)', async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.TELEGRAM_TOKEN = 'legacy-tg';
    const { secrets } = await freshEnv();
    expect(secrets.googleApiKey).toBe('gemini-key');
    expect(secrets.telegramBotToken).toBe('legacy-tg');

    // Primary names win over the aliases.
    process.env.GOOGLE_API_KEY = 'google-key';
    process.env.TELEGRAM_BOT_TOKEN = 'primary-tg';
    expect(secrets.googleApiKey).toBe('google-key');
    expect(secrets.telegramBotToken).toBe('primary-tg');
  });
});
