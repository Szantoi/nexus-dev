/**
 * C# extractor: source tree → Module/Class entities + DEPENDS_ON/PART_OF.
 *
 * Deterministic and dependency-free, like the other extractors: there is no
 * Roslyn in Node, so this is a lexical pass, NOT a compiler. It reads exactly
 * the three structural facts that survive without type resolution:
 *   - which namespace(s) a file declares,
 *   - which types it declares (class/interface/record/struct/enum),
 *   - which namespaces it `using`s.
 * A `using` becomes DEPENDS_ON edges to the files that DECLARE that namespace
 * inside the same corpus — an honest module-level dependency. Type-level
 * references need a real compiler and are deliberately out of scope.
 *
 * Comments and string literals are blanked before scanning, so `// class Foo`
 * or "class Foo" in a message never becomes an entity.
 *
 * Known limits (documented, not bugs): nested types are reported as if they
 * were top-level; a type is attributed to the last namespace declared before
 * it (correct for file-scoped and sequential block namespaces, approximate for
 * interleaved ones); C# 11 raw string literals are blanked wholesale.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../../core/logger';
import type { GraphEntity, GraphRelation } from '../types';
import { buildDirChain } from './dirChain';
import type { ExtractionResult } from './docsExtractor';
import { DEFAULT_SKIP_DIRS, repoRelativeId, walkFiles } from './fsWalk';

/** bin/obj are always build output in C#; .g.cs/.Designer.cs are generated. */
const CSHARP_SKIP_DIRS: ReadonlySet<string> = new Set([...DEFAULT_SKIP_DIRS, 'bin', 'obj']);
const GENERATED_SUFFIXES = ['.g.cs', '.generated.cs', '.designer.cs', '.assemblyinfo.cs'];
/** Bound on the users × declarers cross-product a single namespace can create. */
const MAX_DECLARERS_PER_NAMESPACE = 25;

const NAMESPACE_RX = /\bnamespace\s+([A-Za-z_][\w.]*)/g;
/** `using X;`, `global using X;`, `using static X.Y;`, `using Alias = X.Y;` */
const USING_RX = /\b(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/g;
const TYPE_RX = /\b(?:record\s+class|record\s+struct|class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/g;
/**
 * A capture that is a reserved keyword means the regex ran off a declaration —
 * `record` and `where` are only CONTEXTUAL keywords in C#, so `foreach (var
 * record in xs)` and `where T : class where U : struct` both look like
 * declarations to a lexical scan. A reserved word can never be a type name.
 */
const RESERVED_AFTER_KEYWORD = new Set([
  'class', 'interface', 'enum', 'record', 'struct', 'namespace', 'using',
  'in', 'is', 'as', 'switch', 'out', 'ref', 'new', 'null', 'this', 'base',
  'true', 'false', 'if', 'else', 'for', 'foreach', 'while', 'do', 'return',
  'public', 'private', 'protected', 'internal', 'static', 'readonly', 'sealed',
  'abstract', 'virtual', 'override', 'async', 'await', 'void', 'var', 'const',
  'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'byte', 'sbyte', 'char',
  'bool', 'float', 'double', 'decimal', 'string', 'object', 'dynamic',
  'try', 'catch', 'finally', 'throw', 'lock', 'yield', 'default', 'delegate',
  'event', 'operator', 'params', 'partial', 'unsafe', 'fixed', 'where',
]);

/**
 * True when a declaration keyword sits in a generic CONSTRAINT rather than a
 * declaration: in `where T : class where U : struct` the `class`/`struct` is
 * preceded by ':' or ',', which never happens before a real declaration.
 */
function isConstraintPosition(source: string, keywordStart: number): boolean {
  let i = keywordStart - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  return i >= 0 && (source[i] === ':' || source[i] === ',');
}

/**
 * Blank out comments and string literals, preserving offsets and line breaks
 * so later index-based lookups still line up with the original source.
 */
export function stripNonCode(source: string): string {
  const out: string[] = [];
  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out.push(blank(source[i++]));
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/'))
        out.push(blank(source[i++]));
      if (i < source.length) {
        out.push('  ');
        i += 2;
      }
      continue;
    }
    // Raw string literal (C# 11): """ ... """
    if (ch === '"' && next === '"' && source[i + 2] === '"') {
      out.push('   ');
      i += 3;
      while (i < source.length && !(source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"'))
        out.push(blank(source[i++]));
      if (i < source.length) {
        out.push('   ');
        i += 3;
      }
      continue;
    }
    // String literal with any prefix combination: "…", @"…", $"…", $@"…",
    // @$"…". BOTH interpolation orders exist in real C#, and an interpolation
    // hole contains CODE that may itself hold quotes — scanning for the next
    // '"' would end the string early and invert quote parity for the rest of
    // the file, turning real code into blanks (and string text into "code").
    const prefixLength = ch === '@' && next === '$' ? 2 : ch === '$' && next === '@' ? 2 : 1;
    const quoteAt = ch === '@' || ch === '$' ? i + prefixLength : i;
    if ((ch === '@' || ch === '$') && source[quoteAt] === '"') {
      const verbatim = source.slice(i, quoteAt).includes('@');
      const interpolated = source.slice(i, quoteAt).includes('$');
      out.push(' '.repeat(quoteAt - i + 1));
      i = quoteAt + 1;
      let depth = 0;
      while (i < source.length) {
        const c = source[i];
        if (depth === 0) {
          if (c === '"' && source[i + 1] === '"' && verbatim) {
            out.push('  ');
            i += 2;
            continue;
          }
          if (c === '\\' && !verbatim) {
            out.push('  ');
            i += 2;
            continue;
          }
          if (c === '"') {
            out.push(' ');
            i += 1;
            break;
          }
          if (interpolated && c === '{' && source[i + 1] === '{') {
            out.push('  ');
            i += 2;
            continue;
          }
          if (interpolated && c === '{') depth += 1;
        } else {
          // Inside an interpolation hole: still blanked (a hole holds an
          // expression, never a declaration), but braces and nested string
          // literals must be tracked so the hole ends where C# says it does.
          if (c === '"') {
            out.push(' ');
            i += 1;
            while (i < source.length && source[i] !== '"') {
              if (source[i] === '\\') {
                out.push('  ');
                i += 2;
                continue;
              }
              out.push(blank(source[i++]));
            }
            if (i < source.length) {
              out.push(' ');
              i += 1;
            }
            continue;
          }
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
        }
        out.push(blank(source[i++]));
      }
      continue;
    }
    // Plain string / char literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out.push(' ');
      i += 1;
      while (i < source.length && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          out.push('  ');
          i += 2;
          continue;
        }
        out.push(' ');
        i += 1;
      }
      if (i < source.length && source[i] === quote) {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

interface FileFacts {
  namespaces: Array<{ name: string; index: number }>;
  usings: string[];
  types: Array<{ name: string; index: number }>;
}

/** Read the structural facts out of one already-stripped source file. */
export function readCSharpFacts(strippedSource: string): FileFacts {
  const namespaces: Array<{ name: string; index: number }> = [];
  for (const match of strippedSource.matchAll(NAMESPACE_RX)) {
    namespaces.push({ name: match[1], index: match.index ?? 0 });
  }
  const usings = [...strippedSource.matchAll(USING_RX)].map((match) => match[1]);
  const types: Array<{ name: string; index: number }> = [];
  for (const match of strippedSource.matchAll(TYPE_RX)) {
    if (RESERVED_AFTER_KEYWORD.has(match[1])) continue;
    const start = match.index ?? 0;
    if (isConstraintPosition(strippedSource, start)) continue;
    types.push({ name: match[1], index: start });
  }
  return { namespaces, usings, types };
}

/** Namespace a declaration belongs to: the last one opened before it. */
function namespaceAt(facts: FileFacts, index: number): string | undefined {
  let current: string | undefined;
  for (const ns of facts.namespaces) {
    if (ns.index < index) current = ns.name;
    else break;
  }
  return current;
}

export function extractCSharp(srcRoot: string, repoRoot: string): ExtractionResult {
  const files = walkFiles(
    srcRoot,
    (name) => {
      const lower = name.toLowerCase();
      return lower.endsWith('.cs') && !GENERATED_SUFFIXES.some((s) => lower.endsWith(s));
    },
    { skipDirs: CSHARP_SKIP_DIRS }
  );
  const srcRootId = repoRelativeId(repoRoot, srcRoot);

  const entities: GraphEntity[] = [];
  const relations: GraphRelation[] = [];
  const fileIds: string[] = [];
  const factsByFile = new Map<string, FileFacts>();
  /** namespace → files declaring it (a namespace usually spans many files). */
  const declaringFiles = new Map<string, Set<string>>();
  const seenEdges = new Set<string>();
  const cappedNamespaces = new Map<string, number>();

  const addRelation = (from: string, to: string, type: 'DEPENDS_ON' | 'PART_OF'): void => {
    const key = `${type} ${from}→${to}`;
    if (from === to || seenEdges.has(key)) return;
    seenEdges.add(key);
    relations.push({ from, to, type });
  };

  for (const abs of files) {
    const id = repoRelativeId(repoRoot, abs);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const facts = readCSharpFacts(stripNonCode(content));
    fileIds.push(id);
    factsByFile.set(id, facts);
    entities.push({
      id,
      type: 'Module',
      name: path.posix.basename(id, '.cs'),
      filePath: id,
      language: 'csharp',
    });
    for (const ns of facts.namespaces) {
      const declared = declaringFiles.get(ns.name) ?? new Set<string>();
      declared.add(id);
      declaringFiles.set(ns.name, declared);
    }
    for (const type of facts.types) {
      const namespaceName = namespaceAt(facts, type.index);
      // Ids stay path-rooted (every other entity id is a repo-relative path);
      // the fragment keeps partial classes in different files distinct.
      entities.push({
        id: `${id}#${type.name}`,
        type: 'Class',
        name: namespaceName === undefined ? type.name : `${namespaceName}.${type.name}`,
        filePath: id,
        language: 'csharp',
      });
      addRelation(`${id}#${type.name}`, id, 'PART_OF');
    }
  }

  // A `using` is a dependency on whoever declares that namespace here. This is
  // a cross-product (users × declarers), so a hub namespace declared across
  // hundreds of files would blow up quadratically — cap the declarers per
  // namespace, deterministically (sorted), and say so out loud.
  for (const fileId of fileIds) {
    const facts = factsByFile.get(fileId);
    if (facts === undefined) continue;
    for (const used of facts.usings) {
      const declarers = declaringFiles.get(used);
      if (declarers === undefined) continue;
      const capped = [...declarers].sort().slice(0, MAX_DECLARERS_PER_NAMESPACE);
      for (const declaringFile of capped) {
        addRelation(fileId, declaringFile, 'DEPENDS_ON');
      }
      if (declarers.size > MAX_DECLARERS_PER_NAMESPACE) cappedNamespaces.set(used, declarers.size);
    }
  }
  for (const [namespaceName, size] of cappedNamespaces) {
    logger.warn(
      `⚠️  [C#] namespace ${namespaceName} is declared in ${size} files — DEPENDS_ON edges ` +
        `capped at ${MAX_DECLARERS_PER_NAMESPACE} per user (dependency signal kept, fan-out bounded)`
    );
  }

  const chain = buildDirChain(fileIds, srcRootId);
  entities.push(...chain.entities);
  relations.push(...chain.relations);

  return { entities, relations };
}
