/** Persisted per-stream cursors for durable completion receipt replay. */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface CompletionCursorFile {
  version: 1;
  cursors: Record<string, number>;
}

function isCursorFile(value: unknown): value is CompletionCursorFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<CompletionCursorFile>;
  if (candidate.version !== 1 || typeof candidate.cursors !== 'object' || candidate.cursors === null) {
    return false;
  }
  return Object.values(candidate.cursors).every(
    (cursor) => Number.isSafeInteger(cursor) && cursor >= 0,
  );
}

export class CompletionCursorStore {
  private cursors: Record<string, number> = Object.create(null) as Record<string, number>;

  constructor(private readonly filePath: string) {}

  load(): 'loaded' | 'missing' | 'corrupt' {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (!isCursorFile(parsed)) {
        this.cursors = Object.create(null) as Record<string, number>;
        return 'corrupt';
      }
      this.cursors = Object.assign(
        Object.create(null) as Record<string, number>,
        parsed.cursors,
      );
      return 'loaded';
    } catch (error) {
      this.cursors = Object.create(null) as Record<string, number>;
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt';
    }
  }

  get(streamKey: string): number {
    return this.cursors[streamKey] ?? 0;
  }

  /** Monotonic advance plus atomic file replacement; cursor regression fails closed. */
  advance(streamKey: string, cursor: number): void {
    if (!streamKey) throw new Error('Completion cursor stream key must be non-empty');
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new RangeError('Completion cursor must be a non-negative safe integer');
    }
    const current = this.get(streamKey);
    if (cursor < current) {
      throw new Error(`Completion cursor regression for ${streamKey}: ${cursor} < ${current}`);
    }
    if (cursor === current) return;

    const hadCurrent = Object.getOwnPropertyDescriptor(this.cursors, streamKey) !== undefined;
    this.cursors[streamKey] = cursor;
    const payload: CompletionCursorFile = { version: 1, cursors: this.cursors };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf-8');
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (hadCurrent) this.cursors[streamKey] = current;
      else delete this.cursors[streamKey];
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
}
