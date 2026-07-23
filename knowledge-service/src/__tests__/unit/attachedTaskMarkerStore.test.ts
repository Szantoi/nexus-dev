import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AttachedMarkerDirectoryDurability,
  type AttachedTaskMarker,
  FileAttachedTaskMarkerStore,
} from '../../runner/attachedTaskMarkerStore';

const temporaryPaths: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attached-marker-'));
  temporaryPaths.push(directory);
  return directory;
}

function marker(overrides: Partial<AttachedTaskMarker> = {}): AttachedTaskMarker {
  return {
    version: 1,
    terminal: 'backend',
    messageId: 'MSG-42',
    generation: 3,
    pid: 4242,
    phase: 'accepted',
    startedAt: '2026-07-22T20:00:00.000Z',
    updatedAt: '2026-07-22T20:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  for (const target of temporaryPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('FileAttachedTaskMarkerStore', () => {
  it('flushes the parent directory after the first marker entry is created', () => {
    const root = temporaryDirectory();
    const flushed: string[] = [];
    const durability: AttachedMarkerDirectoryDurability = {
      flush: (directory) => flushed.push(directory),
    };
    const store = new FileAttachedTaskMarkerStore(root, durability);

    store.save(marker());

    expect(flushed).toEqual([path.join(root, 'backend'), root]);
    expect(store.load('backend')).toEqual(marker());
  });

  it('flushes every newly created recursive directory entry leaf-to-ancestor', () => {
    const base = temporaryDirectory();
    const root = path.join(base, 'new', 'nested', 'logs');
    const flushed: string[] = [];
    const store = new FileAttachedTaskMarkerStore(root, {
      flush: (directory) => flushed.push(directory),
    });

    store.save(marker());

    expect(flushed).toEqual([
      path.join(root, 'backend'),
      root,
      path.join(base, 'new', 'nested'),
      path.join(base, 'new'),
      base,
    ]);
    expect(store.load('backend')).toEqual(marker());
  });

  it('does not flush the directory when updating an existing marker entry in place', () => {
    const root = temporaryDirectory();
    const flushed: string[] = [];
    const store = new FileAttachedTaskMarkerStore(root, {
      flush: (directory) => flushed.push(directory),
    });
    store.save(marker());
    flushed.length = 0;

    store.save(
      marker({
        phase: 'written',
        updatedAt: '2026-07-22T20:00:01.000Z',
      }),
    );

    expect(flushed).toEqual([]);
    expect(store.load('backend')?.phase).toBe('written');
  });

  it('flushes the parent directory after an exact marker entry is cleared', () => {
    const root = temporaryDirectory();
    const flushed: string[] = [];
    const store = new FileAttachedTaskMarkerStore(root, {
      flush: (directory) => flushed.push(directory),
    });
    store.save(marker());
    flushed.length = 0;

    expect(store.clear('backend', 'MSG-42', 3)).toBe(true);

    expect(flushed).toEqual([path.join(root, 'backend')]);
    expect(store.load('backend')).toBeUndefined();
  });

  it('sticks in an indeterminate state when a required create directory flush fails', () => {
    const root = temporaryDirectory();
    const terminalDirectory = path.join(root, 'backend');
    const flushed: string[] = [];
    const createFailure = new FileAttachedTaskMarkerStore(root, {
      flush: (directory) => {
        flushed.push(directory);
        if (directory === root) throw new Error('injected ancestor flush failure');
      },
    });

    expect(() => createFailure.save(marker())).toThrow(/cannot durably create.*ancestor flush/i);
    expect(flushed).toEqual([terminalDirectory, root]);
    expect(() => createFailure.load('backend')).toThrow(/durability is indeterminate/i);
    expect(() => createFailure.save(marker({ phase: 'written' }))).toThrow(
      /durability is indeterminate/i,
    );
    expect(() => createFailure.clear('backend', 'MSG-42', 3)).toThrow(
      /durability is indeterminate/i,
    );

    // A fresh reconciler can still observe the marker; the failed store cannot
    // silently turn the uncertain create into a normal in-place update.
    expect(new FileAttachedTaskMarkerStore(root, { flush: () => undefined }).load('backend')).toEqual(
      marker(),
    );
  });

  it('sticks in an indeterminate state when the exact clear directory flush fails', () => {
    const root = temporaryDirectory();
    let failFlush = false;
    const clearFailure = new FileAttachedTaskMarkerStore(root, {
      flush: () => {
        if (failFlush) throw new Error('injected clear flush failure');
      },
    });
    clearFailure.save(marker());
    failFlush = true;

    expect(() => clearFailure.clear('backend', 'MSG-42', 3)).toThrow(
      /cannot durably clear.*flush failure/i,
    );
    expect(() => clearFailure.load('backend')).toThrow(/durability is indeterminate/i);
    expect(() => clearFailure.save(marker())).toThrow(/durability is indeterminate/i);
    expect(() => clearFailure.clear('backend', 'MSG-42', 3)).toThrow(
      /durability is indeterminate/i,
    );
  });

  it('round-trips the monotonic accepted, written, and completed phases', () => {
    const root = temporaryDirectory();
    const store = new FileAttachedTaskMarkerStore(root);
    const accepted = marker();

    store.save(accepted);
    expect(store.load('backend')).toEqual(accepted);

    const written = marker({
      phase: 'written',
      updatedAt: '2026-07-22T20:00:01.000Z',
    });
    store.save(written);
    expect(store.load('backend')).toEqual(written);

    const completed = marker({
      phase: 'completed',
      receiptSequence: 19,
      updatedAt: '2026-07-22T20:00:02.000Z',
    });
    store.save(completed);
    expect(store.load('backend')).toEqual(completed);

    const markerDirectory = path.join(root, 'backend');
    expect(fs.readdirSync(markerDirectory)).toEqual(['attached-active.json']);
    expect(fs.readFileSync(path.join(markerDirectory, 'attached-active.json'), 'utf8')).toMatch(
      /\n$/,
    );
  });

  it('rejects a different owner and a phase regression without changing durable state', () => {
    const root = temporaryDirectory();
    const store = new FileAttachedTaskMarkerStore(root);
    const completed = marker({ phase: 'completed', receiptSequence: 7 });
    store.save(completed);

    expect(() => store.save(marker({ messageId: 'MSG-OTHER' }))).toThrow(/already owned/);
    expect(() => store.save(marker({ generation: 4 }))).toThrow(/already owned/);
    expect(() => store.save(marker({ phase: 'written' }))).toThrow(/phase regression/);
    expect(store.load('backend')).toEqual(completed);
    expect(fs.readdirSync(path.join(root, 'backend'))).toEqual(['attached-active.json']);
  });

  it('keeps pid and startedAt stable for the lifetime of one marker owner', () => {
    const store = new FileAttachedTaskMarkerStore(temporaryDirectory());
    const accepted = marker();
    store.save(accepted);

    expect(() => store.save(marker({ phase: 'written', pid: 9999 }))).toThrow(
      /pid|stable|owner|immutable|identity/i,
    );
    expect(() =>
      store.save(
        marker({
          phase: 'written',
          startedAt: '2026-07-22T20:00:00.500Z',
          updatedAt: '2026-07-22T20:00:01.000Z',
        }),
      ),
    ).toThrow(/startedAt|stable|owner|immutable|identity/i);
    expect(store.load('backend')).toEqual(accepted);
  });

  it('rejects updatedAt and completion receipt regressions', () => {
    const store = new FileAttachedTaskMarkerStore(temporaryDirectory());
    const written = marker({
      phase: 'written',
      updatedAt: '2026-07-22T20:00:05.000Z',
    });
    store.save(written);

    expect(() =>
      store.save(
        marker({
          phase: 'written',
          updatedAt: '2026-07-22T20:00:04.000Z',
        }),
      ),
    ).toThrow(/updatedAt|regression/i);

    const completed = marker({
      phase: 'completed',
      updatedAt: '2026-07-22T20:00:06.000Z',
      receiptSequence: 12,
    });
    store.save(completed);
    expect(() =>
      store.save(
        marker({
          phase: 'completed',
          updatedAt: '2026-07-22T20:00:07.000Z',
          receiptSequence: 11,
        }),
      ),
    ).toThrow(/receipt|regression/i);
    expect(store.load('backend')).toEqual(completed);
  });

  it('requires a receipt exactly for the completed phase', () => {
    const store = new FileAttachedTaskMarkerStore(temporaryDirectory());

    expect(() => store.save(marker({ phase: 'completed' }))).toThrow(/invalid attached task marker/);
    expect(() => store.save(marker({ phase: 'written', receiptSequence: 1 }))).toThrow(
      /invalid attached task marker/,
    );
    expect(store.load('backend')).toBeUndefined();
  });

  it('clears only the exact terminal, message, and generation owner', () => {
    const store = new FileAttachedTaskMarkerStore(temporaryDirectory());
    store.save(marker());

    expect(store.clear('backend', 'MSG-OTHER', 3)).toBe(false);
    expect(store.clear('backend', 'MSG-42', 4)).toBe(false);
    expect(store.load('backend')).toEqual(marker());
    expect(store.clear('backend', 'MSG-42', 3)).toBe(true);
    expect(store.load('backend')).toBeUndefined();
    expect(store.clear('backend', 'MSG-42', 3)).toBe(false);
  });

  it.each([
    ['terminal traversal', marker({ terminal: '../escape' })],
    ['message traversal', marker({ messageId: '../escape' })],
    ['zero pid', marker({ pid: 0 })],
    ['negative generation', marker({ generation: -1 })],
    ['invalid start timestamp', marker({ startedAt: 'not-a-date' })],
    ['invalid update timestamp', marker({ updatedAt: 'not-a-date' })],
    ['zero completion receipt', marker({ phase: 'completed', receiptSequence: 0 })],
  ])('rejects invalid marker input before it becomes durable: %s', (_label, value) => {
    const root = temporaryDirectory();
    const store = new FileAttachedTaskMarkerStore(root);

    expect(() => store.save(value)).toThrow();
    expect(fs.existsSync(path.join(root, 'backend', 'attached-active.json'))).toBe(false);
  });

  it('fails closed on corrupt, cross-terminal, or structurally invalid durable data', () => {
    const root = temporaryDirectory();
    const directory = path.join(root, 'backend');
    const file = path.join(directory, 'attached-active.json');
    const store = new FileAttachedTaskMarkerStore(root);
    fs.mkdirSync(directory, { recursive: true });

    for (const value of [
      '{not-json',
      JSON.stringify(marker({ terminal: 'frontend' })),
      JSON.stringify({ ...marker(), phase: 'unknown' }),
      JSON.stringify({ ...marker(), receiptSequence: -1 }),
    ]) {
      fs.writeFileSync(file, value, 'utf8');
      expect(() => store.load('backend')).toThrow(/cannot load attached task marker/);
    }
  });

  it('rejects unsafe lookup and clear keys before resolving a filesystem path', () => {
    const store = new FileAttachedTaskMarkerStore(temporaryDirectory());

    expect(() => store.load('../outside')).toThrow(/unsafe terminal marker key/);
    expect(() => store.clear('backend', '../../other', 1)).toThrow(/unsafe message marker key/);
  });
});
