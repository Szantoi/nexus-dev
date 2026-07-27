/**
 * attachedCompletionPump.ts — feed durable completion receipts and stable-idle
 * proofs into the attached session manager (plan §9/D).
 *
 * The pump is the only consumer of the cursored receipt API in the runner
 * main loop. SSE stays wake-only; a missed event never loses state because
 * the cursor replays from the last durably delivered sequence.
 *
 * Cursor rule: a receipt's sequence is advanced ONLY after the manager
 * accepted it (live completion or marker reconciliation), or when nothing in
 * this runtime can own it (historical receipt of an already-released task).
 * A receipt matching the CURRENT task that fails to apply (e.g. marker
 * persist failure) blocks the cursor and is retried on the next pump.
 */

import type { AttachedDeadlineEvent, AttachedDeadlineLimits } from './attachedDeadlines';
import type {
  AttachedSessionSnapshot,
  AttachedStableIdleProof,
} from './attachedSessionTypes';
import type { CompletionCursorStore } from './completionCursorStore';
import type { CompletionReceiptPage, RunnerCompletionReceipt } from './serverClient';
import { ConfigurationError, ValidationError } from '../core/errors';

const MAX_PAGES_PER_PUMP = 5;

export interface AttachedPumpClient {
  fetchCompletionReceipts(
    terminal: string,
    expectedIslandId: string,
    after: number,
  ): Promise<CompletionReceiptPage>;
  completionStreamKey(terminal: string, expectedIslandId: string): string;
}

export interface AttachedPumpManager {
  snapshot(terminal: string): AttachedSessionSnapshot | undefined;
  acknowledgeCompletion(receipt: RunnerCompletionReceipt): boolean;
  reconcileMarker(receipt: RunnerCompletionReceipt): boolean;
  acknowledgeStableIdle(proof: AttachedStableIdleProof): boolean;
  auditDeadlines(limits: AttachedDeadlineLimits): AttachedDeadlineEvent[];
}

export interface AttachedPumpLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface AttachedPumpOptions {
  terminals: readonly string[];
  expectedIslandId: string;
  limits: AttachedDeadlineLimits;
  client: AttachedPumpClient;
  cursors: CompletionCursorStore;
  manager: AttachedPumpManager;
  logger: AttachedPumpLogger;
  now?: () => number;
}

export interface AttachedPumpReport {
  delivered: number;
  blockedTerminals: string[];
  failedTerminals: string[];
  released: number;
  deadlineEvents: AttachedDeadlineEvent[];
}

export class AttachedCompletionPump {
  private readonly now: () => number;

  constructor(private readonly options: AttachedPumpOptions) {
    if (options.terminals.length === 0) {
      throw new ConfigurationError('attached completion pump requires at least one terminal');
    }
    if (!options.expectedIslandId) {
      throw new ConfigurationError('attached completion pump requires expectedIslandId');
    }
    this.now = options.now ?? Date.now;
  }

  /** One full pump round; per-terminal failures are isolated and reported. */
  async pumpOnce(): Promise<AttachedPumpReport> {
    const report: AttachedPumpReport = {
      delivered: 0,
      blockedTerminals: [],
      failedTerminals: [],
      released: 0,
      deadlineEvents: [],
    };
    for (const terminal of this.options.terminals) {
      try {
        await this.pumpReceipts(terminal, report);
      } catch (error) {
        report.failedTerminals.push(terminal);
        this.options.logger.warn(
          `[Runner] Completion pump failed for ${terminal}: ${errorText(error)}`,
        );
      }
      if (this.acknowledgeIdle(terminal)) report.released++;
    }
    report.deadlineEvents = this.options.manager.auditDeadlines(this.options.limits);
    for (const event of report.deadlineEvents) {
      const detail =
        event.kind === 'task_stall_warning'
          ? `no PTY output for ${event.stalledForMs}ms`
          : `stable idle not proven for ${event.drainingForMs}ms`;
      this.options.logger.warn(
        `[Runner] Attached ${event.kind} (${event.terminal}/${event.messageId}): ${detail}`,
      );
    }
    return report;
  }

  private async pumpReceipts(terminal: string, report: AttachedPumpReport): Promise<void> {
    const { client, cursors, manager, expectedIslandId } = this.options;
    const streamKey = client.completionStreamKey(terminal, expectedIslandId);
    let after = cursors.get(streamKey);
    for (let page = 0; page < MAX_PAGES_PER_PUMP; page++) {
      const result = await client.fetchCompletionReceipts(terminal, expectedIslandId, after);
      if (result.receipts.length === 0) return;
      // The durable cursor advances once per page (crash-replay of already
      // delivered receipts is idempotent), so a 500-receipt backlog costs one
      // atomic file write instead of five hundred.
      let accepted = after;
      let blocked = false;
      for (const receipt of result.receipts) {
        const delivered =
          manager.acknowledgeCompletion(receipt) || manager.reconcileMarker(receipt);
        if (delivered) {
          report.delivered++;
        } else if (manager.snapshot(terminal)?.messageId === receipt.messageId) {
          // The current task's receipt could not be applied (persist failure
          // parked the terminal). Keep the cursor so the retry can reconcile.
          report.blockedTerminals.push(terminal);
          blocked = true;
          break;
        }
        // Anything else is server-authoritative history nothing here owns.
        accepted = receipt.sequence;
      }
      if (accepted > after) {
        cursors.advance(streamKey, accepted);
        after = accepted;
      }
      if (blocked || !result.hasMore) return;
    }
  }

  /** Offer a stable-idle proof for a draining terminal; rejection is normal. */
  private acknowledgeIdle(terminal: string): boolean {
    const snapshot = this.options.manager.snapshot(terminal);
    if (
      snapshot?.state !== 'draining' ||
      !snapshot.completionGate ||
      !snapshot.messageId ||
      snapshot.receiptSequence === undefined ||
      snapshot.sessionGeneration === undefined
    ) {
      return false;
    }
    return this.options.manager.acknowledgeStableIdle({
      terminal,
      messageId: snapshot.messageId,
      sessionGeneration: snapshot.sessionGeneration,
      receiptSequence: snapshot.receiptSequence,
      outputEpoch: snapshot.outputEpoch,
      completionGate: snapshot.completionGate,
      settledAt: new Date(this.now()).toISOString(),
    });
  }
}

export interface AttachedPumpHandle {
  /** Trigger an immediate pump (SSE wake). Safe to call anytime. */
  wake(): void;
  /** Stop scheduling and await the in-flight pump. */
  stop(): Promise<void>;
}

/**
 * Drive the pump on a fixed interval with wake coalescing, mirroring the poll
 * loop's discipline: one pump in flight, a wake during a pump queues exactly
 * one follow-up.
 */
export function startAttachedCompletionPump(
  pump: Pick<AttachedCompletionPump, 'pumpOnce'>,
  intervalMs: number,
  logger: AttachedPumpLogger,
): AttachedPumpHandle {
  if (!Number.isInteger(intervalMs) || intervalMs < 100) {
    throw new ValidationError('attached pump interval must be an integer >= 100ms', { intervalMs: 'must be >= 100' });
  }
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let wakeRequested = false;

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref();
  };

  const run = (): void => {
    if (stopped || inFlight) {
      if (inFlight && !stopped) wakeRequested = true;
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const execution = pump
      .pumpOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.warn(`[Runner] Completion pump round failed: ${errorText(error)}`);
      })
      .finally(() => {
        if (inFlight !== execution) return;
        inFlight = undefined;
        const immediate = wakeRequested;
        wakeRequested = false;
        schedule(immediate ? 0 : intervalMs);
      });
    inFlight = execution;
  };

  run();

  return {
    wake(): void {
      run();
    },
    async stop(): Promise<void> {
      stopped = true;
      wakeRequested = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
