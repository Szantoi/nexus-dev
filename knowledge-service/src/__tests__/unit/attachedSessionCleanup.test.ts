import { describe, expect, it } from 'vitest';
import {
  disposeAttachedSubscriptions,
  drainCleanupErrors,
  recordCleanupError,
} from '../../runner/attachedSessionCleanup';
import { createRuntimeSession } from '../../runner/attachedSessionTypes';

describe('attached cleanup ledger', () => {
  it('records dispose failures at collection time and drains them exactly once', () => {
    const current = createRuntimeSession(undefined);
    current.dataSubscription = {
      dispose: () => {
        throw new Error('data leak');
      },
    };
    current.exitSubscription = { dispose: () => undefined };

    const returned = disposeAttachedSubscriptions(current);

    expect(returned).toHaveLength(1);
    const drained = drainCleanupErrors(current);
    expect(drained).toHaveLength(1);
    expect(drained[0].message).toMatch(/data subscription dispose failed: data leak/);
    expect(drainCleanupErrors(current)).toEqual([]);
  });

  it('does not re-record an already disposed subscription', () => {
    const current = createRuntimeSession(undefined);
    current.dataSubscription = {
      dispose: () => {
        throw new Error('data leak');
      },
    };

    disposeAttachedSubscriptions(current);
    // Subscriptions are cleared on first dispose; a second call is a no-op.
    disposeAttachedSubscriptions(current);

    expect(drainCleanupErrors(current)).toHaveLength(1);
  });

  it('bounds the ledger and reports the number of dropped entries', () => {
    const current = createRuntimeSession(undefined);
    for (let index = 0; index < 25; index++) {
      recordCleanupError(current, new Error(`cleanup failure ${index}`));
    }

    const drained = drainCleanupErrors(current);

    expect(drained).toHaveLength(21);
    expect(drained[0].message).toBe('cleanup failure 0');
    expect(drained[20].message).toBe('+5 additional cleanup error(s) dropped');
    expect(drainCleanupErrors(current)).toEqual([]);
  });
});
