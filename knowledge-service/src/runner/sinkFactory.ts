/**
 * sinkFactory — resolve the {@link TerminalSink} for a terminal from its
 * configured `mode`.
 *
 * Several terminals can share one headless sink, while each attached terminal
 * may own a persistent sink. The factory builds an immutable mixed-mode router
 * after resolving every configured terminal. Missing attached sinks fail
 * startup; they never silently degrade to headless.
 */

import * as path from 'node:path';
import { createAttachedTerminalPolicy } from './attachedProvider';
import { AttachedSessionManager } from './attachedSessionManager';
import type { AttachedTerminalPolicy } from './attachedSessionTypes';
import {
  FileAttachedTaskMarkerStore,
  type AttachedTaskMarkerStore,
} from './attachedTaskMarkerStore';
import { NodePtyHost, type PtyHost } from './ptyHost';
import type { RunnerConfig, TerminalRunnerConfig } from './runnerConfig';
import type { TerminalSink } from './terminalSink';
import { TerminalSinkRouter } from './terminalSinkRouter';

export type TerminalMode = TerminalRunnerConfig['mode'];

export interface AttachedAssembly {
  /** Route table entries for every attached terminal (one shared manager). */
  sinks: ReadonlyMap<string, TerminalSink>;
  manager?: AttachedSessionManager;
  terminals: readonly string[];
}

export interface AttachedAssemblyDeps {
  /** Test seams; production uses NodePtyHost and the durable file store. */
  createPtyHost?: () => PtyHost;
  createMarkerStore?: (directory: string) => AttachedTaskMarkerStore;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Build the attached runtime for every `mode: attached` terminal: one shared
 * PTY host + durable marker store + session manager. Fails closed at startup
 * for unsupported providers or missing credentials — never a silent headless
 * downgrade.
 */
export function buildAttachedAssembly(
  config: RunnerConfig,
  deps: AttachedAssemblyDeps = {},
): AttachedAssembly {
  const attachedEntries = Object.entries(config.terminals).filter(
    ([, entry]) => entry.mode === 'attached',
  );
  if (attachedEntries.length === 0) return { sinks: new Map(), terminals: [] };
  const expectedIslandId = config.expected_island_id;
  if (!expectedIslandId) {
    // The config schema already enforces this; keep the assembly fail-closed
    // for direct callers too.
    throw new Error('expected_island_id is required when attached terminals are configured');
  }
  const policies = new Map<string, AttachedTerminalPolicy>();
  for (const [terminal, entry] of attachedEntries) {
    const provider = entry.provider ?? config.default_provider;
    const providerConfig = config.providers[provider];
    if (!providerConfig) {
      throw new Error(`provider ${provider} is not configured for attached terminal '${terminal}'`);
    }
    policies.set(
      terminal,
      createAttachedTerminalPolicy({
        provider,
        terminal,
        entry,
        providerConfig,
        defaults: config.attached_defaults,
        expectedIslandId,
        mcpServerName: config.mcp_server_name,
        env: deps.env,
      }),
    );
  }
  const markerDirectory = path.join(config.log_dir, 'attached-markers');
  const ptyHost = deps.createPtyHost?.() ?? new NodePtyHost();
  const markers =
    deps.createMarkerStore?.(markerDirectory) ?? new FileAttachedTaskMarkerStore(markerDirectory);
  const manager = new AttachedSessionManager(policies, ptyHost, markers);
  return {
    sinks: new Map(attachedEntries.map(([terminal]) => [terminal, manager])),
    manager,
    terminals: attachedEntries.map(([terminal]) => terminal),
  };
}

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
