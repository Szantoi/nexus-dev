/**
 * Unit tests for coverageExtractor — extracts COVERS relations from coverage-final.json
 * and TypeScript test import trees.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CoverageDataEmptyError,
  CoverageFileNotFoundError,
  extractCoverage,
} from '../../knowledgeGraph/extractors/coverageExtractor';

describe('coverageExtractor', () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-test-'));
    repoRoot = tmpDir;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('throws CoverageFileNotFoundError when coverage file does not exist', () => {
    const coverageDir = path.join(tmpDir, 'coverage');
    expect(() => extractCoverage(coverageDir, repoRoot)).toThrow(CoverageFileNotFoundError);
  });

  it('throws CoverageDataEmptyError when coverage JSON is empty or invalid', () => {
    const coverageDir = path.join(tmpDir, 'coverage');
    fs.mkdirSync(coverageDir, { recursive: true });
    const coverageFile = path.join(coverageDir, 'coverage-final.json');
    fs.writeFileSync(coverageFile, '{}', 'utf8');

    expect(() => extractCoverage(coverageDir, repoRoot)).toThrow(CoverageDataEmptyError);
  });

  it('throws CoverageDataEmptyError when no files have > 0 statement hits', () => {
    const coverageDir = path.join(tmpDir, 'coverage');
    fs.mkdirSync(coverageDir, { recursive: true });
    const coverageFile = path.join(coverageDir, 'coverage-final.json');
    const mockCoverage = {
      [path.join(tmpDir, 'src', 'unhit.ts')]: {
        path: path.join(tmpDir, 'src', 'unhit.ts'),
        s: { '0': 0, '1': 0 },
      },
    };
    fs.writeFileSync(coverageFile, JSON.stringify(mockCoverage), 'utf8');

    expect(() => extractCoverage(coverageDir, repoRoot)).toThrow(CoverageDataEmptyError);
  });

  it('extracts COVERS relations between test modules and covered source modules', () => {
    const srcDir = path.join(tmpDir, 'src');
    const testsDir = path.join(srcDir, '__tests__');
    fs.mkdirSync(testsDir, { recursive: true });

    const targetTs = path.join(srcDir, 'target.ts');
    const utilsTs = path.join(srcDir, 'utils.ts');
    const testTs = path.join(testsDir, 'target.test.ts');

    fs.writeFileSync(targetTs, `import { helper } from './utils';\nexport function foo() { return helper(); }`, 'utf8');
    fs.writeFileSync(utilsTs, `export function helper() { return 42; }`, 'utf8');
    fs.writeFileSync(testTs, `import { foo } from '../target';\ntest('foo', () => foo());`, 'utf8');

    const coverageDir = path.join(tmpDir, 'coverage');
    fs.mkdirSync(coverageDir, { recursive: true });
    const coverageFile = path.join(coverageDir, 'coverage-final.json');

    const mockCoverage = {
      [targetTs]: { path: targetTs, s: { '0': 1, '1': 1 } },
      [utilsTs]: { path: utilsTs, s: { '0': 1 } },
    };
    fs.writeFileSync(coverageFile, JSON.stringify(mockCoverage), 'utf8');

    const result = extractCoverage(coverageDir, repoRoot);

    expect(result.relations).toEqual([
      {
        from: 'src/__tests__/target.test.ts',
        to: 'src/target.ts',
        type: 'COVERS',
      },
      {
        from: 'src/__tests__/target.test.ts',
        to: 'src/utils.ts',
        type: 'COVERS',
      },
    ]);

    expect(result.entities).toEqual([
      {
        filePath: 'src/__tests__/target.test.ts',
        id: 'src/__tests__/target.test.ts',
        language: 'typescript',
        name: 'target.test',
        type: 'Module',
      },
      {
        filePath: 'src/target.ts',
        id: 'src/target.ts',
        language: 'typescript',
        name: 'target',
        type: 'Module',
      },
      {
        filePath: 'src/utils.ts',
        id: 'src/utils.ts',
        language: 'typescript',
        name: 'utils',
        type: 'Module',
      },
    ]);
  });
});
