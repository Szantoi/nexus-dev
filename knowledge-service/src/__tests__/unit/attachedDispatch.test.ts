import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../core/errors';
import { dispatchAttachedTask } from '../../runner/attachedDispatch';
import type { AttachedTaskMarkerStore } from '../../runner/attachedTaskMarkerStore';
import { createRuntimeSession, type AttachedTerminalPolicy } from '../../runner/attachedSessionTypes';
import type { PtySession } from '../../runner/ptyHost';

function markerStore(): AttachedTaskMarkerStore {
  return {
    load: () => undefined,
    save: () => undefined,
    clear: () => false,
  };
}

function readySession(): PtySession {
  return {
    pid: 1234,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write: vi.fn(),
    resize: () => undefined,
    kill: async () => undefined,
  };
}

describe('dispatchAttachedTask', () => {
  it('marks a model-policy validation failure as permanently refused', () => {
    const runtime = createRuntimeSession(undefined);
    runtime.state = 'ready';
    runtime.session = readySession();
    const policy: AttachedTerminalPolicy = {
      expectedIslandId: 'island-a',
      spawn: {
        executable: 'codex',
        args: [],
        cwd: '.',
        env: {},
        cols: 120,
        rows: 36,
      },
      startupTimeoutMs: 30_000,
      idleSettleMs: 1_500,
      idleConfirmSamples: 2,
      isReadySample: () => true,
      isIdleSample: () => true,
      encodeDispatch: () => {
        throw new ValidationError('attached session model does not match requested task model');
      },
    };

    const result = dispatchAttachedTask(runtime, policy, markerStore(), {
      terminal: 'explorer',
      messageId: 'MSG-MODEL-MISMATCH',
      model: 'gpt-5.6-terra',
    });

    expect(result).toMatchObject({
      started: false,
      permanentRefusal: true,
      reason: expect.stringContaining('model does not match'),
    });
    expect(runtime.session.write).not.toHaveBeenCalled();
  });
});
