/**
 * TypeScript extractor: source tree → Module entities + DEPENDS_ON/PART_OF.
 *
 * Uses the TypeScript compiler's parser only (createSourceFile — no type
 * checking, no tsconfig resolution): each file becomes a Module entity, each
 * RELATIVE import/re-export becomes a DEPENDS_ON edge, and each file is
 * PART_OF its directory. Package imports are ignored on purpose — external
 * dependency hygiene belongs to npm audit, not the knowledge graph.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { GraphEntity, GraphRelation } from '../types';
import { buildDirChain } from './dirChain';
import type { ExtractionResult } from './docsExtractor';
import { repoRelativeId, walkFiles } from './fsWalk';

/** Resolve a relative import specifier to an existing file, TS-style. */
export function resolveImport(fromAbsFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromAbsFile), specifier);
  // ESM-style specifiers name the EMITTED file ('./x.js'), but the graph is a
  // SOURCE graph — the .ts must win over a compiled sibling lying next to it.
  const emittedSource = /\.jsx?$/.test(base)
    ? [base.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx')]
    : [];
  const candidates = [
    ...emittedSource,
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep trying
    }
  }
  return null;
}

/** Import/re-export module specifiers of one parsed source file. */
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

/**
 * Extract entities + relations from every .ts/.tsx file under `srcRoot`
 * (declaration files excluded). Directory entities are created for each
 * parent directory so module-level impact questions work out of the box.
 */
export function extractTypeScript(srcRoot: string, repoRoot: string): ExtractionResult {
  const files = walkFiles(
    srcRoot,
    (name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts')
  );

  const srcRootId = repoRelativeId(repoRoot, srcRoot);
  const entities: GraphEntity[] = [];
  const relations: GraphRelation[] = [];
  const fileIds = new Set<string>();
  const seenEdges = new Set<string>();

  const addRelation = (from: string, to: string, type: 'DEPENDS_ON' | 'PART_OF'): void => {
    const dedupKey = `${type} ${from}→${to}`;
    if (seenEdges.has(dedupKey)) return;
    seenEdges.add(dedupKey);
    relations.push({ from, to, type });
  };

  for (const abs of files) {
    const id = repoRelativeId(repoRoot, abs);
    fileIds.add(id);
    entities.push({
      id,
      type: 'Module',
      name: path.posix.basename(id).replace(/\.tsx?$/, ''),
      filePath: id,
      language: 'typescript',
    });
  }

  for (const abs of files) {
    const fromId = repoRelativeId(repoRoot, abs);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const sourceFile = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, false);
    for (const specifier of moduleSpecifiersOf(sourceFile)) {
      if (!specifier.startsWith('.')) continue; // package import — ignored
      const resolved = resolveImport(abs, specifier);
      if (resolved === null) continue;
      const toId = repoRelativeId(repoRoot, resolved);
      if (fileIds.has(toId) && toId !== fromId) {
        addRelation(fromId, toId, 'DEPENDS_ON');
      }
    }
  }

  // Directory containment is language-independent — shared with every other
  // extractor so the graph's shape does not depend on who produced it.
  const chain = buildDirChain([...fileIds], srcRootId);
  entities.push(...chain.entities);
  relations.push(...chain.relations);

  return { entities, relations };
}
