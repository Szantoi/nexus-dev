// check-tasks.test.mjs — unit + integration tests for scripts/check-tasks.mjs
// (TASK-DP-003, referenced by name in check-tasks.mjs's own header comment).
//
// Runner: node's built-in test runner (node:test), NOT vitest — this script
// deliberately has no package.json/node_modules of its own (see check-tasks.mjs
// "Tervezési döntés" comment), so introducing a new hermetic test framework
// dependency here would contradict that same reuse-over-reinvention principle
// (QUALITY.md 5. pont). node:test + node:assert/strict need nothing extra and
// have shipped in Node since v18; the CI runner (Node 22) has them natively.
//
// Run: node --test scripts/__tests__/check-tasks.test.mjs
// (or, from knowledge-service/: npm run test:tasks)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  loadYamlLibs,
  discoverTasks,
  validateFrontmatter,
  detectCycles,
  isAllowedTransition,
  loadEpics,
  checkEpicsMembership,
  checkEpicsReferences,
  resolveDefaultDiffBase,
  checkProgramReadme,
  extractEvidenceBlock,
  checkArchiveInvariants,
  runChecks,
  ID_RE,
  DATE_RE,
} from '../check-tasks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..'); // scripts/__tests__ -> scripts -> repo root
const fixturesRoot = resolve(repoRoot, 'scripts/__fixtures__/tasks');

const schema = JSON.parse(readFileSync(resolve(repoRoot, 'docs/tasks/task-schema.json'), 'utf8'));
const { matter, yaml } = loadYamlLibs(repoRoot);

// A minimal, valid frontmatter object — each test below mutates a shallow
// copy of this to isolate exactly one broken field per case.
const VALID_FM = {
  id: 'TASK-DM-001',
  title: 'Demo',
  program: 'NEXUS-DEMO',
  project: 'demo/project',
  milestone: 'DEMO-M1',
  epic: 'DEMO-EPIC',
  status: 'ready',
  priority: 'medium',
  owner_role: 'backend',
  created: '2026-07-18',
  source: 'fixture',
};

// ─── validateFrontmatter — one test per schema branch ──────────────────────

describe('validateFrontmatter', () => {
  test('valid frontmatter produces zero errors', () => {
    assert.deepEqual(validateFrontmatter({ ...VALID_FM }, schema), []);
  });

  test('missing required field is reported by name', () => {
    const { owner_role, ...rest } = VALID_FM;
    const errors = validateFrontmatter(rest, schema);
    assert.ok(errors.some((e) => e.field === 'owner_role'));
  });

  for (const bad of ['task-1', 'TASK-1', 'TASK-DM-1', 'TASK-dm-001', 'TASKDM001']) {
    test(`id pattern rejects malformed id '${bad}'`, () => {
      const errors = validateFrontmatter({ ...VALID_FM, id: bad }, schema);
      assert.ok(errors.some((e) => e.field === 'id'));
    });
  }

  test('id pattern accepts an optional single-letter sub-id (TASK-QC-008A)', () => {
    const errors = validateFrontmatter({ ...VALID_FM, id: 'TASK-QC-008A' }, schema);
    assert.ok(!errors.some((e) => e.field === 'id'));
  });

  test('invalid status enum value is reported', () => {
    const errors = validateFrontmatter({ ...VALID_FM, status: 'in-progress' }, schema);
    assert.ok(errors.some((e) => e.field === 'status'));
  });

  test('invalid priority enum value is reported', () => {
    const errors = validateFrontmatter({ ...VALID_FM, priority: 'urgent' }, schema);
    assert.ok(errors.some((e) => e.field === 'priority'));
  });

  test('malformed created date is reported', () => {
    const errors = validateFrontmatter({ ...VALID_FM, created: '07-18-2026' }, schema);
    assert.ok(errors.some((e) => e.field === 'created'));
  });

  test('malformed updated date is reported', () => {
    const errors = validateFrontmatter({ ...VALID_FM, updated: 'yesterday' }, schema);
    assert.ok(errors.some((e) => e.field === 'updated'));
  });

  test('a well-formed created date parsed via the real YAML pipeline stays a string, not a Date', () => {
    // Regression guard for the bug this task found while running against the
    // real repo: js-yaml's default schema resolves unquoted YYYY-MM-DD as
    // !!timestamp (a JS Date), which silently broke DATE_RE on every task
    // file. loadYamlLibs() must configure JSON_SCHEMA so this stays a string.
    const raw = `---\nid: TASK-DM-001\ncreated: 2026-07-18\n---\nbody`;
    const parsed = matter(raw);
    assert.equal(typeof parsed.data.created, 'string');
    assert.equal(parsed.data.created, '2026-07-18');
  });

  test('depends_on must be an array', () => {
    const errors = validateFrontmatter({ ...VALID_FM, depends_on: 'TASK-X' }, schema);
    assert.ok(errors.some((e) => e.field === 'depends_on'));
  });

  test('parallel_with must be an array', () => {
    const errors = validateFrontmatter({ ...VALID_FM, parallel_with: 'TASK-X' }, schema);
    assert.ok(errors.some((e) => e.field === 'parallel_with'));
  });

  test('status: blocked without blocked_reason is rejected', () => {
    const errors = validateFrontmatter({ ...VALID_FM, status: 'blocked' }, schema);
    assert.ok(errors.some((e) => e.field === 'blocked_reason'));
  });

  test('status: blocked with blocked_reason is accepted (TASK-ISL-001 precedent)', () => {
    const errors = validateFrontmatter(
      { ...VALID_FM, status: 'blocked', blocked_reason: 'External design decision pending.' },
      schema
    );
    assert.ok(!errors.some((e) => e.field === 'blocked_reason'));
  });

  test('blocked_reason of only whitespace is treated as absent', () => {
    const errors = validateFrontmatter(
      { ...VALID_FM, status: 'blocked', blocked_reason: '   ' },
      schema
    );
    assert.ok(errors.some((e) => e.field === 'blocked_reason'));
  });
});

// ─── ID_RE / DATE_RE exported constants sanity ──────────────────────────────

describe('exported regex constants', () => {
  test('ID_RE matches program-prefixed ids with and without sub-letter', () => {
    assert.ok(ID_RE.test('TASK-DP-003'));
    assert.ok(ID_RE.test('TASK-QC-008A'));
    assert.ok(!ID_RE.test('TASK-DP-3'));
  });

  test('DATE_RE matches ISO dates only', () => {
    assert.ok(DATE_RE.test('2026-07-18'));
    assert.ok(!DATE_RE.test('07-18-2026'));
  });
});

// ─── detectCycles ────────────────────────────────────────────────────────────

describe('detectCycles', () => {
  test('acyclic diamond graph reports no cycles', () => {
    const graph = new Map([
      ['A', []],
      ['B', ['A']],
      ['C', ['A']],
      ['D', ['B', 'C']],
    ]);
    assert.deepEqual(detectCycles(graph), []);
  });

  test('direct two-node cycle is detected', () => {
    const graph = new Map([
      ['A', ['B']],
      ['B', ['A']],
    ]);
    const cycles = detectCycles(graph);
    assert.equal(cycles.length, 1);
  });

  test('self-referencing node is its own cycle', () => {
    const graph = new Map([['A', ['A']]]);
    const cycles = detectCycles(graph);
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0], ['A', 'A']);
  });

  test('a dependency on a non-existent node is ignored (reported separately as a missing dep)', () => {
    const graph = new Map([['A', ['GHOST']]]);
    assert.deepEqual(detectCycles(graph), []);
  });
});

// ─── isAllowedTransition — ADR-068 state machine ────────────────────────────

describe('isAllowedTransition', () => {
  test('a brand-new file (no previous state) is always allowed', () => {
    assert.ok(isAllowedTransition(null, 'blocked', schema));
    assert.ok(isAllowedTransition(undefined, 'done', schema));
  });

  test('same-state is always allowed (checkpoint/heartbeat, no transition)', () => {
    assert.ok(isAllowedTransition('in_progress', 'in_progress', schema));
  });

  for (const [from, to] of [
    ['ready', 'in_progress'],
    ['in_progress', 'blocked'],
    ['blocked', 'in_progress'],
    ['in_progress', 'ready'],
    ['in_progress', 'done'],
    ['done', 'archived'],
  ]) {
    test(`declared edge ${from} -> ${to} is allowed`, () => {
      assert.ok(isAllowedTransition(from, to, schema));
    });
  }

  for (const [from, to] of [
    ['ready', 'blocked'],
    ['ready', 'done'],
    ['done', 'ready'],
    ['blocked', 'done'],
    ['done', 'in_progress'],
  ]) {
    test(`undeclared edge ${from} -> ${to} is rejected`, () => {
      assert.ok(!isAllowedTransition(from, to, schema));
    });
  }
});

// ─── resolveDefaultDiffBase — the CLI's automatic --diff-base detection ────
//
// Regression suite for the independent review's gap #2 (2026-07-18, 1st
// round REQUEST_CHANGES): --diff-base was implemented and unit-tested, but
// never actually invoked by `npm run check:tasks` or CI. These tests build
// REAL, disposable git repos under the OS temp dir (never inside this repo,
// never committed) to prove the auto-detection genuinely works end to end,
// not just in theory.

describe('resolveDefaultDiffBase', () => {
  function makeTempGitRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'check-tasks-diffbase-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'first', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: dir });
    return dir;
  }

  test('returns "HEAD~1" for a real repo root with at least one parent commit', () => {
    const dir = makeTempGitRepo();
    try {
      // Need a 2nd commit so HEAD~1 resolves.
      writeFileSync(join(dir, 'b.txt'), 'second', 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'second'], { cwd: dir });
      assert.equal(resolveDefaultDiffBase(dir), 'HEAD~1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null for the very first commit (no parent to diff against)', () => {
    const dir = makeTempGitRepo();
    try {
      assert.equal(resolveDefaultDiffBase(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null for a directory that is not a git repository at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-tasks-nogit-'));
    try {
      assert.equal(resolveDefaultDiffBase(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null for a SUBDIRECTORY of a git repo (root must be the repo top-level)', () => {
    // This is the safeguard that protects fixture runs (e.g. --root
    // scripts/__fixtures__/tasks/positive) from silently picking up the
    // ENCLOSING real repo's git history — previousStatus() resolves paths
    // relative to `root`, not the actual git top-level, so a mismatch here
    // would make `git show <sha>:<path>` resolve the wrong blob.
    const dir = makeTempGitRepo();
    try {
      const sub = join(dir, 'subdir');
      mkdirSync(sub);
      assert.equal(resolveDefaultDiffBase(sub), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('end-to-end: an illegal ready -> done jump is caught by the CLI with zero flags', () => {
    const dir = makeTempGitRepo();
    try {
      mkdirSync(join(dir, 'docs/tasks/demo-program'), { recursive: true });
      mkdirSync(join(dir, 'docs/projects'), { recursive: true });
      writeFileSync(
        join(dir, 'docs/projects/EPICS.yaml'),
        [
          'version: "1.0"',
          'updated: "2026-07-18"',
          'programs:',
          '  - id: NEXUS-DEMO',
          '    name: "Demo"',
          '    project: demo/project',
          '    status: active',
          '    goal: "x"',
          '    stopping_condition: "x"',
          '    milestones:',
          '      - id: DEMO-M1',
          '        name: "Demo"',
          '        status: active',
          '        acceptance: "x"',
          'epics:',
          '  - id: DEMO-EPIC',
          '    name: "Demo epic"',
          '    program: NEXUS-DEMO',
          '    milestone: DEMO-M1',
          '    project: demo/project',
          '    depends_on: []',
          '    status: active',
          '    tasks_yaml: ../tasks/demo-program/README.md',
          '    tasks:',
          '      - id: TASK-DM-050',
          '        file: ../tasks/demo-program/TASK-DM-050.md',
          '    description: "x"',
          '',
        ].join('\n'),
        'utf8'
      );
      const taskPath = join(dir, 'docs/tasks/demo-program/TASK-DM-050.md');
      const frontmatter = (status) =>
        [
          '---',
          'id: TASK-DM-050',
          'title: "Demo"',
          'program: NEXUS-DEMO',
          'project: demo/project',
          'milestone: DEMO-M1',
          'epic: DEMO-EPIC',
          `status: ${status}`,
          'priority: medium',
          'owner_role: backend',
          'created: 2026-07-18',
          'source: "fixture"',
          '---',
          'Demo.',
          '',
        ].join('\n');
      writeFileSync(taskPath, frontmatter('ready'), 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });

      // Illegal: ready -> done directly, skipping in_progress — and this
      // MUST be committed (not left dirty in the working tree), because
      // the default diff-base is `HEAD~1` (the previous COMMIT), matching
      // the normal "commit, then run the gate" workflow (QUALITY.md 6.
      // pont: checkpoint minden nagyobb lépés után). An uncommitted-only
      // edit would never differ from `HEAD~1` vs the working tree read by
      // discoverTasks() in the way this test needs — it needs a SECOND
      // commit so HEAD~1 resolves to the 'ready' commit and the working
      // tree (== HEAD) is 'done'.
      writeFileSync(taskPath, frontmatter('done'), 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'illegal jump'], { cwd: dir });

      // Spawn the ACTUAL CLI as a subprocess (not runChecks() directly) with
      // ZERO flags — this is the exact "npm run check:tasks" invocation
      // real developers and CI use. execFileSync throws synchronously on a
      // non-zero exit; the thrown error carries stdout/stderr/status.
      const scriptPath = resolve(repoRoot, 'scripts/check-tasks.mjs');
      let error;
      try {
        execFileSync(process.execPath, [scriptPath, '--root', dir], { encoding: 'utf8' });
      } catch (err) {
        error = err;
      }
      assert.ok(error, 'expected the CLI to exit non-zero with zero flags');
      assert.equal(error.status, 1);
      assert.match(error.stderr ?? '', /Jogosulatlan státuszátmenet.*ready.*done/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── checkEpicsMembership — bidirectional EPICS.yaml <-> task-file check ────

describe('checkEpicsMembership', () => {
  // Uses the positive fixture's real, on-disk task files so existsSync()
  // checks inside checkEpicsMembership resolve honestly (an earlier version
  // of this test pointed at made-up paths and accidentally exercised the
  // "file doesn't exist" branch instead of the intended one).
  const fixtureRoot = resolve(fixturesRoot, 'positive');
  const epicsAbs = resolve(fixtureRoot, 'docs/projects/EPICS.yaml');
  const tasks = [
    { id: 'TASK-DP-099', relFile: 'docs/tasks/development-process/archive/TASK-DP-099-demo-archived.md' },
    { id: 'TASK-DP-100', relFile: 'docs/tasks/development-process/TASK-DP-100-demo.md' },
  ];

  test('clean bidirectional membership produces no errors', () => {
    const epicsDoc = {
      epics: [{
        id: 'EPIC-1',
        tasks: [
          { id: 'TASK-DP-099', file: '../tasks/development-process/archive/TASK-DP-099-demo-archived.md' },
          { id: 'TASK-DP-100', file: '../tasks/development-process/TASK-DP-100-demo.md' },
        ],
      }],
    };
    const errors = checkEpicsMembership({ epicsDoc, epicsAbs, tasks, root: fixtureRoot });
    assert.deepEqual(errors, []);
  });

  test('a discovered task absent from every epics[].tasks[] is an orphan', () => {
    const epicsDoc = {
      epics: [{ id: 'EPIC-1', tasks: [{ id: 'TASK-DP-099', file: '../tasks/development-process/archive/TASK-DP-099-demo-archived.md' }] }],
    };
    const errors = checkEpicsMembership({ epicsDoc, epicsAbs, tasks, root: fixtureRoot });
    assert.ok(errors.some((e) => e.file === 'docs/tasks/development-process/TASK-DP-100-demo.md' && e.field === 'epic-membership'));
  });

  test('a file-path mismatch between EPICS.yaml and the discovered file is reported', () => {
    const epicsDoc = {
      epics: [{
        id: 'EPIC-1',
        tasks: [
          { id: 'TASK-DP-099', file: '../tasks/development-process/TASK-DP-100-demo.md' }, // wrong: swapped
          { id: 'TASK-DP-100', file: '../tasks/development-process/TASK-DP-100-demo.md' },
        ],
      }],
    };
    const errors = checkEpicsMembership({ epicsDoc, epicsAbs, tasks, root: fixtureRoot });
    assert.ok(
      errors.some(
        (e) => e.file === 'docs/tasks/development-process/archive/TASK-DP-099-demo-archived.md' && /más fájlútvonalat/.test(e.message)
      )
    );
  });

  test('missing epics[] array is a hard error, not a silent pass', () => {
    const errors = checkEpicsMembership({ epicsDoc: {}, epicsAbs, tasks: [], root: fixtureRoot });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].field, 'epics');
  });
});

// ─── checkEpicsReferences — frontmatter program/milestone/epic VALUE check ─
//
// Regression suite for the independent review's gap #1 (2026-07-18, 1st
// round REQUEST_CHANGES): checkEpicsMembership only ever validated task-id +
// file-path bidirectional membership, never the frontmatter program/
// milestone/epic VALUES against EPICS.yaml's actual id sets.

describe('checkEpicsReferences', () => {
  // NOTE: DEMO-EPIC's own `milestone: 'DEMO-M2'` deliberately DIFFERS from
  // the milestone TASK-DM-050 declares in the tests below (`DEMO-M1`) — this
  // is not a typo. It bakes the 2nd-round independent review's 3rd found gap
  // (2026-07-18) directly into the baseline fixture: an epic's `milestone`
  // marks its own CLOSING milestone, not a value every member task must
  // share (live precedent: the real repo's QC-VERIFICATION epic closes at
  // QC-M4 while TASK-QC-005/006/011/012/013 are QC-M2 tasks). `program`
  // equality, unlike `milestone`, has no such exception and IS enforced.
  const epicsDoc = {
    programs: [
      { id: 'NEXUS-DEMO', milestones: [{ id: 'DEMO-M1' }, { id: 'DEMO-M2' }] },
      { id: 'OTHER-PROGRAM', milestones: [{ id: 'OTHER-M1' }] },
    ],
    epics: [
      { id: 'DEMO-EPIC', program: 'NEXUS-DEMO', milestone: 'DEMO-M2', tasks: [{ id: 'TASK-DM-050', file: 'x' }] },
      { id: 'OTHER-EPIC', program: 'OTHER-PROGRAM', milestone: 'OTHER-M1', tasks: [{ id: 'TASK-DM-051', file: 'x' }] },
    ],
  };

  test('valid program/milestone/epic references produce no errors', () => {
    const tasks = [
      { id: 'TASK-DM-050', relFile: 'a.md', data: { program: 'NEXUS-DEMO', milestone: 'DEMO-M1', epic: 'DEMO-EPIC' } },
    ];
    assert.deepEqual(checkEpicsReferences({ epicsDoc, tasks }), []);
  });

  test('a fabricated program that does not exist in EPICS.yaml is reported', () => {
    const tasks = [{ id: 'TASK-DM-050', relFile: 'a.md', data: { program: 'FAKE-PROGRAM', epic: 'DEMO-EPIC' } }];
    const errors = checkEpicsReferences({ epicsDoc, tasks });
    assert.ok(errors.some((e) => e.field === 'program'));
  });

  test('a fabricated epic that does not exist in EPICS.yaml is reported', () => {
    const tasks = [{ id: 'TASK-DM-050', relFile: 'a.md', data: { program: 'NEXUS-DEMO', epic: 'FAKE-EPIC' } }];
    const errors = checkEpicsReferences({ epicsDoc, tasks });
    assert.ok(errors.some((e) => e.field === 'epic' && /nem létezik/.test(e.message)));
  });

  test('a milestone that does not belong to the referenced program is reported', () => {
    const tasks = [{ id: 'TASK-DM-050', relFile: 'a.md', data: { program: 'NEXUS-DEMO', milestone: 'NO-SUCH-MILESTONE' } }];
    const errors = checkEpicsReferences({ epicsDoc, tasks });
    assert.ok(errors.some((e) => e.field === 'milestone'));
  });

  test('the independent review repro: all three fabricated, task still correctly file-registered', () => {
    // Mirrors the exact reproduction from the 2026-07-18 1st-round review:
    // task-id + path are correct in EPICS.yaml epics[].tasks[] (so
    // checkEpicsMembership alone would say "OK"), but program/milestone/epic
    // are all made up.
    const tasks = [
      {
        id: 'TASK-DM-050',
        relFile: 'a.md',
        data: { program: 'NEXUS-COMPLETELY-FAKE-PROGRAM-XYZ', milestone: 'FAKE-MILESTONE-XYZ', epic: 'EPIC-TOTALLY-DIFFERENT-AND-NONEXISTENT' },
      },
    ];
    const errors = checkEpicsReferences({ epicsDoc, tasks });
    assert.equal(errors.length, 3);
    assert.deepEqual(new Set(errors.map((e) => e.field)), new Set(['program', 'milestone', 'epic']));
  });

  test('epic-milestone crossing is NOT an error when program matches (QC-VERIFICATION precedent)', () => {
    // DEMO-EPIC's own milestone is 'DEMO-M2' (its closing milestone), but
    // TASK-DM-050 declares 'DEMO-M1' — same as the real repo's
    // QC-VERIFICATION epic (closes at QC-M4) vs. TASK-QC-005/006/011/012/013
    // (QC-M2 tasks). This must stay green: milestone equality between an
    // epic and its member tasks is explicitly NOT required (task-schema.json
    // documents this; see also the 2026-07-18 2nd-round independent review).
    const tasks = [
      { id: 'TASK-DM-050', relFile: 'a.md', data: { program: 'NEXUS-DEMO', milestone: 'DEMO-M1', epic: 'DEMO-EPIC' } },
    ];
    assert.deepEqual(checkEpicsReferences({ epicsDoc, tasks }), []);
  });

  test('a program mismatch between the task and its own correctly-registered epic IS reported (no exception)', () => {
    // Unlike milestone, program equality between a task and its epic has no
    // known legitimate exception (2026-07-18 2nd-round review: 0 real
    // program-mismatches found in the repo, vs. 5 real milestone-crossings).
    // TASK-DM-051 is registered under OTHER-EPIC (program: OTHER-PROGRAM),
    // but its own frontmatter claims program: NEXUS-DEMO.
    const tasks = [
      { id: 'TASK-DM-051', relFile: 'b.md', data: { program: 'NEXUS-DEMO', epic: 'OTHER-EPIC' } },
    ];
    const errors = checkEpicsReferences({ epicsDoc, tasks });
    assert.ok(errors.some((e) => e.field === 'program' && /OTHER-PROGRAM/.test(e.message)));
  });

  test('an epic that exists but is not the one this task is actually registered under is reported', () => {
    // TASK-DM-050 is registered under DEMO-EPIC in epicsDoc.epics[].tasks[]
    // above, but its own frontmatter claims a DIFFERENT, real epic.
    const tasks = [{ id: 'TASK-DM-050', relFile: 'a.md', data: { program: 'NEXUS-DEMO', epic: 'OTHER-EPIC' } }];
    const errors = checkEpicsReferences({ epicsDoc, tasks });
    assert.ok(errors.some((e) => e.field === 'epic' && /más.*epic|'DEMO-EPIC'/i.test(e.message)));
  });

  test('a task not registered under any epic (orphan) does not also get a spurious mismatch error', () => {
    // checkEpicsMembership already reports orphans separately; checkEpicsReferences
    // must not pile on a confusing second "mismatch" error when there is
    // simply no registration to compare against.
    const tasks = [{ id: 'TASK-DM-999-UNREGISTERED', relFile: 'a.md', data: { program: 'NEXUS-DEMO', epic: 'DEMO-EPIC' } }];
    assert.deepEqual(checkEpicsReferences({ epicsDoc, tasks }), []);
  });

  test('a missing/invalid EPICS.yaml document is a silent no-op here (loadEpics/checkEpicsMembership already flag it)', () => {
    assert.deepEqual(checkEpicsReferences({ epicsDoc: null, tasks: [{ id: 'X', relFile: 'a.md', data: {} }] }), []);
    assert.deepEqual(checkEpicsReferences({ epicsDoc: {}, tasks: [{ id: 'X', relFile: 'a.md', data: {} }] }), []);
  });
});

// ─── checkProgramReadme — loose link check over a program README table ─────

describe('checkProgramReadme', () => {
  function withTempTasksDir(readmeBody, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'check-tasks-readme-'));
    try {
      const programDir = join(dir, 'demo-program');
      mkdirSync(programDir, { recursive: true });
      writeFileSync(join(programDir, 'README.md'), readmeBody, 'utf8');
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a README link to an existing file produces no error', () => {
    withTempTasksDir(
      '| [TASK-DM-001 — Demo](TASK-DM-001-demo.md) |\n',
      (tasksRoot) => {
        writeFileSync(join(tasksRoot, 'demo-program', 'TASK-DM-001-demo.md'), '---\n---\n', 'utf8');
        const errors = checkProgramReadme({ root: tasksRoot, tasksDir: '.', taskIds: new Set(['TASK-DM-001']) });
        assert.deepEqual(errors, []);
      }
    );
  });

  test('a README link to a non-existent file is reported', () => {
    withTempTasksDir(
      '| [TASK-DM-002 — Removed](TASK-DM-002-removed.md) |\n',
      (tasksRoot) => {
        const errors = checkProgramReadme({ root: tasksRoot, tasksDir: '.', taskIds: new Set() });
        assert.ok(errors.some((e) => e.field === 'readme-link' && /TASK-DM-002/.test(e.message)));
      }
    );
  });

  test('external URLs in README links are ignored, not resolved as files', () => {
    withTempTasksDir(
      '| [TASK-DM-003 — External](https://example.com/spec) |\n',
      (tasksRoot) => {
        const errors = checkProgramReadme({ root: tasksRoot, tasksDir: '.', taskIds: new Set() });
        assert.deepEqual(errors, []);
      }
    );
  });
});

// ─── extractEvidenceBlock ────────────────────────────────────────────────────

describe('extractEvidenceBlock', () => {
  test('parses a fenced execution_evidence YAML block', () => {
    const content = [
      '## Implementáció',
      '',
      '```yaml',
      'execution_evidence:',
      '  task_id: TASK-DP-003',
      '  goal: "demo"',
      '```',
    ].join('\n');
    const evidence = extractEvidenceBlock(content, yaml);
    assert.equal(evidence?.task_id, 'TASK-DP-003');
    assert.equal(evidence?.goal, 'demo');
  });

  test('returns null when no execution_evidence key is present', () => {
    assert.equal(extractEvidenceBlock('## Implementáció\n\nNincs evidence blokk.', yaml), null);
  });

  test('returns null when the block is malformed YAML', () => {
    const content = 'execution_evidence:\n  task_id: [unterminated';
    assert.equal(extractEvidenceBlock(content, yaml), null);
  });
});

// ─── checkArchiveInvariants ──────────────────────────────────────────────────

describe('checkArchiveInvariants', () => {
  const baseTask = (overrides) => ({
    relFile: 'docs/tasks/development-process/archive/TASK-DP-999-demo.md',
    programDir: 'development-process',
    data: { status: 'done' },
    content: '## Implementáció (2026-07-18)\n\nDemo.',
    ...overrides,
  });

  test('archived task missing the required status is reported', () => {
    const errors = checkArchiveInvariants({ task: baseTask({ data: { status: 'ready' } }), schema, yaml });
    assert.ok(errors.some((e) => e.field === 'status'));
  });

  test('archived task missing the Implementáció section is reported', () => {
    const errors = checkArchiveInvariants({ task: baseTask({ content: 'no section here' }), schema, yaml });
    assert.ok(errors.some((e) => e.field === 'body'));
  });

  test('development-process archive requires a parseable execution_evidence block', () => {
    const errors = checkArchiveInvariants({ task: baseTask({}), schema, yaml });
    assert.ok(errors.some((e) => e.field === 'execution_evidence'));
  });

  test('development-process archive rejects a non-independent reviewer', () => {
    const content = [
      '## Implementáció (2026-07-18)',
      '```yaml',
      'execution_evidence:',
      '  task_id: TASK-DP-999',
      '  goal: "demo"',
      '  success_criteria: ["demo"]',
      '  exit_condition: "demo"',
      '  base_commit: "0000000"',
      '  branch: "demo"',
      '  commits: ["0000000"]',
      '  pull_request: "N/A"',
      '  environments: []',
      '  commands: []',
      '  reviewer:',
      '    identity: "same-as-author"',
      '    independent: false',
      '    decision: PASS',
      '    evidence: "self-reviewed"',
      '  state_sync: {}',
      '```',
    ].join('\n');
    const errors = checkArchiveInvariants({ task: baseTask({ content }), schema, yaml });
    assert.ok(errors.some((e) => e.field === 'execution_evidence.reviewer.independent'));
  });

  test('a program without a perProgram entry falls back to the least-strict default (no evidence-block requirement)', () => {
    const errors = checkArchiveInvariants({
      task: baseTask({ programDir: 'some-future-program' }),
      schema,
      yaml,
    });
    assert.ok(!errors.some((e) => e.field === 'execution_evidence'));
  });
});

// ─── Fixture-driven end-to-end checks (runChecks) ───────────────────────────

describe('runChecks against curated fixtures', () => {
  test('positive fixture is fully clean', () => {
    const { errors, taskCount } = runChecks({
      root: resolve(fixturesRoot, 'positive'),
      tasksDir: 'docs/tasks',
      epicsPath: 'docs/projects/EPICS.yaml',
      schema,
      diffBase: null,
      matter,
      yaml,
    });
    assert.equal(taskCount, 2);
    assert.deepEqual(errors, []);
  });

  const negativeCases = [
    { dir: 'invalid-yaml', expectField: '(frontmatter)' },
    { dir: 'duplicate-id', expectField: 'id' },
    { dir: 'cyclic-dependency', expectField: 'depends_on' },
    { dir: 'self-dependency', expectField: 'depends_on' },
    { dir: 'missing-dependency', expectField: 'depends_on' },
    { dir: 'missing-parallel-with', expectField: 'parallel_with' },
    { dir: 'orphan-task', expectField: 'epic-membership' },
    { dir: 'epics-file-mismatch', expectField: 'epic-membership' },
    { dir: 'bad-fields', expectField: 'status' },
    { dir: 'archive-not-done', expectField: 'status' },
    { dir: 'archive-missing-evidence', expectField: 'execution_evidence' },
    { dir: 'epic-reference-fabricated', expectField: 'program' },
    { dir: 'epic-program-mismatch', expectField: 'program' },
  ];

  for (const { dir, expectField } of negativeCases) {
    test(`negative fixture '${dir}' fails with at least one '${expectField}' error`, () => {
      const { errors } = runChecks({
        root: resolve(fixturesRoot, 'negative', dir),
        tasksDir: 'docs/tasks',
        epicsPath: 'docs/projects/EPICS.yaml',
        schema,
        diffBase: null,
        matter,
        yaml,
      });
      assert.ok(errors.length > 0, `expected ${dir} to fail, got 0 errors`);
      assert.ok(
        errors.some((e) => e.field === expectField),
        `expected a '${expectField}' error in ${dir}, got: ${JSON.stringify(errors)}`
      );
    });
  }

  test('archive-self-review fixture fails on reviewer.independent, not on evidence absence', () => {
    const { errors } = runChecks({
      root: resolve(fixturesRoot, 'negative/archive-self-review'),
      tasksDir: 'docs/tasks',
      epicsPath: 'docs/projects/EPICS.yaml',
      schema,
      diffBase: null,
      matter,
      yaml,
    });
    assert.ok(errors.some((e) => e.field === 'execution_evidence.reviewer.independent'));
    assert.ok(!errors.some((e) => e.field === 'execution_evidence'));
  });
});

// ─── Integration test against the REAL repository ──────────────────────────
//
// This does NOT assert `errors.length === 0` — TASK-DP-003's own file
// boundary forbids fixing every pre-existing task file in the repo (only
// docs/tasks/task-schema.json, scripts/check-tasks.mjs, its fixtures, and
// TASK-QC-008A…E's frontmatter are in scope). Running the real gate
// surfaced genuine, pre-existing findings outside that boundary (see
// TASK-DP-003 "Implementáció" section for the full list). What this test
// DOES guard, as a regression baseline, are invariants that are true today
// and must stay true:
//   - every real task file's frontmatter is parseable YAML (the QC-008A…E
//     fix eliminated the only known parse failures);
//   - there is no duplicate task id;
//   - there is no cyclic depends_on graph.
describe('integration: real repository docs/tasks', () => {
  test('every discovered task frontmatter parses (no YAML syntax errors)', () => {
    const tasks = discoverTasks({ root: repoRoot, tasksDir: 'docs/tasks', matter });
    assert.ok(tasks.length > 10, 'expected the real repo to contain more than 10 task files');
    const parseFailures = tasks.filter((t) => t.parseError);
    assert.deepEqual(
      parseFailures.map((t) => t.relFile),
      []
    );
  });

  test('no duplicate task ids and no cyclic depends_on graph', () => {
    const { errors } = runChecks({
      root: repoRoot,
      tasksDir: 'docs/tasks',
      epicsPath: 'docs/projects/EPICS.yaml',
      schema,
      diffBase: null,
      matter,
      yaml,
    });
    assert.deepEqual(
      errors.filter((e) => e.field === 'id'),
      []
    );
    assert.deepEqual(
      errors.filter((e) => /Ciklikus/.test(e.message)),
      []
    );
  });

  test('docs/projects/EPICS.yaml itself parses', () => {
    const { error } = loadEpics({ root: repoRoot, epicsPath: 'docs/projects/EPICS.yaml', yaml });
    assert.equal(error, null);
  });

  test('no task/epic program mismatches (checkEpicsReferences) — 0 known exceptions, unlike milestone', () => {
    // 2026-07-18 2nd-round independent review: 0 program-mismatches found
    // live in the repo, vs. 5 real milestone-crossings (QC-VERIFICATION
    // epic + TASK-QC-005/006/011/012/013 — legitimate, see task-schema.json
    // and the "epic-milestone crossing" unit test above). This asserts that
    // positive finding stays true, without asserting 0 errors overall (the
    // 23 blocked_reason + 2 execution_evidence findings are real,
    // pre-existing, out-of-file-boundary — see the task's Implementáció).
    const { errors } = runChecks({
      root: repoRoot,
      tasksDir: 'docs/tasks',
      epicsPath: 'docs/projects/EPICS.yaml',
      schema,
      diffBase: null,
      matter,
      yaml,
    });
    assert.deepEqual(
      errors.filter((e) => e.field === 'program'),
      []
    );
  });

  test('the real QC-VERIFICATION milestone-crossing tasks produce zero errors', () => {
    // Direct, targeted positive proof for the exact live precedent named in
    // the review and in checkEpicsReferences' own code comment.
    const { doc: epicsDoc } = loadEpics({ root: repoRoot, epicsPath: 'docs/projects/EPICS.yaml', yaml });
    const tasks = discoverTasks({ root: repoRoot, tasksDir: 'docs/tasks', matter }).filter((t) =>
      ['TASK-QC-005', 'TASK-QC-006', 'TASK-QC-011', 'TASK-QC-012', 'TASK-QC-013'].includes(t.id)
    );
    assert.equal(tasks.length, 5, 'expected to find all 5 known QC-VERIFICATION milestone-crossing tasks');
    assert.ok(
      tasks.every((t) => t.data.milestone === 'QC-M2'),
      'expected these tasks to still declare milestone: QC-M2 (if this changed, update or retire this regression guard)'
    );
    assert.deepEqual(checkEpicsReferences({ epicsDoc, tasks }), []);
  });
});

// ── TASK-DP-007 review P2 fix: explicit --diff-base must fail closed ─────────
// An unresolvable explicit base ref used to degrade silently: every git-show
// failed, every task looked "new", and the status-transition check skipped
// without a trace. The CLI now exits 2 before running any checks.
describe('explicit --diff-base fail-closed validation (CLI)', () => {
  const script = resolve(here, '../check-tasks.mjs');

  function makeTempGitRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'check-tasks-explicit-base-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'first', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: dir });
    return dir;
  }

  test('an unresolvable explicit --diff-base exits 2 with a loud error', () => {
    const dir = makeTempGitRepo();
    try {
      execFileSync(process.execPath, [script, '--root', dir, '--diff-base', 'no-such-ref-xyz'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.fail('expected exit 2');
    } catch (err) {
      assert.equal(err.status, 2);
      assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /nem oldható fel commitra/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a resolvable explicit --diff-base is accepted (no exit-2 validation error)', () => {
    const dir = makeTempGitRepo();
    try {
      // The fixture repo has no docs/tasks tree, so the run may fail LATER for
      // structural reasons — the assertion is only that the diff-base
      // validation itself passes (the exit-2 message is absent).
      let out = '';
      try {
        out = execFileSync(process.execPath, [script, '--root', dir, '--diff-base', 'HEAD'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
      assert.doesNotMatch(out, /nem oldható fel commitra/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
