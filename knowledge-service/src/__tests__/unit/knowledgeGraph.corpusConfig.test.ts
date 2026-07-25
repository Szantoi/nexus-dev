/**
 * Corpus config tests — this file is what makes the graph layer project-
 * agnostic, so the contract is: unknown island / bad path / bad extractor all
 * fail LOUDLY (an empty index would sweep an island's graph away), and the
 * shipped config keeps pointing at trees that actually exist.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IslandNotOnThisHostError,
  configuredIslands,
  getCorpusConfigPath,
  loadCorpusConfig,
  resolveCorpus,
} from '../../knowledgeGraph/corpusConfig';
import { EXTRACTORS } from '../../knowledgeGraph/extractors/registry';

let dir: string;

function writeConfig(body: string): string {
  const file = path.join(dir, 'corpus.yaml');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const ISLE_CONFIG = (repoRoot: string, sourcePath = 'docs'): string =>
  [
    'islands:',
    '  isle:',
    `    repo_root: ${JSON.stringify(repoRoot)}`,
    '    sources:',
    `      - path: ${JSON.stringify(sourcePath)}`,
    '        extractor: markdown',
    '',
  ].join('\n');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-corpus-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('corpus config', () => {
  it('resolves sources to absolute roots with their extractor functions', () => {
    const configPath = writeConfig(ISLE_CONFIG(dir));
    const corpus = resolveCorpus('isle', { configPath });
    expect(corpus.island).toBe('isle');
    expect(corpus.repoRoot).toBe(dir);
    expect(corpus.sources).toHaveLength(1);
    expect(corpus.sources[0].root).toBe(path.join(dir, 'docs'));
    expect(corpus.sources[0].extractor).toBe('markdown');
    // The registry is the only wiring — no extractor is referenced by name.
    expect(corpus.sources[0].extract).toBe(EXTRACTORS.markdown);
  });

  it('refuses an island that has no corpus entry, and names the known ones', () => {
    const configPath = writeConfig(ISLE_CONFIG(dir));
    expect(() => resolveCorpus('other-isle', { configPath })).toThrow(
      /No graph corpus configured for island "other-isle".*isle/s
    );
  });

  it('refuses a source that escapes its repo root', () => {
    const configPath = writeConfig(ISLE_CONFIG(dir, '../outside'));
    expect(() => resolveCorpus('isle', { configPath })).toThrow(/escapes its repo root/);
  });

  // Each fixture below is a VALID config with exactly one thing wrong, so the
  // assertion pins that one rejection instead of any-error-will-do.
  it('refuses an unknown extractor by name', () => {
    const configPath = writeConfig(
      ISLE_CONFIG(dir).replace('extractor: markdown', 'extractor: cobol')
    );
    expect(() => resolveCorpus('isle', { configPath })).toThrow(
      /islands\.isle\.sources\.0\.extractor/
    );
  });

  it('refuses an island with no sources at all', () => {
    const configPath = writeConfig(
      ['islands:', '  isle:', `    repo_root: ${JSON.stringify(dir)}`, '    sources: []', ''].join(
        '\n'
      )
    );
    expect(() => resolveCorpus('isle', { configPath })).toThrow(/islands\.isle\.sources/);
  });

  it('refuses a malformed island id in the config', () => {
    const configPath = writeConfig(ISLE_CONFIG(dir).replace('  isle:', '  Bad Island:'));
    expect(() => resolveCorpus('isle', { configPath })).toThrow(/Invalid graph corpus config/);
  });

  it('requires repo_root rather than defaulting it', () => {
    // A mistyped key (repo-root:, repoRoot:) must fail loudly instead of
    // quietly indexing THIS checkout into someone else's island.
    const configPath = writeConfig(ISLE_CONFIG(dir).replace('repo_root:', 'repo-root:'));
    expect(() => resolveCorpus('isle', { configPath })).toThrow(/islands\.isle/);
  });

  it('rejects an unknown key instead of ignoring it', () => {
    const configPath = writeConfig(`${ISLE_CONFIG(dir)}    exclude: node_modules
`);
    expect(() => resolveCorpus('isle', { configPath })).toThrow(/Invalid graph corpus config/);
  });

  it('refuses an empty repo-root override instead of falling back to the CWD', () => {
    const configPath = writeConfig(ISLE_CONFIG(dir));
    expect(() => resolveCorpus('isle', { configPath, repoRootOverride: '  ' })).toThrow(
      /repo root override is empty/
    );
  });

  it('does not let an Object.prototype name pose as a configured island', () => {
    const configPath = writeConfig(ISLE_CONFIG(dir));
    // A bare property lookup would return Object.prototype.constructor here.
    expect(() => resolveCorpus('constructor', { configPath })).toThrow(
      /No graph corpus configured for island "constructor"/
    );
  });

  it('reports a missing config file instead of indexing nothing', () => {
    expect(() => loadCorpusConfig(path.join(dir, 'nope.yaml'))).toThrow(
      /Graph corpus config not found/
    );
  });

  it('resolves a relative repo_root against the nexus-dev checkout', () => {
    const configPath = writeConfig(
      [
        'islands:',
        '  isle:',
        '    repo_root: "."',
        '    sources:',
        '      - path: knowledge-service/src',
        '        extractor: typescript',
        '',
      ].join('\n')
    );
    const corpus = resolveCorpus('isle', { configPath });
    // The default base is the repo root this service lives in — its own src
    // tree must therefore exist under the resolved corpus root.
    expect(fs.existsSync(path.join(corpus.repoRoot, 'knowledge-service', 'src'))).toBe(true);
    expect(corpus.sources[0].root).toBe(
      path.join(corpus.repoRoot, 'knowledge-service', 'src')
    );
  });

  it('keeps the shipped config valid and pointing at existing trees', () => {
    // Guards the real config/graph-corpus.yaml: a typo'd path there would only
    // surface as a failed index run against the live graph.
    // Islands whose checkout lives on another host cannot be verified from
    // this machine — that is a deployment fact, not a config error.
    const config = loadCorpusConfig();
    expect(Object.keys(config.islands).length).toBeGreaterThan(0);
    let verified = 0;
    for (const island of Object.keys(config.islands)) {
      let corpus: ReturnType<typeof resolveCorpus>;
      try {
        corpus = resolveCorpus(island, { configPath: getCorpusConfigPath() });
      } catch (err) {
        expect(err, `${island}: unexpected config error`).toBeInstanceOf(IslandNotOnThisHostError);
        continue;
      }
      for (const source of corpus.sources) {
        expect(fs.existsSync(source.root), `${island}: ${source.root} missing`).toBe(true);
      }
      verified += 1;
    }
    // Without this the guard would pass vacuously on a machine with no checkouts.
    expect(verified).toBeGreaterThan(0);
  });

  it('treats an env-driven repo_root as "not on this host" when unset', () => {
    const configPath = writeConfig(
      // Assembled, not written inline: a literal ${...} in a plain string is a
      // classic typo for a template literal, and the linter rightly flags it.
      ISLE_CONFIG(dir).replace(
        `repo_root: ${JSON.stringify(dir)}`,
        `repo_root: "$\{KG_TEST_ROOT}"`
      )
    );
    delete process.env.KG_TEST_ROOT;
    expect(() => resolveCorpus('isle', { configPath })).toThrow(IslandNotOnThisHostError);
    process.env.KG_TEST_ROOT = dir;
    try {
      expect(resolveCorpus('isle', { configPath }).repoRoot).toBe(dir);
    } finally {
      delete process.env.KG_TEST_ROOT;
    }
  });

  it('lists the configured islands for a bulk run', () => {
    const extra = `  other-isle:
    repo_root: ${JSON.stringify(dir)}
    sources:
      - path: docs
        extractor: markdown
`;
    expect(configuredIslands(writeConfig(ISLE_CONFIG(dir) + extra))).toEqual([
      'isle',
      'other-isle',
    ]);
  });
});
