/** Closed registry of supported CLI adapters. */

import { AntigravityAdapter } from './antigravityAdapter';
import { ClaudeAdapter } from './claudeAdapter';
import type { CliAdapter, CliProvider } from './cliAdapter';
import { CodexAdapter } from './codexAdapter';

const adapters: Readonly<Record<CliProvider, CliAdapter>> = {
  codex: new CodexAdapter(),
  claude: new ClaudeAdapter(),
  antigravity: new AntigravityAdapter(),
};

export function getCliAdapter(provider: CliProvider): CliAdapter {
  return adapters[provider];
}

export function listCliAdapters(): CliAdapter[] {
  return Object.values(adapters);
}
