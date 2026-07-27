/**
 * Unit tests for indexer.ts — verifies buildIndex with docs and code files.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIndex } from '../../indexer';
import * as vectorStore from '../../vectorStore';

vi.mock('../../vectorStore', () => ({
  addChunks: vi.fn(async () => undefined),
}));

describe('indexer.ts', () => {
  let tmpDir: string;
  let docsDir: string;
  let codeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-test-'));
    docsDir = path.join(tmpDir, 'docs');
    codeDir = path.join(tmpDir, 'src');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(codeDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('throws when docs directory does not exist', async () => {
    await expect(buildIndex({ docsDir: path.join(tmpDir, 'nonexistent') })).rejects.toThrow(
      'Knowledge base not found'
    );
  });

  it('indexes markdown docs and source code into vector store chunks', async () => {
    const docFile = path.join(docsDir, 'guide.md');
    fs.writeFileSync(docFile, '---\ndomain: architecture\nname: Guide\n---\n# Guide\nSome doc content.', 'utf8');

    const tsFile = path.join(codeDir, 'main.ts');
    fs.writeFileSync(tsFile, 'export function main() { return 42; }', 'utf8');

    const result = await buildIndex({
      docsDir,
      codeDirs: [codeDir],
      includeCode: true,
    });

    expect(result.files).toBe(2);
    expect(result.chunks).toBeGreaterThan(0);
    expect(vectorStore.addChunks).toHaveBeenCalled();
  });
});
