/**
 * Ownership-safe node-pty 1.1.0 ConPTY teardown.
 *
 * WindowsTerminal.kill() is intentionally bypassed: its default path launches
 * a console-list helper and then signals raw PIDs, while its DLL path does not
 * deterministically dispose the conout worker. The dependency is exactly
 * pinned; a private-shape drift aborts startup before provider dispatch.
 */

export interface WindowsNativePtyHandle {
  readonly pid: number;
  kill(signal?: string): void;
}

interface WindowsConptyInternals {
  _close?: () => void;
  _agent?: {
    _useConpty?: boolean;
    _useConptyDll?: boolean;
    _pty?: number;
    _inSocket?: { destroy(): void; once?(event: 'error', listener: () => void): void };
    _outSocket?: { destroy(): void; once?(event: 'error', listener: () => void): void };
    _ptyNative?: { kill(pty: number, useConptyDll: boolean): void };
    _conoutSocketWorker?: {
      _drainTimeout?: NodeJS.Timeout;
      _isDisposed?: boolean;
      _worker?: { terminate(): Promise<number> };
    };
  };
}

export type WindowsNativeCloser = (native: WindowsNativePtyHandle) => Promise<void>;

const ERROR_MAX_LENGTH = 8_192;

function cleanupError(errors: readonly unknown[]): Error {
  const value = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join('; ');
  const detail =
    value.length <= ERROR_MAX_LENGTH
      ? value
      : `${value.slice(0, ERROR_MAX_LENGTH)}...[truncated]`;
  return new Error(`PTY process-tree cleanup failed: ${detail}`);
}

function inspect(native: WindowsNativePtyHandle): WindowsConptyInternals {
  return native as WindowsNativePtyHandle & WindowsConptyInternals;
}

export function validatePinnedWindowsConpty(native: WindowsNativePtyHandle): void {
  const terminal = inspect(native);
  const agent = terminal._agent;
  const worker = agent?._conoutSocketWorker;
  if (
    agent?._useConpty !== true ||
    agent._useConptyDll !== false ||
    !Number.isSafeInteger(agent._pty) ||
    agent._pty! < 1 ||
    typeof agent._ptyNative?.kill !== 'function' ||
    typeof agent._inSocket?.destroy !== 'function' ||
    typeof agent._outSocket?.destroy !== 'function' ||
    (agent._inSocket.once !== undefined && typeof agent._inSocket.once !== 'function') ||
    (agent._outSocket.once !== undefined && typeof agent._outSocket.once !== 'function') ||
    typeof worker?._worker?.terminate !== 'function' ||
    typeof terminal._close !== 'function'
  ) {
    throw new Error(
      'Unsupported node-pty Windows ownership shape; expected pinned node-pty 1.1.0',
    );
  }
}

export const closePinnedWindowsConpty: WindowsNativeCloser = async (native) => {
  validatePinnedWindowsConpty(native);
  const terminal = inspect(native);
  const agent = terminal._agent!;
  const worker = agent._conoutSocketWorker!;
  const errors: unknown[] = [];
  try {
    agent._inSocket!.once?.('error', () => undefined);
  } catch (error) {
    errors.push(error);
  }
  try {
    agent._outSocket!.once?.('error', () => undefined);
  } catch (error) {
    errors.push(error);
  }
  try {
    agent._inSocket!.destroy();
  } catch (error) {
    errors.push(error);
  }
  try {
    agent._ptyNative!.kill(agent._pty!, false);
  } catch (error) {
    errors.push(error);
  }
  try {
    agent._outSocket!.destroy();
  } catch (error) {
    errors.push(error);
  }
  if (worker._drainTimeout) clearTimeout(worker._drainTimeout);
  worker._isDisposed = true;
  try {
    await worker._worker!.terminate();
  } catch (error) {
    errors.push(error);
  }
  try {
    terminal._close!();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw cleanupError(errors);
};

export async function unwindDriftedWindowsConpty(
  native: WindowsNativePtyHandle,
): Promise<void> {
  const terminal = inspect(native);
  const agent = terminal._agent;
  const worker = agent?._conoutSocketWorker;
  const errors: unknown[] = [];
  let handleClosed = false;
  let workerTerminated = false;
  try {
    agent?._inSocket?.once?.('error', () => undefined);
  } catch (error) {
    errors.push(error);
  }
  try {
    agent?._outSocket?.once?.('error', () => undefined);
  } catch (error) {
    errors.push(error);
  }
  try {
    agent?._inSocket?.destroy();
  } catch (error) {
    errors.push(error);
  }
  if (
    agent?._useConpty === true &&
    typeof agent._useConptyDll === 'boolean' &&
    Number.isSafeInteger(agent._pty) &&
    agent._pty! > 0 &&
    typeof agent._ptyNative?.kill === 'function'
  ) {
    try {
      agent._ptyNative.kill(agent._pty!, agent._useConptyDll);
      handleClosed = true;
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    agent?._outSocket?.destroy();
  } catch (error) {
    errors.push(error);
  }
  if (worker?._drainTimeout) clearTimeout(worker._drainTimeout);
  if (worker?._worker) {
    worker._isDisposed = true;
    try {
      await worker._worker.terminate();
      workerTerminated = true;
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    terminal._close?.();
  } catch (error) {
    errors.push(error);
  }
  if (!handleClosed) errors.push(new Error('ConPTY handle-owned close unavailable'));
  if (!workerTerminated) errors.push(new Error('ConPTY worker termination unavailable'));
  if (errors.length > 0) throw cleanupError(errors);
}
