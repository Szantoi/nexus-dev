// check-worktree.test.mjs — unit + integration tests for scripts/check-worktree.mjs
// (TASK-DP-007: the worktree gate must see gitignored runtime writes too).
//
// Runner: node's built-in test runner (node:test), same rationale as
// check-tasks.test.mjs.
//
// Run: node --test scripts/__tests__/check-worktree.test.mjs
// (or, from knowledge-service/: npm run test:tasks)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  normalizeStatus,
  pathOfStatusLine,
  isExpectedOutput,
  filterExpected,
  diffStatus,
  EXPECTED_OUTPUT_PREFIXES,
} from '../check-worktree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const script = resolve(repoRoot, 'scripts/check-worktree.mjs');

describe('normalizeStatus', () => {
  test('splits, strips CR, drops empties, sorts', () => {
    const raw = ' M b.ts\r\n?? a.ts\n\n!! data/\r\n';
    assert.deepEqual(normalizeStatus(raw), ['!! data/', ' M b.ts', '?? a.ts'].sort());
  });
});

describe('pathOfStatusLine', () => {
  test('plain, quoted and renamed entries', () => {
    assert.equal(pathOfStatusLine('?? knowledge-service/data/x.db'), 'knowledge-service/data/x.db');
    assert.equal(pathOfStatusLine('?? "sp ace/f.txt"'), 'sp ace/f.txt');
    assert.equal(pathOfStatusLine('R  old.ts -> new.ts'), 'new.ts');
    assert.equal(pathOfStatusLine('!! knowledge-service/coverage/'), 'knowledge-service/coverage/');
  });
});

describe('isExpectedOutput', () => {
  test('build outputs are allowlisted, runtime data is NOT', () => {
    assert.equal(isExpectedOutput('!! knowledge-service/coverage/'), true);
    assert.equal(isExpectedOutput('!! knowledge-service/node_modules/'), true);
    assert.equal(isExpectedOutput('!! knowledge-service/dist/'), true);
    // The P1 finding this gate exists for: ignored runtime data dirs.
    assert.equal(isExpectedOutput('!! knowledge-service/data/'), false);
    assert.equal(isExpectedOutput('?? knowledge-service/data/foo.db'), false);
    assert.equal(isExpectedOutput('?? terminals/root/junk.txt'), false);
  });

  test('prefix match cannot be fooled by sibling names', () => {
    assert.equal(isExpectedOutput('?? knowledge-service/coverage-extra/x'), false);
    assert.equal(isExpectedOutput('?? knowledge-service/distX/y'), false);
  });
});

describe('filterExpected (capture-time allowlist)', () => {
  test('build outputs are dropped at capture, runtime data is kept', () => {
    const lines = [
      '!! knowledge-service/coverage/coverage-final.json',
      '!! knowledge-service/node_modules/x/y.js',
      '!! knowledge-service/data/workflow.db',
      '?? terminals/root/junk.txt',
    ];
    assert.deepEqual(filterExpected(lines), [
      '!! knowledge-service/data/workflow.db',
      '?? terminals/root/junk.txt',
    ]);
  });
});

describe('diffStatus (pure symmetric difference)', () => {
  const before = [' M docs/known-dirty.md', '!! knowledge-service/.env.dev'];

  test('unchanged status means empty delta', () => {
    const { appeared, disappeared } = diffStatus(before, [...before]);
    assert.deepEqual(appeared, []);
    assert.deepEqual(disappeared, []);
  });

  test('a NEW ignored runtime write appears in the delta — file-level, so a write into an EXISTING ignored dir is visible too (the P1 case)', () => {
    const after = [...before, '!! knowledge-service/data/gate-probe.tmp'];
    const { appeared } = diffStatus(before, after);
    assert.deepEqual(appeared, ['!! knowledge-service/data/gate-probe.tmp']);
  });

  test('a disappeared entry is a violation too (pre-existing file modified/removed)', () => {
    const after = ['!! knowledge-service/.env.dev'];
    const { disappeared } = diffStatus(before, after);
    assert.deepEqual(disappeared, [' M docs/known-dirty.md']);
  });

  test('pre-existing dirty entries never fail verify (snapshot model)', () => {
    const { appeared } = diffStatus(before, before);
    assert.deepEqual(appeared, []);
  });
});

describe('CLI integration (temp git repo)', () => {
  /**
   * Builds a scratch git repo with an ignored data/ dir, snapshots, mutates,
   * verifies. The script itself always measures the NEXUS repo root, so the
   * CLI integration here exercises snapshot/verify against the real repo but
   * with a --file in tmp; full end-to-end (writing into the real repo) is
   * deliberately NOT done from a test.
   */
  test('snapshot then immediate verify passes against the real repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-gate-test-'));
    const file = join(dir, 'snap.txt');
    try {
      const snapOut = execFileSync(process.execPath, [script, 'snapshot', '--file', file], {
        cwd: repoRoot, encoding: 'utf8',
      });
      assert.match(snapOut, /snapshot: \d+ entr/);
      const verifyOut = execFileSync(process.execPath, [script, 'verify', '--file', file], {
        cwd: repoRoot, encoding: 'utf8',
      });
      assert.match(verifyOut, /OK — the worktree is unchanged/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verify without a snapshot is a config error (fail-closed, exit 2)', () => {
    const missing = join(tmpdir(), `worktree-gate-missing-${process.pid}.txt`);
    try {
      execFileSync(process.execPath, [script, 'verify', '--file', missing], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.fail('expected exit 2');
    } catch (err) {
      assert.equal(err.status, 2);
      assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /snapshot file not found/);
    }
  });

  test('a simulated new entry in the snapshot fails verify with exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-gate-test-'));
    const file = join(dir, 'snap.txt');
    try {
      execFileSync(process.execPath, [script, 'snapshot', '--file', file], {
        cwd: repoRoot, encoding: 'utf8',
      });
      // Simulate "the suite deleted/modified a pre-existing entry": add a fake
      // line to the snapshot that the live measurement will not contain.
      const fake = '?? zz-nonexistent-fixture-entry.txt';
      writeFileSync(file, `${fake}\n`, { flag: 'a' });
      try {
        execFileSync(process.execPath, [script, 'verify', '--file', file], {
          cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        assert.fail('expected exit 1');
      } catch (err) {
        assert.equal(err.status, 1);
        assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /entry disappeared/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
