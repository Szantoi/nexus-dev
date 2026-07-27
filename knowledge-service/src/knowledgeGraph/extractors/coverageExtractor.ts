/**
 * Coverage extractor: vitest istanbul coverage output (coverage-final.json)
 * + TypeScript test import analysis → Module entities + COVERS relations.
 *
 * Maps test modules to the source modules they cover during execution:
 * (test_module: Module) -[:COVERS]-> (source_module: Module)
 *
 * Fail-closed:
 * If the coverage JSON file is missing or empty, this extractor throws a
 * CoverageFileNotFoundError or CoverageDataEmptyError so index runs fail closed
 * rather than producing an incomplete or empty graph.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { GraphEntity, GraphRelation } from '../types';
import type { ExtractionResult } from './docsExtractor';
import { repoRelativeId, walkFiles } from './fsWalk';
import { resolveImport } from './tsExtractor';

export class CoverageFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`Coverage file missing at "${filePath}". Run "npm run test:coverage" first.`);
    this.name = 'CoverageFileNotFoundError';
  }
}

export class CoverageDataEmptyError extends Error {
  constructor(filePath: string) {
    super(`Coverage file at "${filePath}" contains no covered files. Run "npm run test:coverage" first.`);
    this.name = 'CoverageDataEmptyError';
  }
}

/** Check if an istanbul coverage entry has at least one executed statement. */
function hasStatementHits(fileCov: { s?: Record<string, number> } | undefined): boolean {
  if (!fileCov?.s) return false;
  for (const count of Object.values(fileCov.s)) {
    if (typeof count === 'number' && count > 0) return true;
  }
  return false;
}

/** Extract relative import specifiers from a parsed TypeScript AST. */
function moduleSpecifiersOf(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** Trace all transitive relative TypeScript imports starting from `startAbsFile`. */
function getTransitiveRelativeImports(startAbsFile: string): Set<string> {
  const visited = new Set<string>();
  const stack = [startAbsFile];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let content: string;
    try {
      content = fs.readFileSync(current, 'utf8');
    } catch {
      continue;
    }

    const sourceFile = ts.createSourceFile(current, content, ts.ScriptTarget.Latest, false);
    for (const specifier of moduleSpecifiersOf(sourceFile)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveImport(current, specifier);
      if (resolved !== null && !visited.has(resolved)) {
        stack.push(resolved);
      }
    }
  }
  return visited;
}

/**
 * Extract COVERS relations from `coverage-final.json`.
 * `coverageRoot` can be a directory containing `coverage-final.json` or a direct path to a JSON file.
 */
export function extractCoverage(coverageRoot: string, repoRoot: string): ExtractionResult {
  const coverageFilePath =
    coverageRoot.endsWith('.json') && fs.existsSync(coverageRoot)
      ? coverageRoot
      : path.join(coverageRoot, 'coverage-final.json');

  if (!fs.existsSync(coverageFilePath)) {
    throw new CoverageFileNotFoundError(coverageFilePath);
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(coverageFilePath, 'utf8');
  } catch {
    throw new CoverageFileNotFoundError(coverageFilePath);
  }

  let coverageData: Record<string, { path?: string; s?: Record<string, number> }>;
  try {
    coverageData = JSON.parse(rawContent);
  } catch {
    throw new CoverageDataEmptyError(coverageFilePath);
  }

  if (!coverageData || typeof coverageData !== 'object' || Object.keys(coverageData).length === 0) {
    throw new CoverageDataEmptyError(coverageFilePath);
  }

  const coveredSourceFiles = new Set<string>();
  for (const [absOrRelPath, fileCov] of Object.entries(coverageData)) {
    if (!hasStatementHits(fileCov)) continue;
    const absPath = fileCov.path ?? absOrRelPath;
    const resolvedAbs = path.isAbsolute(absPath) ? absPath : path.resolve(repoRoot, absPath);
    const relId = repoRelativeId(repoRoot, resolvedAbs);
    coveredSourceFiles.add(relId);
  }

  if (coveredSourceFiles.size === 0) {
    throw new CoverageDataEmptyError(coverageFilePath);
  }

  // Find test files in the codebase (under repoRoot)
  const testFiles = walkFiles(
    repoRoot,
    (fileName) => /\.(test|spec)\.tsx?$/.test(fileName) && !fileName.endsWith('.d.ts')
  );

  const entitiesMap = new Map<string, GraphEntity>();
  const relationsMap = new Map<string, GraphRelation>();

  for (const testAbs of testFiles) {
    const testId = repoRelativeId(repoRoot, testAbs);
    const transitiveImports = getTransitiveRelativeImports(testAbs);

    let hasCovers = false;
    for (const importedAbs of transitiveImports) {
      const importedId = repoRelativeId(repoRoot, importedAbs);
      if (importedId === testId) continue;
      if (coveredSourceFiles.has(importedId)) {
        hasCovers = true;
        const relKey = `COVERS ${testId}→${importedId}`;
        if (!relationsMap.has(relKey)) {
          relationsMap.set(relKey, {
            from: testId,
            to: importedId,
            type: 'COVERS',
          });
        }
        if (!entitiesMap.has(importedId)) {
          const lang = importedId.endsWith('.cs') ? 'csharp' : importedId.endsWith('.md') ? 'markdown' : 'typescript';
          entitiesMap.set(importedId, {
            id: importedId,
            type: 'Module',
            name: path.posix.basename(importedId).replace(/\.(tsx?|jsx?|cs|md)$/, ''),
            filePath: importedId,
            language: lang,
          });
        }
      }
    }

    if (hasCovers && !entitiesMap.has(testId)) {
      entitiesMap.set(testId, {
        id: testId,
        type: 'Module',
        name: path.posix.basename(testId).replace(/\.tsx?$/, ''),
        filePath: testId,
        language: 'typescript',
      });
    }
  }

  const entities = Array.from(entitiesMap.values()).sort((a, b) => a.id.localeCompare(b.id));
  const relations = Array.from(relationsMap.values()).sort((a, b) => {
    const c = a.from.localeCompare(b.from);
    return c !== 0 ? c : a.to.localeCompare(b.to);
  });

  return { entities, relations };
}
