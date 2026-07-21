/**
 * Antigravity CLI adapter.
 *
 * The public CLI currently documents headless `agy -p`, but not a structured
 * event stream. Output is therefore normalized as text and capability
 * discovery must be used before enabling it on a host.
 */

import type {
  AdapterEvent,
  CliAdapter,
  LaunchContext,
  ProcessLaunchSpec,
} from './cliAdapter';

export class AntigravityAdapter implements CliAdapter {
  readonly id = 'antigravity' as const;
  readonly versionArgs = ['--version'];
  readonly capabilities = {
    cliId: this.id,
    headlessSupported: true,
    structuredOutputFormats: [],
    supportsMaxTurns: false,
    supportsBudgetLimit: false,
    supportsToolAllowlist: false,
    requiresPty: false,
  };

  buildLaunchSpec(context: LaunchContext): ProcessLaunchSpec {
    return {
      command: context.providerConfig.binary,
      args: ['-p', '--model', context.model, ...context.providerConfig.extra_args],
      cwd: context.workdir,
      stdin: context.prompt,
    };
  }

  parseEvent(line: string): AdapterEvent | null {
    return line ? { type: 'output', provider: this.id, text: line } : null;
  }
}
