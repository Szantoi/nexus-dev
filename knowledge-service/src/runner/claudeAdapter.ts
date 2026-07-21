/** Claude Code adapter using print mode and stream-json output. */

import {
  eventText,
  safeJson,
  type AdapterEvent,
  type CliAdapter,
  type LaunchContext,
  type ProcessLaunchSpec,
} from './cliAdapter';

export class ClaudeAdapter implements CliAdapter {
  readonly id = 'claude' as const;
  readonly versionArgs = ['--version'];
  readonly capabilities = {
    cliId: this.id,
    headlessSupported: true,
    structuredOutputFormats: ['stream-json'],
    supportsMaxTurns: true,
    supportsBudgetLimit: true,
    supportsToolAllowlist: true,
    requiresPty: false,
  };

  buildLaunchSpec(context: LaunchContext): ProcessLaunchSpec {
    const { providerConfig: config } = context;
    const permissionMode = config.sandbox === 'read-only' ? 'plan' : 'acceptEdits';
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      context.model,
      '--permission-mode',
      permissionMode,
    ];
    if (config.max_turns !== undefined) args.push('--max-turns', String(config.max_turns));
    if (config.max_budget_usd !== undefined) {
      args.push('--max-budget-usd', String(config.max_budget_usd));
    }
    args.push(...config.extra_args);
    return { command: config.binary, args, cwd: context.workdir, stdin: context.prompt };
  }

  parseEvent(line: string): AdapterEvent | null {
    const data = safeJson(line);
    if (!data) return { type: 'output', provider: this.id, text: line };
    const rawType = typeof data.type === 'string' ? data.type : 'unknown';
    let type: AdapterEvent['type'] = 'progress';
    if (rawType === 'system') type = 'started';
    else if (rawType === 'assistant') type = 'output';
    else if (rawType === 'result') type = data.is_error === true ? 'failed' : 'completed';
    else if (/tool/i.test(rawType)) type = 'tool';
    return { type, provider: this.id, rawType, text: eventText(data), data };
  }
}
