/**
 * Store tests for the additive canonical-model features:
 * status transitions + audit trail (status_history) and content-hash verification.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

const runId = crypto.randomBytes(6).toString('hex');
process.env.DATA_DIR = path.join(os.tmpdir(), `msgstatus-data-${runId}`);
process.env.TERMINALS_PATH = path.join(os.tmpdir(), `msgstatus-terminals-${runId}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;

beforeAll(async () => {
  store = await import('../task-message-box/store');
  await store.initDatabase();
});

async function freshTask() {
  const res = await store.createTask({
    from: 'conductor', to: 'backend', title: 'audit me', description: 'body', priority: 'high',
  });
  expect(res.success).toBe(true);
  return res.id as string;
}

describe('status transitions + audit trail', () => {
  it('records each valid transition in status_history with from/to/at/by', async () => {
    const id = await freshTask();
    expect((await store.updateMessageStatus(id, 'read', 'backend')).success).toBe(true);
    expect((await store.updateMessageStatus(id, 'in_progress', 'backend')).success).toBe(true);
    expect((await store.updateMessageStatus(id, 'completed', 'backend')).success).toBe(true);

    const history = store.getStatusHistory(id);
    expect(history.length).toBe(3);
    expect(history.map((h: any) => h.to)).toEqual(['read', 'in_progress', 'completed']);
    expect(history[0].from).toBe('unread');
    expect(history[0].by).toBe('backend');
    expect(history[0].at).toBeTruthy();

    const msg = await store.getMessage(id);
    expect(msg.status).toBe('completed');
    expect(msg.completed_at).toBeTruthy();
  });

  it('rejects an invalid transition and leaves status + history untouched', async () => {
    const id = await freshTask();
    const bad = await store.updateMessageStatus(id, 'completed', 'x'); // unread → completed not allowed
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('Invalid status transition');
    expect(store.getStatusHistory(id).length).toBe(0);
    expect((await store.getMessage(id)).status).toBe('unread');
  });

  it('returns an error for an unknown message id', async () => {
    const res = await store.updateMessageStatus('MSG-NOPE-999', 'read');
    expect(res.success).toBe(false);
  });
});

describe('content-hash verification', () => {
  it('verifies an untampered message as valid', async () => {
    const id = await freshTask();
    const v = store.verifyMessageHash(id);
    expect(v.valid).toBe(true);
    expect(v.expected).toBe(v.actual);
  });

  it('detects tampering (row content changed out from under the stored hash)', async () => {
    const id = await freshTask();
    // Simulate tampering: change the description directly, bypassing the hash.
    store.getDb().prepare('UPDATE messages SET description = ? WHERE id = ?')
      .run('TAMPERED', id);
    const v = store.verifyMessageHash(id);
    expect(v.valid).toBe(false);

    const all = store.verifyAllMessages();
    expect(all.invalid).toContain(id);
    expect(all.total).toBeGreaterThan(0);
  });
});
