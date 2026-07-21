/**
 * memoryTools unit tests — hermetic via an fs redirect.
 *
 * memoryTools.ts pins MEMORY_DIR relative to its own __dirname
 * (<src>/../../../docs/memory) with NO env override, so a temp fixture tree
 * cannot be pointed at it directly. These tests wrap the 'fs' module: any
 * path under that real MEMORY_DIR is redirected into a per-run sandbox in
 * os.tmpdir(); all other paths pass through untouched. Nothing is ever
 * written outside the tmpdir.
 *
 * PINS the memory-maintenance contract:
 *  - getMemoryHealthReport: per-terminal size/threshold status
 *    (>=95% of 200KB critical, >=80% warning), staleness and duplicate-ratio
 *    driven suggested actions, MEMORY_FORMAT.md exclusion, fleet warnings
 *  - compressMemory: dry-run default leaves the file untouched; real run
 *    archives the original and rewrites the file; strategy pattern sets;
 *    unknown terminal throws; empty file -> 0 ratio
 *  - extractPatterns: decision/workflow/error_resolution regexes, frequency
 *    threshold (default 3), tier suggestion (>5 shared, >=3 warm),
 *    single-terminal vs 'all' scanning, missing files skipped
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pathMod = require('path');
  const runId = crypto.randomBytes(6).toString('hex');
  // memoryTools.ts lives in src/ and resolves MEMORY_DIR = src/../../../docs/memory
  const srcDir = pathMod.resolve(__dirname, '..', '..');
  const realMemoryDir = pathMod.normalize(pathMod.join(srcDir, '..', '..', '..', 'docs', 'memory'));
  const sandbox = pathMod.join(os.tmpdir(), `memtools-${runId}`);
  return { realMemoryDir, sandbox };
});

vi.mock('fs', async (importOriginal) => {
  type Fs = typeof import('fs');
  const actual = await importOriginal<Fs>();
  // Compare with forward slashes + lowercase: Windows paths are case-insensitive
  const prefix = H.realMemoryDir.replace(/\\/g, '/').toLowerCase();
  const redirect = (p: unknown): unknown => {
    if (typeof p !== 'string') return p;
    const norm = p.replace(/\\/g, '/');
    if (norm.toLowerCase().startsWith(prefix)) {
      return `${H.sandbox}/${norm.slice(prefix.length).replace(/^\//, '')}`;
    }
    return p;
  };
  const r = (p: unknown) => redirect(p) as import('fs').PathLike;
  return {
    ...actual,
    existsSync: ((p: unknown) => actual.existsSync(r(p))) as Fs['existsSync'],
    readdirSync: ((p: unknown, o?: unknown) =>
      actual.readdirSync(r(p), o as BufferEncoding)) as unknown as Fs['readdirSync'],
    readFileSync: ((p: unknown, o?: unknown) =>
      actual.readFileSync(r(p), o as BufferEncoding)) as unknown as Fs['readFileSync'],
    writeFileSync: ((p: unknown, d: unknown, o?: unknown) =>
      actual.writeFileSync(r(p), d as string, o as BufferEncoding)) as unknown as Fs['writeFileSync'],
    mkdirSync: ((p: unknown, o?: unknown) =>
      actual.mkdirSync(r(p), o as import('fs').MakeDirectoryOptions)) as unknown as Fs['mkdirSync'],
    statSync: ((p: unknown) => actual.statSync(r(p))) as unknown as Fs['statSync'],
  };
});

import * as fs from 'fs'; // wrapped module: sandbox paths pass through untouched

let mt: typeof import('../../memoryTools');

/** Write a fixture that memoryTools will see at MEMORY_DIR/<name>. */
function writeMemory(name: string, content: string): string {
  const p = path.join(H.sandbox, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

beforeAll(async () => {
  mt = await import('../../memoryTools');
});

afterAll(() => {
  try { fs.rmSync(H.sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── Missing memory dir (runs before fixtures exist) ────────────────────────

describe('missing memory directory', () => {
  it('health report is empty, extractPatterns finds nothing, compress throws', async () => {
    const report = await mt.getMemoryHealthReport();
    expect(report).toEqual({ terminals: [], system_total_kb: 0, warnings: [] });

    const all = await mt.extractPatterns({ terminal: 'all', pattern_types: ['decision'] });
    expect(all).toEqual({ patterns: [], total_patterns_found: 0, terminals_scanned: [] });

    const ghost = await mt.extractPatterns({ terminal: 'ghost', pattern_types: ['decision'] });
    expect(ghost.terminals_scanned).toEqual(['ghost']); // named terminal scanned even if file missing
    expect(ghost.patterns).toEqual([]);

    await expect(mt.compressMemory({ terminal: 'ghost', strategy: 'moderate' }))
      .rejects.toThrow('Memory file not found for terminal: ghost');
  });
});

// ─── Health report ──────────────────────────────────────────────────────────

describe('getMemoryHealthReport', () => {
  beforeAll(() => {
    // Healthy small file with extractable patterns (used again below)
    writeMemory('conductor.md', [
      '# Conductor Memory',
      '',
      'Decision: use SQLite for workflow state persistence',
      'some filler',
      'Decision: use SQLite for workflow state persistence',
      'more filler',
      'Decision: use SQLite for workflow state persistence',
      '',
      '## Workflow',
      '1. read inbox',
      '2. dispatch task',
      '',
      'Error: build failed on Windows Fix: normalize path separators',
      '',
    ].join('\n'));

    // Critical: > 95% of 200KB threshold
    writeMemory('bloated.md', `# Bloated\n${'x'.repeat(195 * 1024)}\n`);

    // Warning + duplicates > 0.3 -> compress suggestion
    const dupLine = 'This exact substantial line repeats far too many times in memory';
    writeMemory('duplicated.md', `# Dup\n${`${dupLine}\n`.repeat(8)}${'y'.repeat(170 * 1024)}\n`);

    // Stale (> 60 days) -> archive suggestion
    const stalePath = writeMemory('stale.md', '# Stale memory\nnothing new here for a long time\n');
    const seventyDaysAgo = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stalePath, seventyDaysAgo, seventyDaysAgo);

    // Excluded from the terminal list by name
    writeMemory('MEMORY_FORMAT.md', '# Format doc, not a terminal\n');
  });

  it('reports per-terminal status, thresholds, and suggested actions', async () => {
    const report = await mt.getMemoryHealthReport();
    const byName = Object.fromEntries(report.terminals.map(t => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(['bloated', 'conductor', 'duplicated', 'stale']);
    expect(byName.MEMORY_FORMAT).toBeUndefined();

    expect(byName.conductor.status).toBe('ok');
    expect(byName.conductor.threshold_kb).toBe(200);
    expect(byName.conductor.suggested_action).toBe('none');

    expect(byName.bloated.status).toBe('critical');
    expect(byName.bloated.suggested_action).toBe('cleanup');
    expect(byName.bloated.size_kb).toBeGreaterThan(190);

    expect(byName.duplicated.status).toBe('warning');
    expect(byName.duplicated.duplicate_ratio).toBeGreaterThan(0.3);
    expect(byName.duplicated.suggested_action).toBe('compress');

    expect(byName.stale.status).toBe('ok');
    expect(byName.stale.staleness_days).toBeGreaterThanOrEqual(69);
    expect(byName.stale.suggested_action).toBe('archive');

    expect(report.system_total_kb).toBeGreaterThan(300); // bloated + duplicated dominate
    expect(report.warnings.some(w => w.includes('bloated CRITICAL'))).toBe(true);
    expect(report.warnings.some(w => w.includes('duplicated approaching threshold'))).toBe(true);
    expect(report.warnings.some(w => w.includes('stale content'))).toBe(true);
  });
});

// ─── Compression ────────────────────────────────────────────────────────────

describe('compressMemory', () => {
  const NIGHTWATCH_BODY = [
    '# Terminal Memory',
    '',
    '## Key Decisions',
    'Keep this section.',
    '',
    '## Nightwatch Cycle #12',
    'noise noise noise',
    'more noise',
    '',
    '',
    '',
    '## Review Log',
    'review noise',
    '',
    '## Strategic Context',
    'Also keep this.',
    '',
  ].join('\n');

  it('dry run (default) reports reduction but leaves the file untouched', async () => {
    writeMemory('compress-dry.md', NIGHTWATCH_BODY);

    const result = await mt.compressMemory({ terminal: 'compress-dry', strategy: 'conservative' });
    expect(result.dry_run).toBe(true);
    expect(result.success).toBe(true);
    expect(result.original_size_kb).toBeGreaterThan(0);
    expect(result.compressed_size_kb).toBeLessThan(result.original_size_kb);
    expect(result.reduction_ratio).toBeGreaterThan(0);
    expect(result.archived_content_summary).toContain('(conservative strategy)');
    expect(result.preview.endsWith('...')).toBe(true);

    // File untouched on disk
    expect(fs.readFileSync(path.join(H.sandbox, 'compress-dry.md'), 'utf-8')).toBe(NIGHTWATCH_BODY);
  });

  it('real run archives the original and rewrites the compressed file', async () => {
    writeMemory('compress-real.md', NIGHTWATCH_BODY);

    const result = await mt.compressMemory({ terminal: 'compress-real', strategy: 'aggressive', dry_run: false });
    expect(result.dry_run).toBe(false);

    // Archive holds the ORIGINAL content, named <terminal>_<date>.md
    const today = new Date().toISOString().split('T')[0];
    const archivePath = path.join(H.sandbox, 'archive', `compress-real_${today}.md`);
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.readFileSync(archivePath, 'utf-8')).toBe(NIGHTWATCH_BODY);

    // Main file rewritten: garbage sections gone, preserved sections intact,
    // no 3+ consecutive newlines left
    const compressed = fs.readFileSync(path.join(H.sandbox, 'compress-real.md'), 'utf-8');
    expect(compressed).not.toContain('Nightwatch Cycle #12');
    expect(compressed).not.toContain('review noise');
    expect(compressed).toContain('Keep this section.');
    expect(compressed).not.toMatch(/\n{3,}/);
    expect(compressed.length).toBeLessThan(NIGHTWATCH_BODY.length);
  });

  it('unknown strategy falls back to no pattern removal (only blank-line squeeze)', async () => {
    writeMemory('compress-weird.md', NIGHTWATCH_BODY);
    const result = await mt.compressMemory({
      terminal: 'compress-weird',
      strategy: 'weird' as unknown as 'moderate',
    });
    expect(result.success).toBe(true);
    expect(result.archived_content_summary).toContain('Removed 0 sections');
  });

  it('empty file -> zero sizes and zero reduction ratio', async () => {
    writeMemory('compress-empty.md', '');
    const result = await mt.compressMemory({ terminal: 'compress-empty', strategy: 'moderate' });
    expect(result.original_size_kb).toBe(0);
    expect(result.reduction_ratio).toBe(0);
  });

  it('throws for a terminal without a memory file', async () => {
    await expect(mt.compressMemory({ terminal: 'no-such-terminal', strategy: 'moderate' }))
      .rejects.toThrow('Memory file not found for terminal: no-such-terminal');
  });
});

// ─── Pattern extraction ─────────────────────────────────────────────────────

describe('extractPatterns', () => {
  beforeAll(() => {
    // 6 identical decision lines -> frequency 6 -> 'shared' tier
    writeMemory('decisive.md', [
      '# Decisive',
      ...Array(6).fill('Decision: Adopt Vitest Forks Runner everywhere'),
      '',
    ].join('\n'));
  });

  it('default min_frequency=3 keeps only repeating patterns; tiers by frequency', async () => {
    const result = await mt.extractPatterns({ terminal: 'all', pattern_types: ['decision'] });

    // conductor.md has the SQLite decision 3x -> warm; decisive.md 6x -> shared
    const sqlite = result.patterns.find(p => p.content.includes('SQLite'));
    expect(sqlite).toBeTruthy();
    expect(sqlite!.frequency).toBe(3);
    expect(sqlite!.suggested_tier).toBe('warm');
    expect(sqlite!.terminals).toEqual(['conductor']);

    const adopt = result.patterns.find(p => p.content.includes('Adopt Vitest'));
    expect(adopt!.frequency).toBe(6);
    expect(adopt!.suggested_tier).toBe('shared');
    expect(adopt!.suggested_doc.endsWith('_PATTERN.md')).toBe(true);
    expect(adopt!.suggested_doc).toBe('DECISION_ADOPT_VITEST_PATTERN.md'); // first 3 capitalized words

    // Sorted by frequency descending
    expect(result.patterns[0].frequency).toBeGreaterThanOrEqual(result.patterns[result.patterns.length - 1].frequency);
    expect(result.total_patterns_found).toBe(result.patterns.length);
    expect(result.terminals_scanned).toContain('conductor');
    expect(result.terminals_scanned).toContain('decisive');
  });

  it('min_frequency=1 surfaces workflow and error_resolution patterns too', async () => {
    const result = await mt.extractPatterns({
      terminal: 'conductor',
      min_frequency: 1,
      pattern_types: ['workflow', 'error_resolution'],
    });
    expect(result.terminals_scanned).toEqual(['conductor']);
    expect(result.patterns.some(p => p.type === 'workflow')).toBe(true);
    const err = result.patterns.find(p => p.type === 'error_resolution');
    expect(err).toBeTruthy();
    expect(err!.content).toContain('build failed');
  });

  it('a high min_frequency filters everything out', async () => {
    const result = await mt.extractPatterns({ terminal: 'all', min_frequency: 100, pattern_types: ['decision'] });
    expect(result.patterns).toEqual([]);
    expect(result.total_patterns_found).toBe(0);
  });
});
