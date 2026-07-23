import type { TerminalSink } from './terminalSink';

const MAX_LIFECYCLE_DETAIL_LENGTH = 500;

function boundedLifecycleDetail(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return text.length > MAX_LIFECYCLE_DETAIL_LENGTH
    ? `${text.slice(0, MAX_LIFECYCLE_DETAIL_LENGTH - 1)}…`
    : text;
}

export interface DrainableRunnerIngress {
  stopAndDrain(): Promise<void>;
}

export interface StoppableRunnerListener {
  stop(): void;
}

export class RunnerIngressStopError extends Error {
  readonly name = 'RunnerIngressStopError';

  constructor(readonly errors: readonly Error[]) {
    const shown = errors.slice(0, 3);
    super(
      `runner ingress cleanup failed: ${shown
        .map((error) => boundedLifecycleDetail(error).slice(0, 200))
        .join(' | ')}${errors.length > shown.length ? ` | +${errors.length - shown.length} more` : ''}`,
    );
  }
}

/** Abort the poll gate first, then stop every wake source and await the drain. */
export async function stopRunnerIngress(
  loop: DrainableRunnerIngress,
  listeners: readonly StoppableRunnerListener[],
): Promise<void> {
  let drain: Promise<void>;
  try {
    // stopAndDrain flips its AbortSignal synchronously before returning.
    drain = loop.stopAndDrain();
  } catch (error) {
    drain = Promise.reject(error);
  }
  const errors: Error[] = [];
  for (const listener of listeners) {
    try {
      listener.stop();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  const drainResult = await Promise.allSettled([drain]);
  if (drainResult[0].status === 'rejected') {
    const reason = drainResult[0].reason;
    errors.push(reason instanceof Error ? reason : new Error(String(reason)));
  }
  if (errors.length > 0) throw new RunnerIngressStopError(errors);
}

export interface RunnerLifecycleLogger {
  info(message: string): void;
  error(message: string, detail?: string): void;
}

export interface RunnerShutdownCoordinatorOptions {
  sink: TerminalSink;
  graceMs: number;
  saveState(): void;
  exit(code: 0 | 1): void;
  logger: RunnerLifecycleLogger;
}

export function assertRunnerShutdownBudget(sink: TerminalSink, configuredGraceMs: number): void {
  const required = sink.minimumShutdownGraceMs?.() ?? 0;
  if (!Number.isSafeInteger(required) || required < 0 || required > 120_000) {
    throw new Error(`Terminal sink reported an invalid shutdown grace requirement: ${required}`);
  }
  if (configuredGraceMs < required) {
    throw new Error(
      `Runner shutdown_grace_ms=${configuredGraceMs} is below the terminal cleanup requirement ${required}`,
    );
  }
}

export class RunnerStartupInterruptedError extends Error {
  readonly name = 'RunnerStartupInterruptedError';

  constructor() {
    super('runner startup interrupted by shutdown');
  }
}

/**
 * Owns the runner's process-exit transaction. Ingress is drained before state
 * persistence and terminal cleanup, and no failure can produce exit code 0.
 */
export class RunnerShutdownCoordinator {
  private stopping = false;
  private stopIngress: () => Promise<void> = async () => Promise.resolve();
  private completion?: Promise<void>;
  private resolveCompletion?: () => void;
  private deadline?: NodeJS.Timeout;
  private activePoll?: NodeJS.Timeout;
  private exited = false;
  private readonly failures: Error[] = [];

  constructor(private readonly options: RunnerShutdownCoordinatorOptions) {
    if (!Number.isInteger(options.graceMs) || options.graceMs < 1 || options.graceMs > 120_000) {
      throw new Error('runner shutdown grace must be an integer between 1 and 120000ms');
    }
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  registerIngressStopper(stopper: () => Promise<void>): void {
    if (this.stopping) {
      // JavaScript cannot interleave a signal callback between synchronous
      // resource creation and this registration, but retain a fail-closed guard.
      void stopper().catch((error) => this.recordFailure('late ingress cleanup failed', error));
      return;
    }
    this.stopIngress = stopper;
  }

  throwIfStopping(): void {
    if (this.stopping) throw new RunnerStartupInterruptedError();
  }

  begin(reason: string, initialFailure?: unknown): Promise<void> {
    if (initialFailure !== undefined) this.recordFailure('runner startup failed', initialFailure);
    if (this.completion) return this.completion;

    this.stopping = true;
    this.options.logger.info(`[Runner] ${reason} received, draining runner resources...`);
    this.completion = new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
    });
    // This safety deadline intentionally remains referenced: after a native
    // handle closes it may be the only handle keeping cleanup alive.
    this.deadline = setTimeout(() => this.finish(1), this.options.graceMs);
    void this.run(reason);
    return this.completion;
  }

  private async run(reason: string): Promise<void> {
    // Calling stopIngress synchronously flips the poll abort gate. Terminal
    // cleanup starts immediately afterwards and is not held hostage by a
    // network request that ignores cancellation.
    const ingress = this.settle('runner ingress drain failed', () => this.stopIngress());
    const cleanup = this.settle('terminal cleanup failed', async () => {
      if (this.options.sink.shutdown) {
        await this.options.sink.shutdown(`runner-${reason.toLowerCase()}`);
      } else {
        this.options.sink.cancelAll(`runner-${reason.toLowerCase()}`);
      }
    });

    // State can only be durably saved after the poll has stopped mutating it.
    await ingress;
    try {
      this.options.saveState();
    } catch (error) {
      this.recordFailure('runner state save failed', error);
    }
    await cleanup;

    this.checkActiveCount();
  }

  private async settle(context: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.recordFailure(context, error);
    }
  }

  private checkActiveCount(): void {
    let active: number;
    try {
      active = this.options.sink.activeCount();
    } catch (error) {
      this.recordFailure('terminal active-count check failed', error);
      return;
    }
    if (!Number.isSafeInteger(active) || active < 0) {
      this.recordFailure('terminal active-count check failed', new Error(`invalid count: ${active}`));
      return;
    }
    if (active === 0) {
      this.finish(this.failures.length === 0 ? 0 : 1);
      return;
    }
    if (!this.activePoll) {
      this.activePoll = setInterval(() => this.checkActiveCount(), 50);
    }
  }

  private recordFailure(context: string, error: unknown): void {
    const detail = boundedLifecycleDetail(error);
    const failure = new Error(`${context}: ${detail}`);
    if (this.failures.length < 20) this.failures.push(failure);
    this.options.logger.error(`[Runner] ${context}:`, detail);
  }

  private finish(code: 0 | 1): void {
    if (this.exited) return;
    this.exited = true;
    if (this.deadline) clearTimeout(this.deadline);
    if (this.activePoll) clearInterval(this.activePoll);
    this.options.exit(code);
    this.resolveCompletion?.();
  }
}
