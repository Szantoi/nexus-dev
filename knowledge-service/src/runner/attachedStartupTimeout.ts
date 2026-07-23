import type { PtySession } from './ptyHost';
import type { RuntimeSession } from './attachedSessionTypes';

export function armAttachedStartupTimeout(
  terminal: string,
  current: RuntimeSession,
  generation: number,
  timeoutMs: number,
  onTimeout: (session: PtySession | undefined, failure: string) => void,
): void {
  current.startupTimer = setTimeout(() => {
    current.startupTimer = undefined;
    if (current.generation !== generation || current.state !== 'starting') return;
    const failure = `attached terminal startup timeout: ${terminal}`;
    if (!current.session) {
      current.state = 'stopping';
      current.sessionUsable = false;
      current.lastError = failure;
    }
    onTimeout(current.session, failure);
  }, timeoutMs);
  current.startupTimer.unref();
}
