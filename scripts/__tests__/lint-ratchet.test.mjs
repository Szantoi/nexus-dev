// lint-ratchet.test.mjs — unit + integration tests for scripts/lint-ratchet.mjs
// (TASK-DP-007 scope-5: baseline owner/expiry/task, fail-closed expiry).
//
// Runner: node's built-in test runner (node:test), same rationale as
// check-tasks.test.mjs (no extra dependency, ships with Node >= 18).
//
// Run: node --test scripts/__tests__/lint-ratchet.test.mjs
// (or, from knowledge-service/: npm run test:tasks)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  parseCounts,
  validateBaseline,
  isExpired,
  isRealCalendarDate,
  DATE_RE,
} from '../lint-ratchet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

const validBaseline = {
  maxWarnings: 784,
  owner: 'backend',
  expires: '2099-12-31',
  task: 'TASK-QC-014',
  note: 'test',
};

/** Recursive filename search under docs/tasks/ for files starting with taskId. */
function findTaskFiles(taskId) {
  const results = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.startsWith(taskId)) results.push(full);
    }
  };
  walk(resolve(repoRoot, 'docs/tasks'));
  return results;
}

describe('parseCounts', () => {
  test('extracts error/warning/info counts from Biome summary output', () => {
    const out = 'Checked 500 files.\nFound 3 errors.\nFound 784 warnings.\nFound 12 infos.\n';
    assert.deepEqual(parseCounts(out), { errors: 3, warnings: 784, infos: 12 });
  });

  test('singular forms and missing lines count as expected', () => {
    const out = 'Found 1 error.\nFound 1 warning.\n';
    assert.deepEqual(parseCounts(out), { errors: 1, warnings: 1, infos: 0 });
  });

  test('empty output means zero everywhere (Biome clean run)', () => {
    assert.deepEqual(parseCounts(''), { errors: 0, warnings: 0, infos: 0 });
  });
});

describe('validateBaseline (fail-closed schema)', () => {
  test('a complete baseline passes', () => {
    assert.deepEqual(validateBaseline(validBaseline), []);
  });

  test('missing maxWarnings is a config error', () => {
    const { maxWarnings, ...rest } = validBaseline;
    assert.match(validateBaseline(rest).join(';'), /maxWarnings/);
  });

  test('non-numeric maxWarnings is a config error', () => {
    const errs = validateBaseline({ ...validBaseline, maxWarnings: 'sok' });
    assert.match(errs.join(';'), /maxWarnings/);
  });

  test('missing owner is a config error', () => {
    const { owner, ...rest } = validBaseline;
    assert.match(validateBaseline(rest).join(';'), /"owner"/);
  });

  test('missing or malformed expires is a config error', () => {
    const { expires, ...rest } = validBaseline;
    assert.match(validateBaseline(rest).join(';'), /"expires"/);
    const errs = validateBaseline({ ...validBaseline, expires: '2026.10.18' });
    assert.match(errs.join(';'), /"expires"/);
  });

  test('missing task is a config error', () => {
    const { task, ...rest } = validBaseline;
    assert.match(validateBaseline(rest).join(';'), /"task"/);
  });

  test('null/undefined baseline reports every mandatory field', () => {
    assert.equal(validateBaseline(null).length, 4);
    assert.equal(validateBaseline(undefined).length, 4);
  });

  test('coercible-but-wrong maxWarnings types are rejected (no Number() coercion)', () => {
    for (const bad of ['784', null, true, [], -5, 1.5, Number.NaN]) {
      const errs = validateBaseline({ ...validBaseline, maxWarnings: bad });
      assert.match(errs.join(';'), /maxWarnings/, `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  test('impossible calendar dates are rejected even when format-valid', () => {
    for (const bad of ['2026-13-99', '9999-99-99', '2026-02-30', '2026-00-01']) {
      const errs = validateBaseline({ ...validBaseline, expires: bad });
      assert.match(errs.join(';'), /"expires"/, `expected rejection for ${bad}`);
    }
  });

  test('whitespace-only owner/task are rejected', () => {
    assert.match(validateBaseline({ ...validBaseline, owner: '   ' }).join(';'), /"owner"/);
    assert.match(validateBaseline({ ...validBaseline, task: '\t' }).join(';'), /"task"/);
  });
});

describe('isRealCalendarDate', () => {
  test('accepts real dates, rejects impossible ones', () => {
    assert.equal(isRealCalendarDate('2026-10-18'), true);
    assert.equal(isRealCalendarDate('2028-02-29'), true); // leap year
    assert.equal(isRealCalendarDate('2026-02-30'), false);
    assert.equal(isRealCalendarDate('2026-13-01'), false);
  });
});

describe('isExpired', () => {
  test('a past expires date is expired', () => {
    assert.equal(isExpired({ expires: '2026-07-01' }, '2026-07-28'), true);
  });

  test('the expiry day itself is still valid (inclusive), the next day is not', () => {
    assert.equal(isExpired({ expires: '2026-07-28' }, '2026-07-28'), false);
    assert.equal(isExpired({ expires: '2026-07-28' }, '2026-07-29'), true);
  });

  test('a future expires date is not expired', () => {
    assert.equal(isExpired({ expires: '2099-12-31' }, '2026-07-28'), false);
  });
});

describe('the committed knowledge-service baseline', () => {
  const committed = JSON.parse(
    readFileSync(resolve(repoRoot, 'knowledge-service/.lint-baseline.json'), 'utf8'),
  );

  test('conforms to the mandatory schema (owner/expires/task/maxWarnings)', () => {
    assert.deepEqual(validateBaseline(committed), []);
  });

  test('references an existing follow-up task file', () => {
    // The expiry message points the developer at this task; a dangling
    // reference would violate the DP-007 acceptance criterion ("expired
    // baseline names a concrete follow-up task").
    assert.match(committed.task, /^TASK-[A-Z]+-\d+[A-Z]?$/);
    const hits = findTaskFiles(committed.task);
    assert.ok(hits.length > 0, `no task file found for ${committed.task} under docs/tasks/`);
  });

  test('expires matches the date format the gate enforces', () => {
    assert.match(committed.expires, DATE_RE);
  });
});

// ── Integration: the CLI main path (spawns node + a REAL Biome run — slow,
// ~10-20 s per case, but these are the exit-code invariants the whole gate
// stands on; unit tests alone would let a reordering regress them silently
// (TASK-DP-007 review P2 finding). ─────────────────────────────────────────
describe('CLI main path (integration, real Biome run)', () => {
  const script = resolve(repoRoot, 'scripts/lint-ratchet.mjs');

  /** Runs the CLI with a given baseline object; returns {status, out}. */
  function runWithBaseline(baseline) {
    const dir = mkdtempSync(join(tmpdir(), 'lint-ratchet-test-'));
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify(baseline));
    try {
      const out = execFileSync(process.execPath, [script, '--baseline', baselinePath], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, out };
    } catch (err) {
      return { status: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('an EXPIRED baseline fails (exit 1) even when warnings are far below the ceiling — expiry is checked before the ratchet comparison', () => {
    const { status, out } = runWithBaseline({
      maxWarnings: 99999, owner: 'backend', expires: '2020-01-01', task: 'TASK-QC-014',
    });
    assert.equal(status, 1, out);
    assert.match(out, /EXPIRED 2020-01-01/);
    assert.match(out, /TASK-QC-014/); // the failure must name the follow-up task
  });

  test('an incomplete baseline (maxWarnings only) is a config error (exit 2) naming every missing field', () => {
    const { status, out } = runWithBaseline({ maxWarnings: 99999 });
    assert.equal(status, 2, out);
    assert.match(out, /"owner"/);
    assert.match(out, /"expires"/);
    assert.match(out, /"task"/);
  });
});
