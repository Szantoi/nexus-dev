/**
 * Routes already-authorised launch requests to the sink configured for their
 * terminal. The poll loop remains the only launch authority; this class only
 * selects an execution boundary and aggregates runner-wide lifecycle calls.
 */

import type { LaunchRequest, LaunchResult } from './sessionLauncher';
import type { TerminalSink } from './terminalSink';

const UNKNOWN_TERMINAL_REASON = 'terminal sink not configured';
const MAX_LIFECYCLE_CAUSES = 3;
const MAX_LIFECYCLE_CAUSE_LENGTH = 200;

function lifecycleErrorSummary(errors: readonly unknown[]): string {
  const causes = errors.slice(0, MAX_LIFECYCLE_CAUSES).map((error) => {
    const text = (error instanceof Error ? error.message : String(error))
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
    return text.length > MAX_LIFECYCLE_CAUSE_LENGTH
      ? `${text.slice(0, MAX_LIFECYCLE_CAUSE_LENGTH - 1)}…`
      : text;
  });
  const omitted = errors.length - causes.length;
  return `${causes.join(' | ')}${omitted > 0 ? ` | +${omitted} more` : ''}`;
}

export class TerminalSinkLifecycleError extends Error {
  readonly name = 'TerminalSinkLifecycleError';

  constructor(
    message: string,
    readonly errors: readonly unknown[],
  ) {
    // The top-level runner logger prints Error.message only. Preserve a
    // bounded, single-line cause summary there so cleanup failures remain
    // actionable without dumping stacks or arbitrary error objects.
    super(`${message}: ${lifecycleErrorSummary(errors)}`);
  }
}

/**
 * A mixed-mode sink composed from terminal-scoped routes.
 *
 * Several terminals may share one headless sink, while attached terminals can
 * each own a distinct sink. Runner-wide operations therefore iterate unique
 * sink instances so a shared sink is never cancelled, counted, or prepared
 * more than once.
 */
export class TerminalSinkRouter implements TerminalSink {
  private readonly sinksByTerminal: ReadonlyMap<string, TerminalSink>;
  private readonly uniqueSinks: readonly TerminalSink[];

  constructor(routes: ReadonlyMap<string, TerminalSink>) {
    // Copy the caller-owned map so later external mutations cannot change the
    // routing table after startup preflight has completed.
    this.sinksByTerminal = new Map(routes);
    this.uniqueSinks = [...new Set(this.sinksByTerminal.values())];
  }

  dispatch(req: LaunchRequest): LaunchResult {
    const sink = this.sinksByTerminal.get(req.terminal);
    if (!sink) {
      return {
        started: false,
        reason: `${UNKNOWN_TERMINAL_REASON}: ${req.terminal}`,
      };
    }
    return sink.dispatch(req);
  }

  isBusy(terminal: string): boolean {
    const sink = this.sinksByTerminal.get(terminal);
    // Unknown terminals are treated as permanently busy so polling cannot
    // claim work that has no configured execution boundary.
    return sink ? sink.isBusy(terminal) : true;
  }

  cancel(terminal: string, reason?: string): boolean {
    const sink = this.sinksByTerminal.get(terminal);
    return sink ? sink.cancel(terminal, reason) : false;
  }

  cancelAll(reason?: string): number {
    return this.uniqueSinks.reduce((count, sink) => count + sink.cancelAll(reason), 0);
  }

  activeCount(): number {
    return this.uniqueSinks.reduce((count, sink) => count + sink.activeCount(), 0);
  }

  minimumShutdownGraceMs(): number {
    return this.uniqueSinks.reduce(
      (required, sink) => Math.max(required, sink.minimumShutdownGraceMs?.() ?? 0),
      0,
    );
  }

  async ensureReady(): Promise<void> {
    const prepared: TerminalSink[] = [];
    for (const sink of this.uniqueSinks) {
      try {
        await sink.ensureReady?.();
        prepared.push(sink);
      } catch (error) {
        // The failing sink may have allocated resources before rejecting.
        // Roll it back as well as every earlier sink, once each.
        const rollback = await Promise.allSettled(
          [sink, ...prepared.reverse()].map(async (startedSink) => {
            if (startedSink.shutdown) await startedSink.shutdown('preflight-rollback');
            else startedSink.cancelAll('preflight-rollback');
          }),
        );
        const cleanupErrors = rollback.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (cleanupErrors.length > 0) {
          throw new TerminalSinkLifecycleError(
            'terminal sink preflight and rollback cleanup failed',
            [error, ...cleanupErrors],
          );
        }
        throw error;
      }
    }
  }

  async shutdown(reason = 'runner-shutdown'): Promise<void> {
    const results = await Promise.allSettled(
      this.uniqueSinks.map(async (sink) => {
        if (sink.shutdown) await sink.shutdown(reason);
        else sink.cancelAll(reason);
      }),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new TerminalSinkLifecycleError(
        `terminal sink shutdown failed for ${errors.length} sink(s)`,
        errors,
      );
    }
  }
}
