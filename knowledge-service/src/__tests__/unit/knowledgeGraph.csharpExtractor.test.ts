/**
 * C# extractor tests — real files in a temp fixture tree (no mocks).
 *
 * The extractor is lexical, not a compiler, so the tests concentrate on the
 * two things that can silently go wrong in a lexical pass: picking up
 * declarations that are actually comments/strings, and mis-attributing a type
 * to the wrong namespace.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractCSharp,
  readCSharpFacts,
  stripNonCode,
} from '../../knowledgeGraph/extractors/csharpExtractor';
import type { GraphRelation } from '../../knowledgeGraph/types';

let repoRoot: string;

function write(relPath: string, content: string): void {
  const abs = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function rel(relations: GraphRelation[], type: string): Array<[string, string]> {
  return relations.filter((r) => r.type === type).map((r) => [r.from, r.to]);
}

function extract() {
  return extractCSharp(path.join(repoRoot, 'src'), repoRoot);
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-cs-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('stripNonCode', () => {
  it('blanks comments and strings while keeping line structure', () => {
    const source = [
      '// class Commented',
      'class Real {',
      '  var s = "class InString";',
      '  /* class InBlock */',
      '  var v = @"class ""InVerbatim""";',
      '}',
    ].join('\n');
    const stripped = stripNonCode(source);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    expect(stripped).toContain('class Real');
    for (const ghost of ['Commented', 'InString', 'InBlock', 'InVerbatim']) {
      expect(stripped).not.toContain(ghost);
    }
  });

  it('keeps quote parity across interpolated strings with nested literals', () => {
    // A naive scan ends the string at the inner quote and inverts parity for
    // the whole rest of the file: real declarations then vanish into "string".
    const source = [
      'var msg = $"got {Format("x")} items for {user.Name}";',
      'class AfterInterpolation { }',
    ].join('\n');
    const stripped = stripNonCode(source);
    expect(stripped).not.toContain('got');
    expect(stripped).not.toContain('Format');
    expect(stripped).toContain('class AfterInterpolation');
  });

  it('handles BOTH verbatim-interpolated prefix orders across line breaks', () => {
    for (const prefix of ['$@', '@$']) {
      const source = [
        `var sql = ${prefix}"SELECT *`,
        'FROM class Ghost',
        'WHERE x = {id}";',
        'class AfterVerbatim { }',
      ].join('\n');
      const stripped = stripNonCode(source);
      expect(stripped, prefix).not.toContain('SELECT');
      expect(stripped, prefix).not.toContain('Ghost');
      expect(stripped, prefix).toContain('class AfterVerbatim');
    }
  });

  it('resumes scanning code after a plain verbatim string', () => {
    const stripped = stripNonCode('var p = @"C:\\temp\\class Ghost";\nclass AfterPlain { }');
    expect(stripped).not.toContain('Ghost');
    expect(stripped).toContain('class AfterPlain');
  });

  it('blanks raw string literals whole', () => {
    const stripped = stripNonCode('var x = """\nclass NotReal\n""";\nclass Real {}');
    expect(stripped).not.toContain('NotReal');
    expect(stripped).toContain('class Real');
  });
});

describe('readCSharpFacts', () => {
  it('reads namespaces, usings and type declarations', () => {
    const facts = readCSharpFacts(
      stripNonCode(
        [
          'global using System.Text;',
          'using static System.Math;',
          'using Alias = Space.Os.Core;',
          'using (var scope = Begin()) { }',
          'namespace Space.Os.Api;',
          'public sealed record class Cut(int W);',
          'public readonly record struct Point(int X, int Y);',
          'public interface IThing { }',
          'public enum Kind { A }',
        ].join('\n')
      )
    );
    expect(facts.usings).toEqual(['System.Text', 'System.Math', 'Space.Os.Core']);
    expect(facts.namespaces.map((n) => n.name)).toEqual(['Space.Os.Api']);
    // 'record class' must not yield a type literally named 'class'.
    expect(facts.types.map((t) => t.name)).toEqual(['Cut', 'Point', 'IThing', 'Kind']);
  });
});

describe('readCSharpFacts — contextual keywords', () => {
  it('does not read a generic constraint as a declaration', () => {
    const facts = readCSharpFacts(
      stripNonCode(
        [
          'public class Cache<TKey, TValue>',
          '  where TKey : class',
          '  where TValue : struct',
          '{',
          '  public TOut Map<TIn, TOut>(TIn x) where TIn : class where TOut : new() => default;',
          '}',
        ].join('\n')
      )
    );
    // `where T : class where U : struct` looks like `class where` to a lexer.
    expect(facts.types.map((t) => t.name)).toEqual(['Cache']);
  });

  it('does not read `record` used as an identifier as a declaration', () => {
    const facts = readCSharpFacts(
      stripNonCode(
        [
          'public class Importer {',
          '  void Run(IEnumerable<Row> rows) {',
          '    foreach (var record in rows) {',
          '      if (record is Row r) Handle(r);',
          '      var x = record as Row;',
          '      switch (record) { default: break; }',
          '    }',
          '  }',
          '}',
        ].join('\n')
      )
    );
    // `record` is only a CONTEXTUAL keyword — here it is a variable name.
    expect(facts.types.map((t) => t.name)).toEqual(['Importer']);
  });
});

describe('extractCSharp', () => {
  it('maps files and types to entities with PART_OF edges', () => {
    write(
      'src/Core/Cutting.cs',
      'namespace Space.Os.Core;\npublic class CutPlan { }\npublic class Sheet { }\n'
    );

    const { entities, relations } = extract();
    const byId = Object.fromEntries(entities.map((e) => [e.id, e]));

    expect(byId['src/Core/Cutting.cs'].type).toBe('Module');
    expect(byId['src/Core/Cutting.cs'].language).toBe('csharp');
    // Ids stay path-rooted; the fragment names the type.
    expect(byId['src/Core/Cutting.cs#CutPlan'].type).toBe('Class');
    expect(byId['src/Core/Cutting.cs#CutPlan'].name).toBe('Space.Os.Core.CutPlan');
    expect(byId['src/Core/Cutting.cs#CutPlan'].filePath).toBe('src/Core/Cutting.cs');

    expect(rel(relations, 'PART_OF')).toEqual(
      expect.arrayContaining([
        ['src/Core/Cutting.cs#CutPlan', 'src/Core/Cutting.cs'],
        ['src/Core/Cutting.cs#Sheet', 'src/Core/Cutting.cs'],
        ['src/Core/Cutting.cs', 'src/Core'],
        ['src/Core', 'src'],
      ])
    );
  });

  it('turns a using into DEPENDS_ON on the files declaring that namespace', () => {
    write('src/Core/Plan.cs', 'namespace Space.Os.Core;\npublic class Plan { }\n');
    write('src/Core/Sheet.cs', 'namespace Space.Os.Core;\npublic class Sheet { }\n');
    write(
      'src/Api/Controller.cs',
      'using Space.Os.Core;\nusing System.Linq;\nnamespace Space.Os.Api;\npublic class Controller { }\n'
    );

    const { relations } = extract();
    const depends = rel(relations, 'DEPENDS_ON');
    // Both files declaring the namespace are dependencies...
    expect(depends).toEqual(
      expect.arrayContaining([
        ['src/Api/Controller.cs', 'src/Core/Plan.cs'],
        ['src/Api/Controller.cs', 'src/Core/Sheet.cs'],
      ])
    );
    // ...and an external namespace nobody declares produces no edge.
    expect(depends.some(([, to]) => to.includes('System'))).toBe(false);
  });

  it('never links a namespace to itself and emits each edge once', () => {
    write(
      'src/Core/A.cs',
      'using Space.Os.Core;\nusing Space.Os.Core;\nnamespace Space.Os.Core;\npublic class A { }\n'
    );
    write('src/Core/B.cs', 'namespace Space.Os.Core;\npublic class B { }\n');

    const depends = rel(extract().relations, 'DEPENDS_ON');
    expect(depends).toEqual([['src/Core/A.cs', 'src/Core/B.cs']]);
  });

  it('ignores declarations that live in comments or strings', () => {
    write(
      'src/Ghosts.cs',
      [
        'namespace Space.Os.Ghosts;',
        '// public class CommentedOut { }',
        '/* public class Blocked { } */',
        'public class Real {',
        '  const string Doc = "public class Stringy { }";',
        '}',
      ].join('\n')
    );

    const ids = extract().entities.map((e) => e.id);
    expect(ids).toContain('src/Ghosts.cs#Real');
    expect(ids).not.toContain('src/Ghosts.cs#CommentedOut');
    expect(ids).not.toContain('src/Ghosts.cs#Blocked');
    expect(ids).not.toContain('src/Ghosts.cs#Stringy');
  });

  it('attributes a type to the namespace block it sits in', () => {
    write(
      'src/Two.cs',
      [
        'namespace First {',
        '  public class InFirst { }',
        '}',
        'namespace Second {',
        '  public class InSecond { }',
        '}',
      ].join('\n')
    );

    const byId = Object.fromEntries(extract().entities.map((e) => [e.id, e]));
    expect(byId['src/Two.cs#InFirst'].name).toBe('First.InFirst');
    expect(byId['src/Two.cs#InSecond'].name).toBe('Second.InSecond');
  });

  it('skips build output and generated sources', () => {
    write('src/Real.cs', 'namespace N;\npublic class Real { }\n');
    write('src/bin/Debug/Built.cs', 'namespace N;\npublic class Built { }\n');
    write('src/obj/Temp.cs', 'namespace N;\npublic class Temp { }\n');
    write('src/Forms.Designer.cs', 'namespace N;\npublic class Designed { }\n');
    write('src/Model.g.cs', 'namespace N;\npublic class Generated { }\n');

    const ids = extract().entities.map((e) => e.id);
    expect(ids).toContain('src/Real.cs');
    for (const skipped of [
      'src/bin/Debug/Built.cs',
      'src/obj/Temp.cs',
      'src/Forms.Designer.cs',
      'src/Model.g.cs',
    ]) {
      expect(ids).not.toContain(skipped);
    }
  });

  it('bounds the DEPENDS_ON fan-out of a hub namespace', () => {
    // users × declarers is a cross-product: 40 files declaring one namespace
    // and one file using it must not become 40 edges (a real hub namespace has
    // hundreds of declarers, and every user would multiply them).
    for (let i = 0; i < 40; i++) {
      write(`src/Core/Part${String(i).padStart(2, '0')}.cs`, `namespace Hub;\npublic class P${i} { }\n`);
    }
    write('src/Api/User.cs', 'using Hub;\nnamespace Api;\npublic class User { }\n');

    const depends = rel(extract().relations, 'DEPENDS_ON').filter(
      ([from]) => from === 'src/Api/User.cs'
    );
    expect(depends).toHaveLength(25);
    // Deterministic selection: sorted, so two runs produce the same graph.
    expect(depends[0][1]).toBe('src/Core/Part00.cs');
    expect(depends.at(-1)?.[1]).toBe('src/Core/Part24.cs');
  });

  it('keeps partial classes in different files distinct', () => {
    write('src/Part1.cs', 'namespace N;\npublic partial class Big { }\n');
    write('src/Part2.cs', 'namespace N;\npublic partial class Big { }\n');
    const ids = extract().entities.map((e) => e.id);
    expect(ids).toContain('src/Part1.cs#Big');
    expect(ids).toContain('src/Part2.cs#Big');
  });
});
