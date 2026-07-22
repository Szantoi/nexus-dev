/**
 * sinkFactory — resolve the {@link TerminalSink} for a terminal from its
 * configured `mode`.
 *
 * Because a single {@link SessionLauncher} supervises every terminal today, the
 * factory does not build a sink per terminal; it takes the shared headless sink
 * and validates each terminal's mode against it. `headless` returns that sink;
 * `attached` throws until step 3 (node-pty) lands. The throw is deliberate:
 * config validation *accepts* `attached` (so operators can prepare their YAML),
 * but the runner must fail loudly at launch rather than silently degrade an
 * attached terminal to headless.
 */

import type { RunnerConfig, TerminalRunnerConfig } from './runnerConfig';
import type { TerminalSink } from './terminalSink';

export type TerminalMode = TerminalRunnerConfig['mode'];

/**
 * Resolve the sink for one terminal by its mode.
 * @throws if the terminal requests the not-yet-implemented `attached` mode.
 */
export function resolveTerminalSink(
  terminal: string,
  mode: TerminalMode,
  headlessSink: TerminalSink,
): TerminalSink {
  switch (mode) {
    case 'headless':
      return headlessSink;
    case 'attached':
      throw new Error(`AttachedSink not implemented yet (step 3): terminal '${terminal}'`);
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown terminal mode for '${terminal}': ${String(exhaustive)}`);
    }
  }
}

/**
 * Preflight every configured terminal and return the sink used for dispatch.
 * Throws on the first `attached` terminal so main() fails closed like the
 * CLI-discovery preflight, before any polling starts.
 */
export function selectRunnerSink(config: RunnerConfig, headlessSink: TerminalSink): TerminalSink {
  for (const [terminal, entry] of Object.entries(config.terminals)) {
    resolveTerminalSink(terminal, entry.mode, headlessSink);
  }
  return headlessSink;
}
