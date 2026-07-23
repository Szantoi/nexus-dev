import type { RuntimeSession } from './attachedSessionTypes';
import type { PtySession } from './ptyHost';

export function countActiveAttachedSessions(runtime: ReadonlyMap<string, RuntimeSession>): number {
  return [...runtime.values()].filter(
    (current) => current.session !== undefined || current.spawnPromise !== undefined,
  ).length;
}

export function createAttachedSessionMatcher(
  runtime: ReadonlyMap<string, RuntimeSession>,
): (terminal: string, session: PtySession, generation: number) => boolean {
  return (terminal, session, generation) => {
    const current = runtime.get(terminal);
    return current?.session === session && current.generation === generation;
  };
}

export function requireAttachedRuntime(
  runtime: ReadonlyMap<string, RuntimeSession>,
  terminal: string,
): RuntimeSession {
  const current = runtime.get(terminal);
  if (!current) throw new Error(`attached terminal not configured: ${terminal}`);
  return current;
}

/** Fail preflight closed for any terminal that cannot safely (re)start. */
export function assertAttachedPreflightState(
  runtime: ReadonlyMap<string, RuntimeSession>,
  terminals: Iterable<string>,
): void {
  for (const terminal of terminals) {
    const current = requireAttachedRuntime(runtime, terminal);
    if (
      current.session &&
      !['starting', 'ready', 'busy', 'draining'].includes(current.state)
    ) {
      throw new Error(`attached terminal has a tracked PTY pending cleanup: ${terminal}`);
    }
    if (current.state === 'attention_required') {
      throw new Error(`attached terminal requires reconciliation: ${terminal}`);
    }
    if (current.state === 'failed' && current.messageId && !current.completedBeforeExit) {
      throw new Error(`attached terminal has unresolved work: ${terminal}`);
    }
    if (current.restartBudgetExhausted) {
      throw new Error(`attached terminal restart budget exhausted: ${terminal}`);
    }
  }
}

export function ensureAttachedReadiness(current: RuntimeSession): Promise<void> {
  if (!current.readiness) {
    current.readiness = new Promise<void>((resolve, reject) => {
      current.resolveReadiness = resolve;
      current.rejectReadiness = reject;
    });
    void current.readiness.catch(() => undefined);
  }
  return current.readiness;
}

export function resolveAttachedReadiness(current: RuntimeSession): void {
  const resolve = current.resolveReadiness;
  clearAttachedReadiness(current);
  resolve?.();
}

export function rejectAttachedReadiness(current: RuntimeSession, error: Error): void {
  const reject = current.rejectReadiness;
  clearAttachedReadiness(current);
  reject?.(error);
}

function clearAttachedReadiness(current: RuntimeSession): void {
  current.readiness = undefined;
  current.resolveReadiness = undefined;
  current.rejectReadiness = undefined;
}

export function clearAttachedStartupTimer(current: RuntimeSession): void {
  if (current.startupTimer) clearTimeout(current.startupTimer);
  current.startupTimer = undefined;
}

export function clearAttachedRestartTimer(current: RuntimeSession): boolean {
  if (!current.restartTimer) return false;
  clearTimeout(current.restartTimer);
  current.restartTimer = undefined;
  return true;
}
