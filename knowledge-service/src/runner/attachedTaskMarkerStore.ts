import * as fs from 'node:fs';
import * as path from 'node:path';
import { ValidationError, RuntimeStateError } from '../core/errors';

const SAFE_TERMINAL = /^[a-z][a-z0-9-]*$/;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9._-]+$/;

export interface AttachedTaskMarker {
  version: 1;
  terminal: string;
  messageId: string;
  generation: number;
  pid: number;
  phase: 'accepted' | 'written' | 'completed';
  startedAt: string;
  updatedAt: string;
  receiptSequence?: number;
}

export interface AttachedTaskMarkerStore {
  load(terminal: string): AttachedTaskMarker | undefined;
  save(marker: AttachedTaskMarker): void;
  clear(terminal: string, messageId: string, generation: number): boolean;
}

/**
 * Minimal seam for persisting parent-directory metadata changes. Keeping this
 * operation injectable makes the fail-closed paths testable without replacing
 * the marker file I/O itself.
 */
export interface AttachedMarkerDirectoryDurability {
  flush(directory: string): void;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

const nativeDirectoryDurability: AttachedMarkerDirectoryDurability = {
  flush(directory: string): void {
    let handle: number | undefined;
    try {
      handle = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(handle);
      } catch (error) {
        // Node can open a directory on Windows, but FlushFileBuffers on that
        // handle is not supported. The marker's own fsync above is the Windows
        // durability boundary; only this explicit platform limitation is
        // tolerated. All POSIX errors and unexpected Windows errors fail closed.
        const unsupportedOnWindows =
          process.platform === 'win32' &&
          ['EINVAL', 'ENOTSUP', 'EPERM'].includes(errorCode(error) ?? '');
        if (!unsupportedOnWindows) throw error;
      }
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  },
};

function validateIdentity(terminal: string, messageId?: string): void {
  if (!SAFE_TERMINAL.test(terminal)) throw new ValidationError(`unsafe terminal marker key: ${terminal}`, { terminal: 'invalid format' });
  if (messageId !== undefined && !SAFE_MESSAGE_ID.test(messageId)) {
    throw new ValidationError(`unsafe message marker key: ${messageId}`, { messageId: 'invalid format' });
  }
}

function decodeMarker(raw: string, expectedTerminal: string): AttachedTaskMarker {
  const parsed = JSON.parse(raw) as Partial<AttachedTaskMarker>;
  if (
    parsed.version !== 1 ||
    parsed.terminal !== expectedTerminal ||
    typeof parsed.messageId !== 'string' ||
    !SAFE_MESSAGE_ID.test(parsed.messageId) ||
    !Number.isInteger(parsed.pid) ||
    (parsed.pid ?? 0) < 1 ||
    !Number.isInteger(parsed.generation) ||
    (parsed.generation ?? -1) < 0 ||
    !['accepted', 'written', 'completed'].includes(parsed.phase ?? '') ||
    typeof parsed.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.startedAt)) ||
    typeof parsed.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.updatedAt)) ||
    Date.parse(parsed.updatedAt) < Date.parse(parsed.startedAt) ||
    (parsed.receiptSequence !== undefined &&
      (!Number.isInteger(parsed.receiptSequence) || parsed.receiptSequence < 1)) ||
    (parsed.phase === 'completed') !== (parsed.receiptSequence !== undefined)
  ) {
    throw new RuntimeStateError(`invalid attached task marker for terminal: ${expectedTerminal}`, expectedTerminal);
  }
  return parsed as AttachedTaskMarker;
}

/** Durable, fail-closed marker store used before any attached PTY task write. */
export class FileAttachedTaskMarkerStore implements AttachedTaskMarkerStore {
  private readonly indeterminateTerminals = new Map<string, string>();

  constructor(
    private readonly logDirectory: string,
    private readonly directoryDurability: AttachedMarkerDirectoryDurability =
      nativeDirectoryDurability,
  ) {}

  load(terminal: string): AttachedTaskMarker | undefined {
    const markerPath = this.markerPath(terminal);
    this.assertDeterminate(terminal);
    if (!fs.existsSync(markerPath)) return undefined;
    try {
      return decodeMarker(fs.readFileSync(markerPath, 'utf8'), terminal);
    } catch (error) {
      throw new RuntimeStateError(
        `cannot load attached task marker (${markerPath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        terminal,
      );
    }
  }

  save(marker: AttachedTaskMarker): void {
    validateIdentity(marker.terminal, marker.messageId);
    this.assertDeterminate(marker.terminal);
    decodeMarker(JSON.stringify(marker), marker.terminal);
    const previous = this.load(marker.terminal);
    if (
      previous &&
      (previous.messageId !== marker.messageId || previous.generation !== marker.generation)
    ) {
      throw new RuntimeStateError(`attached task marker already owned by ${previous.messageId}`, marker.terminal);
    }
    if (
      previous &&
      (previous.pid !== marker.pid || previous.startedAt !== marker.startedAt)
    ) {
      throw new RuntimeStateError('attached task marker immutable identity changed', marker.terminal);
    }
    const phaseOrder = { accepted: 0, written: 1, completed: 2 } as const;
    if (previous && phaseOrder[marker.phase] < phaseOrder[previous.phase]) {
      throw new RuntimeStateError(`attached task marker phase regression: ${previous.phase} -> ${marker.phase}`, marker.terminal);
    }
    if (previous && Date.parse(marker.updatedAt) < Date.parse(previous.updatedAt)) {
      throw new RuntimeStateError('attached task marker timestamp regression', marker.terminal);
    }
    if (
      previous?.receiptSequence !== undefined &&
      marker.receiptSequence !== previous.receiptSequence
    ) {
      throw new RuntimeStateError('attached task marker receipt mutation', marker.terminal);
    }
    const markerPath = this.markerPath(marker.terminal);
    const directory = path.dirname(markerPath);
    const missingDirectories = previous ? [] : this.missingDirectoryChain(directory);
    fs.mkdirSync(directory, { recursive: true });
    const serialized = `${JSON.stringify(marker)}\n`;
    // `rename` cannot portably replace an existing file on Windows. Create the
    // first marker exclusively, then update the same inode/handle. A crash can
    // leave invalid JSON, but never an absent marker; the next startup then
    // fails closed and requires reconciliation instead of redispatching.
    const flags = previous ? 'r+' : 'wx';
    let handle: number | undefined;
    try {
      handle = fs.openSync(markerPath, flags, 0o600);
      fs.writeSync(handle, serialized, 0, 'utf8');
      fs.ftruncateSync(handle, Buffer.byteLength(serialized));
      fs.fsyncSync(handle);
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
    if (!previous) {
      // First persist the marker entry in the leaf directory. For every
      // directory created by recursive mkdir, persist that directory entry in
      // its own parent as well. `missingDirectories` is leaf-to-ancestor, so
      // this ordering never claims an ancestor durable before its child.
      const flushTargets = [directory, ...missingDirectories.map((entry) => path.dirname(entry))];
      for (const target of new Set(flushTargets)) {
        this.flushDirectory(marker.terminal, target, 'create');
      }
    }
  }

  clear(terminal: string, messageId: string, generation: number): boolean {
    validateIdentity(terminal, messageId);
    this.assertDeterminate(terminal);
    const current = this.load(terminal);
    if (
      !current ||
      current.messageId !== messageId ||
      current.generation !== generation
    ) {
      return false;
    }
    const markerPath = this.markerPath(terminal);
    fs.rmSync(markerPath);
    this.flushDirectory(terminal, path.dirname(markerPath), 'clear');
    return true;
  }

  private assertDeterminate(terminal: string): void {
    const reason = this.indeterminateTerminals.get(terminal);
    if (reason !== undefined) {
      throw new RuntimeStateError(`attached task marker durability is indeterminate for ${terminal}: ${reason}`, terminal);
    }
  }

  private missingDirectoryChain(directory: string): string[] {
    const missing: string[] = [];
    let current = directory;
    while (!fs.existsSync(current)) {
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return missing;
  }

  private flushDirectory(
    terminal: string,
    directory: string,
    operation: 'create' | 'clear',
  ): void {
    try {
      this.directoryDurability.flush(directory);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.indeterminateTerminals.set(
        terminal,
        `${operation} directory flush failed (${directory}): ${detail}`,
      );
      throw new RuntimeStateError(
        `cannot durably ${operation} attached task marker (${directory}): ${detail}`,
        terminal,
      );
    }
  }

  private markerPath(terminal: string): string {
    validateIdentity(terminal);
    return path.join(this.logDirectory, terminal, 'attached-active.json');
  }
}
