/**
 * sinkFactory — resolve the {@link TerminalSink} for a terminal from its
 * configured `mode`.
 *
 * Several terminals can share one headless sink, while each attached terminal
 * may own a persistent sink. The factory builds an immutable mixed-mode router
 * after resolving every configured terminal. Missing attached sinks fail
 * startup; they never silently degrade to headless.
 */

import type { RunnerConfig, TerminalRunnerConfig } from './runnerConfig';
import type { TerminalSink } from './terminalSink';
import { TerminalSinkRouter } from './terminalSinkRouter';

export type TerminalMode = TerminalRunnerConfig['mode'];

/**
 * Resolve the sink for one terminal by its mode.
 * @throws if the terminal requests `attached` mode without a registered sink.
 */
export function resolveTerminalSink(
  terminal: string,
  mode: TerminalMode,
  headlessSink: TerminalSink,
  attachedSinks: ReadonlyMap<string, TerminalSink> = new Map(),
): TerminalSink {
  switch (mode) {
    case 'headless':
      return headlessSink;
    case 'attached': {
      const attached = attachedSinks.get(terminal);
      if (!attached) {
        throw new Error(`AttachedSink unavailable for configured terminal '${terminal}'`);
      }
      return attached;
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown terminal mode for '${terminal}': ${String(exhaustive)}`);
    }
  }
}

/**
 * Preflight every configured terminal and return an immutable mixed-mode
 * router. Missing routes fail before readiness, backlog handling, or polling.
 */
export function selectRunnerSink(
  config: RunnerConfig,
  headlessSink: TerminalSink,
  attachedSinks: ReadonlyMap<string, TerminalSink> = new Map(),
): TerminalSink {
  const routes = new Map<string, TerminalSink>();
  for (const [terminal, entry] of Object.entries(config.terminals)) {
    routes.set(
      terminal,
      resolveTerminalSink(terminal, entry.mode, headlessSink, attachedSinks),
    );
  }
  return new TerminalSinkRouter(routes);
}
