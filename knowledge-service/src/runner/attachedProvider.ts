/**
 * attachedProvider.ts — provider contract for attached (interactive PTY) mode.
 *
 * Builds the interactive spawn specification and the terminal policy
 * (readiness/idle classification + safe dispatch encoding) per provider.
 * Codex is the first supported interactive provider; Claude and Antigravity
 * are explicit fail-closed capability results until their interactive
 * contracts are proven (plan §9/D, §9/F).
 *
 * Security invariants:
 * - no shell strings: executable + argv only, mirrored from the headless path;
 * - the nudge is one short control-character-free line that references the
 *   mailbox task by id; untrusted task CONTENT is never written to the PTY;
 * - the child env receives the terminal credential exactly like headless
 *   sessions (auth_env_var <- credential_env), never a hardcoded token.
 */

import type { CliProvider } from './cliAdapter';
import type { AttachedTerminalPolicy } from './attachedSessionTypes';
import type { PtySpawnSpec } from './ptyHost';
import type { ProviderConfig, TerminalRunnerConfig } from './runnerConfig';
import type { LaunchRequest } from './sessionLauncher';
import {
  classifyTrackedPrompt,
  compilePromptPattern,
  TerminalScreenTracker,
} from './terminalScreen';
import { ConfigurationError, ValidationError } from '../core/errors';

const SAFE_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Conservative default prompt heuristics for Codex `--no-alt-screen` output.
 * The real PoC canary must confirm or override these per installed version
 * (config: terminals.<name>.attached.ready_pattern / idle_pattern).
 */
const CODEX_DEFAULT_PROMPT_PATTERN = String.raw`[>›❯]\s*$`;

export interface AttachedRuntimeDefaults {
  startup_timeout_ms: number;
  ready_confirm_samples: number;
  idle_settle_ms: number;
  idle_confirm_samples: number;
  completion_idle_timeout_ms: number;
  task_stall_timeout_ms: number;
  cols: number;
  rows: number;
}

export interface AttachedPolicyContext {
  provider: CliProvider;
  terminal: string;
  entry: TerminalRunnerConfig;
  providerConfig: ProviderConfig;
  defaults: AttachedRuntimeDefaults;
  expectedIslandId: string;
  mcpServerName: string;
  /** Injectable for tests; production uses process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

export class AttachedProviderUnsupportedError extends Error {
  readonly name = 'AttachedProviderUnsupportedError';

  constructor(provider: string, terminal: string) {
    super(
      `attached mode is not supported for provider '${provider}' (terminal '${terminal}'); ` +
        'interactive contract not proven — configure mode: headless or use a supported provider',
    );
  }
}

/** Providers with a proven interactive (attached) contract. */
export const ATTACHED_SUPPORTED_PROVIDERS: readonly CliProvider[] = ['codex'];

function buildChildEnv(
  context: AttachedPolicyContext,
): Readonly<Record<string, string | undefined>> {
  const source = context.env ?? process.env;
  const childEnv: Record<string, string | undefined> = { ...source };
  if (context.providerConfig.auth_env_var) {
    if (!context.entry.credential_env) {
      throw new ConfigurationError(
        `credential_env missing for attached terminal: ${context.terminal}`,
      );
    }
    const credential = source[context.entry.credential_env];
    if (!credential) {
      throw new ConfigurationError(
        `credential source unavailable for attached terminal ${context.terminal}: ${context.entry.credential_env}`,
      );
    }
    childEnv[context.providerConfig.auth_env_var] = credential;
  }
  return childEnv;
}

function buildCodexInteractiveArgs(context: AttachedPolicyContext): string[] {
  const config = context.providerConfig;
  // Interactive Codex session on the primary screen so prompt classification
  // works; flags are re-checked against `codex --help` at PoC time (plan §
  // platform baseline). No `exec` subcommand: this is the live TUI-less REPL.
  const args = [
    '--no-alt-screen',
    '--sandbox',
    config.sandbox,
    '--model',
    context.entry.default_model,
    '--cd',
    context.entry.workdir,
  ];
  args.push(...config.extra_args);
  return args;
}

export function buildInteractiveLaunchSpec(context: AttachedPolicyContext): PtySpawnSpec {
  if (context.provider !== 'codex') {
    throw new AttachedProviderUnsupportedError(context.provider, context.terminal);
  }
  return {
    executable: context.providerConfig.binary,
    args: buildCodexInteractiveArgs(context),
    cwd: context.entry.workdir,
    env: buildChildEnv(context),
    cols: context.defaults.cols,
    rows: context.defaults.rows,
  };
}

/**
 * Encode the poll-authorised dispatch as a short, single-line, sanitised
 * nudge. The message id is strictly validated; task content never flows here.
 */
export function encodeAttachedNudge(
  request: LaunchRequest,
  context: { sessionModel: string; mcpServerName: string },
): string {
  if (!SAFE_MESSAGE_ID.test(request.messageId)) {
    throw new ValidationError(`unsafe mailbox message id refused: ${JSON.stringify(request.messageId)}`, { messageId: 'invalid format' });
  }
  // A task without an explicit model runs on the session's model — that is
  // the default, not a downgrade. Only an EXPLICIT different model is refused:
  // a long-lived session cannot switch models mid-flight, and silently
  // honouring the request on another model would bypass the allowlist intent.
  if (request.model !== undefined && request.model !== context.sessionModel) {
    throw new ValidationError(
      `attached session runs model '${context.sessionModel}' but task requests '${request.model}'`,
      { model: 'must match session model' },
    );
  }
  const nudge =
    `Uj mailbox task: ${request.messageId}. ` +
    `Kerd le a(z) mcp__${context.mcpServerName}__fetch_task toollal (message_id: ${request.messageId}), ` +
    'hajtsd vegre, majd KIZAROLAG a complete_task toollal zard le.';
  // Defense in depth: the assembled line must stay control-character-free.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character guard IS the point
  if (/[\u0000-\u001f\u007f]/.test(nudge)) {
    throw new ValidationError('attached nudge assembly produced control characters', { nudge: 'contains control characters' });
  }
  return `${nudge}\r`;
}

/**
 * Build the full attached terminal policy for a provider. Fail-closed for
 * providers without a proven interactive contract.
 */
export function createAttachedTerminalPolicy(
  context: AttachedPolicyContext,
): AttachedTerminalPolicy {
  if (!ATTACHED_SUPPORTED_PROVIDERS.includes(context.provider)) {
    throw new AttachedProviderUnsupportedError(context.provider, context.terminal);
  }
  const readyPattern = compilePromptPattern(
    context.entry.attached?.ready_pattern ?? CODEX_DEFAULT_PROMPT_PATTERN,
    `terminal ${context.terminal} ready`,
  );
  const idlePattern = compilePromptPattern(
    context.entry.attached?.idle_pattern ?? CODEX_DEFAULT_PROMPT_PATTERN,
    `terminal ${context.terminal} idle`,
  );
  const spawn = buildInteractiveLaunchSpec(context);
  const tracker = new TerminalScreenTracker();
  const sessionModel = context.entry.default_model;
  const mcpServerName = context.mcpServerName;
  return {
    expectedIslandId: context.expectedIslandId,
    spawn,
    startupTimeoutMs: context.defaults.startup_timeout_ms,
    readyConfirmSamples: context.defaults.ready_confirm_samples,
    idleSettleMs: context.defaults.idle_settle_ms,
    idleConfirmSamples: context.defaults.idle_confirm_samples,
    onSessionStart: () => tracker.reset(),
    // The manager feeds every chunk exactly once (busy included), so an
    // alt-screen entered mid-task can never be missed by the classifiers.
    observeSample: (data) => tracker.observe(data),
    isReadySample: () => classifyTrackedPrompt(tracker, readyPattern),
    isIdleSample: () => classifyTrackedPrompt(tracker, idlePattern),
    encodeDispatch: (request) => encodeAttachedNudge(request, { sessionModel, mcpServerName }),
  };
}
