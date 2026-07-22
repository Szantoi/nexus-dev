import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CompletionReceiptStore } from '../../pipeline/completionReceiptStore';
import { CompletionCursorStore } from '../../runner/completionCursorStore';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const target of temporaryPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('CompletionReceiptStore', () => {
  it('is append-only and idempotent for an island/terminal/message tuple', () => {
    const db = new Database(':memory:');
    const store = new CompletionReceiptStore(db);

    const first = store.record({
      islandId: 'island-a',
      terminalId: 'backend',
      messageId: 'MSG-1',
      completedAt: '2026-07-22T10:00:00.000Z',
      source: 'mcp_complete_task',
    });
    const duplicate = store.record({
      islandId: 'island-a',
      terminalId: 'backend',
      messageId: 'MSG-1',
      completedAt: '2026-07-22T11:00:00.000Z',
      source: 'mcp_complete_task',
    });

    expect(duplicate).toEqual(first);
    expect(duplicate.completedAt).toBe('2026-07-22T10:00:00.000Z');
    expect(store.list('island-a', 'backend', 0)).toMatchObject({
      receipts: [first],
      nextCursor: first.sequence,
      hasMore: false,
    });
    db.close();
  });

  it('filters by server-derived scope and paginates with a monotonic cursor', () => {
    const db = new Database(':memory:');
    const store = new CompletionReceiptStore(db);
    const one = store.record({
      islandId: 'island-a', terminalId: 'backend', messageId: 'MSG-1', source: 'mcp_complete_task',
    });
    store.record({
      islandId: 'island-b', terminalId: 'backend', messageId: 'MSG-FOREIGN', source: 'mcp_complete_task',
    });
    store.record({
      islandId: 'island-a', terminalId: 'frontend', messageId: 'MSG-OTHER', source: 'mcp_complete_task',
    });
    const two = store.record({
      islandId: 'island-a', terminalId: 'backend', messageId: 'MSG-2', source: 'mcp_complete_task',
    });

    const firstPage = store.list('island-a', 'backend', 0, 1);
    expect(firstPage.receipts.map((receipt) => receipt.messageId)).toEqual(['MSG-1']);
    expect(firstPage.nextCursor).toBe(one.sequence);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = store.list('island-a', 'backend', firstPage.nextCursor, 1);
    expect(secondPage.receipts.map((receipt) => receipt.messageId)).toEqual(['MSG-2']);
    expect(secondPage.nextCursor).toBe(two.sequence);
    expect(secondPage.hasMore).toBe(false);
    expect(store.list('island-b', 'frontend', 0).receipts).toEqual([]);
    expect(() => store.list('island-a', 'backend', -1)).toThrow(RangeError);
    db.close();
  });
});

describe('CompletionCursorStore', () => {
  it('persists monotonic cursors and rejects regression or corrupt files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-cursor-'));
    temporaryPaths.push(root);
    const file = path.join(root, 'cursors.json');
    const store = new CompletionCursorStore(file);

    expect(store.load()).toBe('missing');
    store.advance('https://server::backend', 12);
    expect(store.get('https://server::backend')).toBe(12);
    expect(() => store.advance('https://server::backend', 11)).toThrow(/regression/);
    store.advance('https://server::backend', 13);

    const reloaded = new CompletionCursorStore(file);
    expect(reloaded.load()).toBe('loaded');
    expect(reloaded.get('https://server::backend')).toBe(13);

    fs.writeFileSync(file, '{"version":1,"cursors":{"backend":-1}}', 'utf-8');
    const corrupt = new CompletionCursorStore(file);
    expect(corrupt.load()).toBe('corrupt');
    expect(corrupt.get('backend')).toBe(0);
  });
});
