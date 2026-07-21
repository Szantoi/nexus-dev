/** Codex CLI adapter. Automation uses the documented `codex exec` JSONL API. */

import {
  eventText,
  safeJson,
  type AdapterEvent,
  type CliAdapter,
  type LaunchContext,
  type ProcessLaunchSpec,
} from './cliAdapter';

function classifyCodexEvent(rawType: string, data: Record<string, unknown>): AdapterEvent['type'] {
  if (rawType === 'thread.started') return 'started';
  if (rawType === 'turn.completed') return 'completed';
  if (rawType === 'turn.failed' || rawType === 'error') return 'failed';
  if (rawType.includes('cancel')) return 'cancelled';
  if (rawType.startsWith('turn.')) return 'progress';
  if (rawType.startsWith('item.')) {
    const item = data.item;
    if (item && typeof item === 'object') {
      const itemRecord = item as Record<string, unknown>;
      if (itemRecord.status === 'failed' || itemRecord.error) return 'failed';
      const itemType = itemRecord.type;
      if (typeof itemType === 'string' && /tool|command|mcp/i.test(itemType)) return 'tool';
    }
    return 'output';
  }
  return 'progress';
}

export class CodexAdapter implements CliAdapter {
  readonly id = 'codex' as const;
  readonly versionArgs = ['--version'];
  readonly capabilities = {
    cliId: this.id,
    headlessSupported: true,
    structuredOutputFormats: ['jsonl'],
    supportsMaxTurns: false,
    supportsBudgetLimit: false,
    supportsToolAllowlist: false,
    requiresPty: false,
  };

  buildLaunchSpec(context: LaunchContext): ProcessLaunchSpec {
    const { providerConfig: config } = context;
    const args = [
      'exec',
      '--json',
      '--color',
      'never',
      '--sandbox',
      config.sandbox,
      '--model',
      context.model,
      '--cd',
      context.workdir,
    ];

    if (config.ephemeral) args.push('--ephemeral');
    if (config.skip_git_repo_check) args.push('--skip-git-repo-check');
    for (const directory of context.additionalWriteDirs) args.push('--add-dir', directory);
    args.push(...config.extra_args, '-');

    return {
      command: config.binary,
      args,
      cwd: context.workdir,
      stdin: context.prompt,
    };
  }

  parseEvent(line: string): AdapterEvent | null {
    const data = safeJson(line);
    if (!data) return { type: 'output', provider: this.id, text: line };
    const rawType = typeof data.type === 'string' ? data.type : 'unknown';
    return {
      type: classifyCodexEvent(rawType, data),
      provider: this.id,
      rawType,
      text: eventText(data),
      data,
    };
  }
}
