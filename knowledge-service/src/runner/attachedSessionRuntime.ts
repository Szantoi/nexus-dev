import type { RuntimeSession } from './attachedSessionTypes';
import type { PtySession } from './ptyHost';
import { TerminalNotFoundError, RuntimeStateError } from '../core/errors';

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
  if (!current) throw new TerminalNotFoundError(terminal);
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
      throw new RuntimeStateError(`attached terminal has a tracked PTY pending cleanup: ${terminal}`, terminal);
    }
    if (current.state === 'attention_required') {
      // A session-less stale-marker park is RECONCILABLE: the completion pump
      // can promote it from a durable server receipt once the runner is up,
      // and the busy-gate keeps new work away meanwhile. Failing startup here
      // would brick every boot after a mid-task restart (operator file
      // surgery), exactly what durable receipts exist to avoid.
      if (current.attentionReason === 'stale_marker' && !current.session) continue;
      throw new RuntimeStateError(`attached terminal requires reconciliation: ${terminal}`, terminal);
    }
    if (current.state === 'failed' && current.messageId && !current.completedBeforeExit) {
      throw new RuntimeStateError(`attached terminal has unresolved work: ${terminal}`, terminal);
    }
    if (current.restartBudgetExhausted) {
      throw new RuntimeStateError(`attached terminal restart budget exhausted: ${terminal}`, terminal);
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
