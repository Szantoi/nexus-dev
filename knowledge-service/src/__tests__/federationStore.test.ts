/**
 * Federation store tests (ADR-066 reference, increment 1).
 *
 * Verifies the cross-island federation layer built on the canonical
 * task-message-box store: send, token-optimized inbox, dedup, island isolation,
 * and that local (no-island) messages never appear in a federation inbox.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';

// Point the store's DATA_DIR + TERMINALS_PATH at temp dirs BEFORE importing it
// (paths.ts reads these env vars at module load).
const runId = crypto.randomBytes(6).toString('hex');
process.env.DATA_DIR = path.join(os.tmpdir(), `fedstore-data-${runId}`);
process.env.TERMINALS_PATH = path.join(os.tmpdir(), `fedstore-terminals-${runId}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;

beforeAll(async () => {
  store = await import('../task-message-box/store');
  await store.initDatabase();
});

describe('Federation store (task-message-box canonical)', () => {
  it('sends a cross-island message and lists it in the destination federation inbox (metadata only)', async () => {
    const res = await store.sendFederationMessage({
      from_island: 'spaceos', from_terminal: 'root',
      to_island: 'cabinet', to_terminal: 'root',
      type: 'task', priority: 'high',
      subject: 'Build the thing', body: 'Full body that should NOT appear in the inbox row.',
    });
    expect(res.success).toBe(true);
    expect(res.id).toBeTruthy();

    const inbox = await store.getFederationInbox('cabinet', 'unread');
    expect(inbox.success).toBe(true);
    const row = inbox.data.find((r: any) => r.id === res.id);
    expect(row).toBeTruthy();
    expect(row.subject).toBe('Build the thing');
    expect(row.from_island).toBe('spaceos');
    expect(row.to_island).toBe('cabinet');
    expect(row.status).toBe('unread');
    // token-optimization: the metadata row carries NO body/description field
    expect(row.body).toBeUndefined();
    expect(row.description).toBeUndefined();
  });

  it('dedupes identical content to the same destination (content_hash)', async () => {
    const a = await store.sendFederationMessage({
      from_island: 'spaceos', from_terminal: 'root', to_island: 'cabinet', to_terminal: 'root',
      type: 'info', priority: 'low', subject: 'dup', body: 'same body',
    });
    const b = await store.sendFederationMessage({
      from_island: 'spaceos', from_terminal: 'root', to_island: 'cabinet', to_terminal: 'root',
      type: 'info', priority: 'low', subject: 'dup', body: 'same body',
    });
    expect(a.id).toBe(b.id);
  });

  it('isolates islands: a message to cabinet does not show in doorstar inbox', async () => {
    await store.sendFederationMessage({
      from_island: 'spaceos', from_terminal: 'root', to_island: 'cabinet', to_terminal: 'root',
      type: 'task', priority: 'medium', subject: 'cabinet-only', body: 'x',
    });
    const doorstar = await store.getFederationInbox('doorstar', 'all');
    expect(doorstar.data.some((r: any) => r.subject === 'cabinet-only')).toBe(false);
  });

  it('local (no-island) messages never appear in any federation inbox', async () => {
    await store.createTask({
      from: 'conductor', to: 'backend', title: 'local task', description: 'stays local',
      priority: 'high',
    });
    const cab = await store.getFederationInbox('cabinet', 'all');
    const door = await store.getFederationInbox('doorstar', 'all');
    expect(cab.data.some((r: any) => r.subject === 'local task')).toBe(false);
    expect(door.data.some((r: any) => r.subject === 'local task')).toBe(false);
  });

  it('orders the federation inbox by priority then age', async () => {
    const isl = 'inbox-order-test';
    await store.sendFederationMessage({ from_island: 'spaceos', from_terminal: 'root', to_island: isl, to_terminal: 'root', type: 'info', priority: 'low', subject: 'low1', body: 'b' });
    await store.sendFederationMessage({ from_island: 'spaceos', from_terminal: 'root', to_island: isl, to_terminal: 'root', type: 'info', priority: 'critical', subject: 'crit1', body: 'b' });
    const inbox = await store.getFederationInbox(isl, 'all');
    expect(inbox.data[0].subject).toBe('crit1'); // critical first
  });
});

// Regression: a live CAD↔Doorstar round-trip surfaced two defects — the DB type
// CHECK rejected the canonical `response` type, and ack skipped the audit trail.
describe('Federation store — canonical type + audited status (regression)', () => {
  it('accepts a canonical `response` type (was rejected by a stale type CHECK)', async () => {
    const res = await store.sendFederationMessage({
      from_island: 'doorstar', from_terminal: 'root',
      to_island: 'response-isl', to_terminal: 'root',
      type: 'response', priority: 'high',
      subject: 'RE: proba', body: 'reply body', ref_id: null,
    });
    expect(res.success).toBe(true); // pre-fix: false — "CHECK constraint failed: type IN (...)"
    const inbox = await store.getFederationInbox('response-isl', 'unread');
    const row = inbox.data.find((r: any) => r.id === res.id);
    expect(row?.type).toBe('response');
  });

  it('records an unread→read entry in status_history on the delivery transition', async () => {
    const sent = await store.sendFederationMessage({
      from_island: 'spaceos', from_terminal: 'root',
      to_island: 'audit-isl', to_terminal: 'root',
      type: 'info', priority: 'medium', subject: 'audit', body: 'b',
    });
    const upd = await store.updateMessageStatus(sent.id, 'read', 'root');
    expect(upd.success).toBe(true);
    const history = store.getStatusHistory(sent.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from: 'unread', to: 'read', by: 'root' });
  });
});
