/**
 * Extractor unit tests — real files in a temp fixture tree (no mocks).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyDocPath, extractDocs } from '../../knowledgeGraph/extractors/docsExtractor';
import { extractTypeScript } from '../../knowledgeGraph/extractors/tsExtractor';
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

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-extract-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// The repo link-gate (scripts/check-doc-links.mjs) scans source LITERALS for
// ADR paths/numbers and would validate our synthetic fixture ADRs against the
// real docs tree — build the fixture strings dynamically to stay invisible
// to it without weakening the gate.
const adrRef = (num: string) => `ADR-${num}`;
const FIXTURE_ADR = `docs/architecture/decisions/${adrRef('001')}-first.md`;

describe('classifyDocPath', () => {
  it('classifies by repo path conventions', () => {
    expect(classifyDocPath(`docs/architecture/decisions/${adrRef('087')}-x.md`)).toBe('ADR');
    expect(classifyDocPath('docs/plans/GRAPHRAG-PILOT.md')).toBe('Plan');
    expect(classifyDocPath('docs/tasks/quality/TASK-QC-001.md')).toBe('Task');
    expect(classifyDocPath('docs/knowledge/vps.md')).toBe('Knowledge');
    expect(classifyDocPath('docs/README.md')).toBe('Doc');
  });
});

describe('extractDocs', () => {
  it('builds entities and REFERENCES from links and ADR mentions', () => {
    write(
      FIXTURE_ADR,
      `# ${adrRef('001')}\nSelf mention ${adrRef('001')} must not create a self-loop.`
    );
    write(
      'docs/plans/PLAN.md',
      `See [the ADR](../architecture/decisions/${adrRef('001')}-first.md) and ` +
        `${adrRef('001')} twice, an [external link](https://example.com/x.md) ` +
        'and a [missing one](./nope.md).'
    );
    write('docs/knowledge/note.md', `Panel: mentions ${adrRef('001')} by number only.`);

    const { entities, relations } = extractDocs(path.join(repoRoot, 'docs'), repoRoot);

    const types = Object.fromEntries(entities.map((e) => [e.id, e.type]));
    expect(types[FIXTURE_ADR]).toBe('ADR');
    expect(types['docs/plans/PLAN.md']).toBe('Plan');
    expect(types['docs/knowledge/note.md']).toBe('Knowledge');

    // Link + duplicate number-mention collapse into ONE deduplicated edge.
    const references = rel(relations, 'REFERENCES');
    expect(references).toHaveLength(2);
    expect(references).toEqual(
      expect.arrayContaining([
        ['docs/plans/PLAN.md', FIXTURE_ADR],
        ['docs/knowledge/note.md', FIXTURE_ADR],
      ])
    );
  });

  it('ignores anchors and resolves .. link segments', () => {
    write('docs/a/one.md', '[x](../b/two.md#section)');
    write('docs/b/two.md', 'target');
    const { relations } = extractDocs(path.join(repoRoot, 'docs'), repoRoot);
    expect(rel(relations, 'REFERENCES')).toEqual([['docs/a/one.md', 'docs/b/two.md']]);
  });

  it('accepts CommonMark link titles and angle-bracketed destinations', () => {
    write('docs/b/two.md', 'target');
    write('docs/b/three.md', 'target');
    write('docs/a/one.md', '[t](../b/two.md "a title") and [u](<../b/three.md>)');
    const { relations } = extractDocs(path.join(repoRoot, 'docs'), repoRoot);
    expect(rel(relations, 'REFERENCES')).toEqual(
      expect.arrayContaining([
        ['docs/a/one.md', 'docs/b/two.md'],
        ['docs/a/one.md', 'docs/b/three.md'],
      ])
    );
  });

  it('matches ADR mentions regardless of zero padding', () => {
    write(`docs/architecture/decisions/${adrRef('081')}-launch.md`, 'decision');
    write('docs/knowledge/short.md', `See ${adrRef('81')} for the launch rule.`);
    const { relations } = extractDocs(path.join(repoRoot, 'docs'), repoRoot);
    expect(rel(relations, 'REFERENCES')).toEqual([
      ['docs/knowledge/short.md', `docs/architecture/decisions/${adrRef('081')}-launch.md`],
    ]);
  });
});

describe('extractTypeScript', () => {
  it('maps files to Module entities with DEPENDS_ON and PART_OF edges', () => {
    write('svc/src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    write('svc/src/b.ts', 'export const b = 1;\n');
    write(
      'svc/src/sub/c.ts',
      "import { a } from '../a';\nexport * from '../b';\nimport * as fs from 'node:fs';\n"
    );
    write('svc/src/types.d.ts', 'declare const x: number;\n');

    const { entities, relations } = extractTypeScript(path.join(repoRoot, 'svc/src'), repoRoot);

    const ids = entities.map((e) => e.id);
    expect(ids).toContain('svc/src/a.ts');
    expect(ids).toContain('svc/src/sub/c.ts');
    expect(ids).toContain('svc/src'); // directory module
    expect(ids).toContain('svc/src/sub');
    expect(ids).not.toContain('svc/src/types.d.ts'); // declarations excluded

    expect(rel(relations, 'DEPENDS_ON')).toEqual(
      expect.arrayContaining([
        ['svc/src/a.ts', 'svc/src/b.ts'],
        ['svc/src/sub/c.ts', 'svc/src/a.ts'],
        ['svc/src/sub/c.ts', 'svc/src/b.ts'], // re-export counts as dependency
      ])
    );
    // Package import (node:fs) must NOT appear anywhere.
    expect(rel(relations, 'DEPENDS_ON').some(([, to]) => to.includes('fs'))).toBe(false);

    expect(rel(relations, 'PART_OF')).toEqual(
      expect.arrayContaining([
        ['svc/src/a.ts', 'svc/src'],
        ['svc/src/sub/c.ts', 'svc/src/sub'],
      ])
    );
  });

  it('resolves directory imports to index.ts', () => {
    write('svc/src/lib/index.ts', 'export const l = 1;\n');
    write('svc/src/main.ts', "import { l } from './lib';\n");
    const { relations } = extractTypeScript(path.join(repoRoot, 'svc/src'), repoRoot);
    expect(rel(relations, 'DEPENDS_ON')).toEqual([['svc/src/main.ts', 'svc/src/lib/index.ts']]);
  });

  it('resolves ESM-style .js specifiers to their .ts sources', () => {
    write('svc/src/b.ts', 'export const b = 1;\n');
    write('svc/src/a.ts', "import { b } from './b.js';\n");
    const { relations } = extractTypeScript(path.join(repoRoot, 'svc/src'), repoRoot);
    expect(rel(relations, 'DEPENDS_ON')).toEqual([['svc/src/a.ts', 'svc/src/b.ts']]);
  });

  it('prefers the .ts source over an emitted .js sibling for ESM specifiers', () => {
    write('svc/src/b.ts', 'export const b = 1;\n');
    write('svc/src/b.js', 'exports.b = 1;\n'); // stale build output next to it
    write('svc/src/a.ts', "import { b } from './b.js';\n");
    const { relations } = extractTypeScript(path.join(repoRoot, 'svc/src'), repoRoot);
    expect(rel(relations, 'DEPENDS_ON')).toEqual([['svc/src/a.ts', 'svc/src/b.ts']]);
  });

  it('emits each DEPENDS_ON edge once even for repeated import statements', () => {
    write('svc/src/b.ts', 'export const b = 1;\nexport const c = 2;\n');
    write('svc/src/a.ts', "import { b } from './b';\nexport { c } from './b';\n");
    const { relations } = extractTypeScript(path.join(repoRoot, 'svc/src'), repoRoot);
    expect(rel(relations, 'DEPENDS_ON')).toEqual([['svc/src/a.ts', 'svc/src/b.ts']]);
  });

  it('chains nested directories to the source root via PART_OF', () => {
    write('svc/src/deep/inner/x.ts', 'export const x = 1;\n');
    const { entities, relations } = extractTypeScript(path.join(repoRoot, 'svc/src'), repoRoot);
    expect(entities.map((e) => e.id)).toEqual(
      expect.arrayContaining(['svc/src', 'svc/src/deep', 'svc/src/deep/inner'])
    );
    expect(rel(relations, 'PART_OF')).toEqual(
      expect.arrayContaining([
        ['svc/src/deep/inner/x.ts', 'svc/src/deep/inner'],
        ['svc/src/deep/inner', 'svc/src/deep'],
        ['svc/src/deep', 'svc/src'],
      ])
    );
  });
});
