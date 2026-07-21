/**
 * Provider-neutral CLI contract used by the autonomous runner.
 *
 * Adapters only build shell-free process specifications and normalize output.
 * Ownership, retries and terminal concurrency remain runner responsibilities.
 */

import type { ProviderConfig } from './runnerConfig';

export const CLI_PROVIDERS = ['codex', 'claude', 'antigravity'] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];

export type AdapterEventType =
  | 'started'
  | 'progress'
  | 'tool'
  | 'output'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AdapterEvent {
  type: AdapterEventType;
  provider: CliProvider;
  rawType?: string;
  text?: string;
  data?: unknown;
}

export interface CliAdapterCapabilities {
  cliId: CliProvider;
  headlessSupported: boolean;
  structuredOutputFormats: string[];
  supportsMaxTurns: boolean;
  supportsBudgetLimit: boolean;
  supportsToolAllowlist: boolean;
  requiresPty: boolean;
}

export interface LaunchContext {
  workdir: string;
  additionalWriteDirs: string[];
  model: string;
  prompt: string;
  providerConfig: ProviderConfig;
}

export interface ProcessLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
}

export interface CliAdapter {
  readonly id: CliProvider;
  readonly versionArgs: string[];
  readonly capabilities: CliAdapterCapabilities;
  buildLaunchSpec(context: LaunchContext): ProcessLaunchSpec;
  parseEvent(line: string): AdapterEvent | null;
}

export function safeJson(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function eventText(value: Record<string, unknown>): string | undefined {
  for (const key of ['text', 'message', 'result', 'content']) {
    const candidate = value[key];
    if (typeof candidate === 'string') return candidate;
  }
  return undefined;
}
