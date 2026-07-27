import { ValidationError, RuntimeStateError } from '../core/errors';
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024;

export interface HandoffDisposable {
  dispose(): void;
}

export interface HandoffExitEvent {
  exitCode: number;
  signal?: number;
}

export interface HandoffEventSource {
  onData(listener: (data: string) => void): HandoffDisposable;
  onExit(listener: (event: HandoffExitEvent) => void): HandoffDisposable;
}

type BufferedEvent =
  | { kind: 'data'; data: string }
  | { kind: 'exit'; event: HandoffExitEvent };

type HandoffState = 'capturing' | 'transferring' | 'replaying' | 'live' | 'disposed';

class DeferredDisposable implements HandoffDisposable {
  private target?: HandoffDisposable;
  private disposed = false;

  attach(target: HandoffDisposable): void {
    if (this.target) throw new RuntimeStateError('PTY handoff disposable already attached');
    this.target = target;
    if (this.disposed) target.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target?.dispose();
  }
}

/**
 * Buffers early PTY data/exit events until the manager has installed both
 * consumer listeners, then atomically transfers delivery and replays once.
 */
export class EarlyPtyEventHandoff implements HandoffDisposable {
  private readonly events: BufferedEvent[] = [];
  private state: HandoffState = 'capturing';
  private bufferedBytes = 0;
  private dataConsumer?: (data: string) => void;
  private exitConsumer?: (event: HandoffExitEvent) => void;
  private dataProxy?: DeferredDisposable;
  private exitProxy?: DeferredDisposable;
  private earlyData?: HandoffDisposable;
  private earlyExit?: HandoffDisposable;
  private dataDirect = false;
  private exitDirect = false;
  private terminalFailure?: Error;
  private observedExit = false;

  constructor(
    private readonly source: HandoffEventSource,
    private readonly maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1) {
      throw new ValidationError('PTY early-event buffer limit must be a positive safe integer', { maxBufferBytes: 'must be >= 1' });
    }
    try {
      this.earlyData = source.onData((data) => this.captureData(data, false));
      this.earlyExit = source.onExit((event) => this.captureExit(event, false));
    } catch (error) {
      try {
        this.earlyData?.dispose();
      } catch {
        // Preserve the subscription failure as the startup cause.
      }
      throw error;
    }
  }

  get failure(): Error | undefined {
    return this.terminalFailure;
  }

  get hasExited(): boolean {
    return this.observedExit;
  }

  onData(listener: (data: string) => void): HandoffDisposable {
    this.assertUsable();
    if (this.dataConsumer) return this.source.onData(listener);
    this.dataConsumer = listener;
    this.dataProxy = new DeferredDisposable();
    this.tryTransfer();
    return this.dataProxy;
  }

  onExit(listener: (event: HandoffExitEvent) => void): HandoffDisposable {
    this.assertUsable();
    if (this.exitConsumer) return this.source.onExit(listener);
    this.exitConsumer = listener;
    this.exitProxy = new DeferredDisposable();
    this.tryTransfer();
    return this.exitProxy;
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    const errors: unknown[] = [];
    for (const disposable of [
      this.earlyData,
      this.earlyExit,
      this.dataProxy,
      this.exitProxy,
    ]) {
      try {
        disposable?.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.events.length = 0;
    this.bufferedBytes = 0;
    if (errors.length > 0) {
      throw new RuntimeStateError(
        `PTY early-event handoff dispose failed: ${errors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join('; ')}`,
      );
    }
  }

  private tryTransfer(): void {
    if (!this.dataConsumer || !this.exitConsumer || !this.dataProxy || !this.exitProxy) {
      return;
    }
    this.assertUsable();
    this.state = 'transferring';
    const errors: unknown[] = [];
    try {
      this.dataDirect = true;
      this.dataProxy.attach(
        this.source.onData((data) => this.captureData(data, true)),
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      this.exitDirect = true;
      this.exitProxy.attach(
        this.source.onExit((event) => this.captureExit(event, true)),
      );
    } catch (error) {
      errors.push(error);
    }
    for (const disposable of [this.earlyData, this.earlyExit]) {
      try {
        disposable?.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.earlyData = undefined;
    this.earlyExit = undefined;
    if (errors.length > 0 || this.terminalFailure) {
      const failure =
        this.terminalFailure ??
        new Error(
          `PTY early-event handoff transfer failed: ${errors
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join('; ')}`,
        );
      this.terminalFailure = failure;
      this.state = 'disposed';
      try {
        this.dataProxy.dispose();
      } catch {
        // The transfer error remains the primary failure.
      }
      try {
        this.exitProxy.dispose();
      } catch {
        // The transfer error remains the primary failure.
      }
      throw failure;
    }

    this.state = 'replaying';
    for (let index = 0; index < this.events.length; index++) {
      const event = this.events[index];
      if (event.kind === 'data') this.dataConsumer(event.data);
      else this.exitConsumer(event.event);
    }
    this.events.length = 0;
    this.bufferedBytes = 0;
    this.state = 'live';
  }

  private captureData(data: string, direct: boolean): void {
    if (this.state === 'disposed') return;
    if (this.state === 'live') {
      if (direct) this.dataConsumer?.(data);
      return;
    }
    if (!direct && this.dataDirect) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    if (this.bufferedBytes + bytes > this.maxBufferBytes) {
      this.terminalFailure ??= new Error(
        `PTY early-event buffer exceeded ${this.maxBufferBytes} bytes`,
      );
      return;
    }
    this.bufferedBytes += bytes;
    this.events.push({ kind: 'data', data });
  }

  private captureExit(event: HandoffExitEvent, direct: boolean): void {
    if (this.state === 'disposed') return;
    this.observedExit = true;
    if (this.state === 'live') {
      if (direct) this.exitConsumer?.(event);
      return;
    }
    if (!direct && this.exitDirect) return;
    this.events.push({ kind: 'exit', event });
  }

  private assertUsable(): void {
    if (this.terminalFailure) throw this.terminalFailure;
    if (this.state === 'disposed') throw new RuntimeStateError('PTY early-event handoff is disposed');
  }
}
