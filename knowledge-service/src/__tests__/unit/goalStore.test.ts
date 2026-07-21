/**
 * goalStore unit tests — hermetic, temp-dir goal store (ADR-059).
 *
 * PINS the contract:
 *  - goals are YAML files under GOALS_DIR; createGoal writes them, CRUD helpers
 *    round-trip them, and status transitions (watching -> triggered / completed /
 *    expired) rewrite the file on disk;
 *  - completion criteria are evaluated against the on-disk terminals tree
 *    (done_outbox, message_status) and EPICS.yaml (checkpoint_status), with
 *    error branches degrading to { met: false, details: 'Error: ...' };
 *  - all_of is vacuously true when empty, any_of is false when empty;
 *  - renderPrompt substitutes {{goal.description}}, {{on_complete.next_goal}}
 *    and {{completed_criteria}}.
 *
 * Everything lives under os.tmpdir(); env overrides are applied BEFORE the
 * module is imported (config/paths.ts reads process.env at import).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';

// ─── Hermetic environment (must precede any src import) ──────────────────────

const runId = crypto.randomBytes(6).toString('hex');
const ROOT = path.join(os.tmpdir(), `goalstore-${runId}`);
const GOALS = path.join(ROOT, 'store', 'goals');
const TERMINALS = path.join(ROOT, 'terminals');
const EPICS = path.join(ROOT, 'EPICS.yaml');

process.env.SPACEOS_ROOT = ROOT;
process.env.DATA_DIR = path.join(ROOT, 'data');
process.env.GOALS_DIR = GOALS;
process.env.TERMINALS_PATH = TERMINALS;
process.env.EPICS_PATH = EPICS;
process.env.AGENTS_CONFIG_PATH = path.join(ROOT, `no-agents-${runId}.yaml`);
process.env.AUTH_MODE = 'open';
delete process.env.MCP_AUTH_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MCP_TOKEN_')) delete process.env[key];
}

type GoalStore = typeof import('../../goalStore');
type CreateGoalParams = import('../../goalStore').CreateGoalParams;
type CriteriaType = import('../../goalStore').CriteriaType;
let store: GoalStore;

/** Space creations apart so `created` timestamps differ for ordering assertions. */
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function goalParams(overrides: Partial<CreateGoalParams> = {}): CreateGoalParams {
  return {
    created_by: 'root',
    description: 'Ship the QA epic',
    completion_criteria: [
      { type: 'done_outbox' as const, terminal: 't1', message_pattern: 'alpha-*' },
    ],
    trigger_terminal: 'conductor',
    prompt: 'Goal done: {{goal.description}}',
    ...overrides,
  };
}

beforeAll(async () => {
  // Criteria fixtures: terminal outboxes + inboxes + EPICS.yaml
  fs.mkdirSync(path.join(TERMINALS, 't1', 'outbox'), { recursive: true });
  fs.mkdirSync(path.join(TERMINALS, 't1', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(TERMINALS, 't2', 'outbox'), { recursive: true });
  fs.mkdirSync(path.join(TERMINALS, 't2', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(TERMINALS, 't3', 'outbox'), { recursive: true });
  fs.mkdirSync(path.join(TERMINALS, '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(TERMINALS, '_shared'), { recursive: true });

  // done_outbox fixtures
  fs.writeFileSync(
    path.join(TERMINALS, 't1', 'outbox', 'alpha-report.md'),
    '---\ntype: done\n---\nAll finished.',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(TERMINALS, 't2', 'outbox', 'beta-done.md'),
    'no type marker here, filename carries the signal',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(TERMINALS, 't3', 'outbox', 'gamma-open.md'),
    'still in progress',
    'utf-8'
  );
  fs.writeFileSync(path.join(TERMINALS, 't3', 'outbox', 'noise.txt'), 'not markdown', 'utf-8');

  // message_status fixtures
  fs.writeFileSync(
    path.join(TERMINALS, 't1', 'inbox', 'task.md'),
    '---\nid: MSG-STAT-1\nstatus: DONE\n---\nfinished task',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(TERMINALS, 't2', 'inbox', 'other.md'),
    '---\nid: MSG-STAT-2\nstatus: UNREAD\n---\nwaiting task',
    'utf-8'
  );

  // checkpoint_status fixture
  fs.writeFileSync(
    EPICS,
    [
      'epics:',
      '  - id: E1',
      '    checkpoints:',
      '      - id: CP-DONE',
      '        status: done',
      '      - id: CP-PEND',
      '        status: pending',
      '  - id: E2',
    ].join('\n'),
    'utf-8'
  );

  store = await import('../../goalStore');
});

// ─── CRUD ─────────────────────────────────────────────────────────────────────

describe('goal CRUD lifecycle', () => {
  it('listGoals returns [] before the goals directory exists (ENOENT branch)', async () => {
    expect(fs.existsSync(GOALS)).toBe(false);
    const goals = await store.listGoals();
    expect(goals).toEqual([]);
  });

  it('createGoal writes a YAML file and returns a watching goal without expiry', async () => {
    const goal = await store.createGoal(goalParams());
    expect(goal.id).toMatch(/^GOAL-\d{4}-\d{2}-\d{2}-\d{3}$/);
    expect(goal.status).toBe('watching');
    expect(goal.expires_at).toBeUndefined();
    expect(goal.created_by).toBe('root');
    expect(goal.goal.description).toBe('Ship the QA epic');
    expect(goal.on_complete.trigger_terminal).toBe('conductor');

    const file = path.join(GOALS, `${goal.id}.yaml`);
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = yaml.load(fs.readFileSync(file, 'utf-8')) as {
      id: string;
      goal: { description: string };
    };
    expect(onDisk.id).toBe(goal.id);
    expect(onDisk.goal.description).toBe('Ship the QA epic');
  });

  it('createGoal computes expires_at from expires_in_hours', async () => {
    await tick();
    const goal = await store.createGoal(goalParams({ expires_in_hours: 2 }));
    expect(goal.expires_at).toBeTruthy();
    const deltaMs = Date.parse(goal.expires_at!) - Date.parse(goal.created);
    // ~2 hours ahead of creation (generous tolerance, no perf assertion)
    expect(deltaMs).toBeGreaterThan(1.9 * 60 * 60 * 1000);
    expect(deltaMs).toBeLessThan(2.1 * 60 * 60 * 1000);
  });

  it('getGoal round-trips a stored goal and returns null for unknown ids', async () => {
    await tick();
    const created = await store.createGoal(goalParams({ description: 'roundtrip me' }));
    const loaded = await store.getGoal(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.goal.description).toBe('roundtrip me');
    expect(await store.getGoal('GOAL-DOES-NOT-EXIST')).toBeNull();
  });

  it('getGoal rethrows non-ENOENT filesystem errors', async () => {
    // A directory named like a goal file: readFile fails with EISDIR, not ENOENT.
    const trap = path.join(GOALS, 'GOAL-EVIL-DIR.yaml');
    fs.mkdirSync(trap, { recursive: true });
    try {
      await expect(store.getGoal('GOAL-EVIL-DIR')).rejects.toThrow();
    } finally {
      fs.rmdirSync(trap); // keep the store clean for listGoals tests below
    }
  });

  it('updateGoal persists modifications to the YAML file', async () => {
    await tick();
    const goal = await store.createGoal(goalParams());
    goal.epic_id = 'EPIC-QA-006';
    await store.updateGoal(goal);
    const reloaded = await store.getGoal(goal.id);
    expect(reloaded!.epic_id).toBe('EPIC-QA-006');
  });

  it('listGoals sorts newest first, filters by status and skips non-YAML files', async () => {
    fs.writeFileSync(path.join(GOALS, 'notes.txt'), 'not a goal', 'utf-8');
    await tick();
    const older = await store.createGoal(goalParams({ description: 'older goal' }));
    await tick(20);
    const newer = await store.createGoal(goalParams({ description: 'newer goal' }));

    const all = await store.listGoals();
    const ids = all.map((g) => g.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id)); // newest first

    const watching = await store.listGoals('watching');
    expect(watching.every((g) => g.status === 'watching')).toBe(true);

    const triggered = await store.listGoals('triggered');
    expect(triggered.find((g) => g.id === newer.id)).toBeUndefined();
  });
});

// ─── ID allocation (TASK-QC-012) ──────────────────────────────────────────────

describe('goal ID allocation under concurrency (TASK-QC-012)', () => {
  it('12 concurrent createGoal() calls all receive unique IDs and files', async () => {
    const before = (await store.listGoals()).length;

    const goals = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.createGoal(goalParams({ description: `concurrent goal #${i}` }))
      )
    );

    const ids = goals.map((g) => g.id);
    // No collision: every ID is unique — the old Date.now()-suffix collided
    // within the same millisecond window and silently overwrote goals.
    expect(new Set(ids).size).toBe(ids.length);

    // Format contract preserved: GOAL-YYYY-MM-DD-NNN
    for (const goal of goals) {
      expect(goal.id).toMatch(/^GOAL-\d{4}-\d{2}-\d{2}-\d{3}$/);
      expect(fs.existsSync(path.join(GOALS, `${goal.id}.yaml`))).toBe(true);
    }

    // No silent overwrite: every created goal is present in the store.
    const after = await store.listGoals();
    expect(after.length).toBe(before + 12);
  });
});

// ─── Status transitions ───────────────────────────────────────────────────────

describe('goal status transitions', () => {
  it('triggerGoal records trigger metadata and criteria results', async () => {
    await tick();
    const goal = await store.createGoal(goalParams());
    const results = [
      {
        criterion: { type: 'done_outbox' as const, terminal: 't1' },
        met: true,
        details: 'Found: alpha-report.md',
        checked_at: new Date().toISOString(),
      },
    ];
    const triggered = await store.triggerGoal(goal.id, 'MSG-TRIGGER-1', results);
    expect(triggered).not.toBeNull();
    expect(triggered!.status).toBe('triggered');
    expect(triggered!.trigger_message_id).toBe('MSG-TRIGGER-1');
    expect(triggered!.triggered_at).toBeTruthy();
    expect(triggered!.criteria_results).toHaveLength(1);

    const onDisk = await store.getGoal(goal.id);
    expect(onDisk!.status).toBe('triggered');
  });

  it('triggerGoal / completeGoal / expireGoal return null for unknown goals', async () => {
    expect(await store.triggerGoal('GOAL-NOPE', 'MSG-X', [])).toBeNull();
    expect(await store.completeGoal('GOAL-NOPE')).toBeNull();
    expect(await store.expireGoal('GOAL-NOPE')).toBeNull();
  });

  it('completeGoal stamps completed_at', async () => {
    await tick();
    const goal = await store.createGoal(goalParams());
    const completed = await store.completeGoal(goal.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.completed_at).toBeTruthy();
    expect((await store.getGoal(goal.id))!.status).toBe('completed');
  });

  it('expireGoal marks the goal expired', async () => {
    await tick();
    const goal = await store.createGoal(goalParams());
    const expired = await store.expireGoal(goal.id);
    expect(expired!.status).toBe('expired');
    expect((await store.getGoal(goal.id))!.status).toBe('expired');
  });

  it('checkExpiredGoals expires only watching goals whose expires_at is past', async () => {
    await tick();
    const overdue = await store.createGoal(goalParams({ expires_in_hours: 1 }));
    overdue.expires_at = new Date(Date.now() - 60_000).toISOString(); // already past
    await store.updateGoal(overdue);

    await tick();
    const evergreen = await store.createGoal(goalParams()); // no expiry

    const expiredIds = await store.checkExpiredGoals();
    expect(expiredIds).toContain(overdue.id);
    expect(expiredIds).not.toContain(evergreen.id);
    expect((await store.getGoal(overdue.id))!.status).toBe('expired');
    expect((await store.getGoal(evergreen.id))!.status).toBe('watching');
  });
});

// ─── Criteria checking ────────────────────────────────────────────────────────

describe('checkCriterion — done_outbox', () => {
  it('is met when a matching file declares type: done', async () => {
    const r = await store.checkCriterion({
      type: 'done_outbox',
      terminal: 't1',
      message_pattern: 'alpha-*',
    });
    expect(r.met).toBe(true);
    expect(r.details).toBe('Found: alpha-report.md');
    expect(r.checked_at).toBeTruthy();
  });

  it('is met when the matching filename itself contains "done"', async () => {
    const r = await store.checkCriterion({
      type: 'done_outbox',
      terminal: 't2',
      message_pattern: 'beta-don?',
    });
    expect(r.met).toBe(true);
    expect(r.details).toBe('Found: beta-done.md');
  });

  it('defaults message_pattern to * when omitted', async () => {
    const r = await store.checkCriterion({ type: 'done_outbox', terminal: 't1' });
    expect(r.met).toBe(true);
  });

  it('is not met when matching files carry no done signal', async () => {
    const r = await store.checkCriterion({
      type: 'done_outbox',
      terminal: 't3',
      message_pattern: 'gamma-*',
    });
    expect(r.met).toBe(false);
    expect(r.details).toContain('No match for pattern');
  });

  it('degrades to an error detail when the outbox does not exist', async () => {
    const r = await store.checkCriterion({
      type: 'done_outbox',
      terminal: 'ghost-terminal',
      message_pattern: '*',
    });
    expect(r.met).toBe(false);
    expect(r.details).toMatch(/^Error:/);
  });
});

describe('checkCriterion — checkpoint_status', () => {
  it('is met when the checkpoint has the expected (default: done) status', async () => {
    const r = await store.checkCriterion({ type: 'checkpoint_status', checkpoint_id: 'CP-DONE' });
    expect(r.met).toBe(true);
    expect(r.details).toBe('Checkpoint CP-DONE is done');
  });

  it('reports the actual status when it differs from the expectation', async () => {
    const r = await store.checkCriterion({
      type: 'checkpoint_status',
      checkpoint_id: 'CP-PEND',
      expected_status: 'done',
    });
    expect(r.met).toBe(false);
    expect(r.details).toBe('Checkpoint CP-PEND is pending, expected done');
  });

  it('is not met when the checkpoint id is unknown', async () => {
    const r = await store.checkCriterion({ type: 'checkpoint_status', checkpoint_id: 'CP-NOPE' });
    expect(r.met).toBe(false);
    expect(r.details).toBe('Checkpoint CP-NOPE not found');
  });

  it('degrades to an error detail when EPICS.yaml is missing', async () => {
    const original = process.env.EPICS_PATH;
    process.env.EPICS_PATH = path.join(ROOT, 'missing-epics.yaml');
    try {
      const r = await store.checkCriterion({ type: 'checkpoint_status', checkpoint_id: 'CP-DONE' });
      expect(r.met).toBe(false);
      expect(r.details).toMatch(/^Error:/);
    } finally {
      process.env.EPICS_PATH = original;
    }
  });
});

describe('checkCriterion — message_status', () => {
  it('matches the message status case-insensitively across terminal boxes', async () => {
    const r = await store.checkCriterion({
      type: 'message_status',
      message_id: 'MSG-STAT-1',
      expected_status: 'done',
    });
    expect(r.met).toBe(true);
    expect(r.details).toBe('MSG-STAT-1 is DONE');
  });

  it('reports the actual status when it differs (default expectation: DONE)', async () => {
    const r = await store.checkCriterion({ type: 'message_status', message_id: 'MSG-STAT-2' });
    expect(r.met).toBe(false);
    expect(r.details).toBe('MSG-STAT-2 is UNREAD, expected DONE');
  });

  it('is not met when the message id is nowhere in the tree', async () => {
    const r = await store.checkCriterion({ type: 'message_status', message_id: 'MSG-NOPE' });
    expect(r.met).toBe(false);
    expect(r.details).toBe('Message MSG-NOPE not found');
  });

  it('degrades to an error detail when the terminals root is missing', async () => {
    const original = process.env.TERMINALS_PATH;
    process.env.TERMINALS_PATH = path.join(ROOT, 'no-terminals-here');
    try {
      const r = await store.checkCriterion({ type: 'message_status', message_id: 'MSG-STAT-1' });
      expect(r.met).toBe(false);
      expect(r.details).toMatch(/^Error:/);
    } finally {
      process.env.TERMINALS_PATH = original;
    }
  });
});

describe('checkCriterion — composites and unknown types', () => {
  const MET = { type: 'checkpoint_status' as const, checkpoint_id: 'CP-DONE' };
  const UNMET = { type: 'checkpoint_status' as const, checkpoint_id: 'CP-PEND' };

  it('all_of with no criteria is vacuously true', async () => {
    const r = await store.checkCriterion({ type: 'all_of', criteria: [] });
    expect(r.met).toBe(true);
    expect(r.details).toContain('vacuous');
  });

  it('all_of requires every nested criterion to be met', async () => {
    const partial = await store.checkCriterion({ type: 'all_of', criteria: [MET, UNMET] });
    expect(partial.met).toBe(false);
    expect(partial.details).toBe('1/2 criteria met');

    const full = await store.checkCriterion({ type: 'all_of', criteria: [MET, MET] });
    expect(full.met).toBe(true);
    expect(full.details).toBe('2/2 criteria met');
  });

  it('any_of with no criteria is false', async () => {
    const r = await store.checkCriterion({ type: 'any_of', criteria: [] });
    expect(r.met).toBe(false);
    expect(r.details).toBe('Empty any_of');
  });

  it('any_of is satisfied by a single met criterion', async () => {
    const some = await store.checkCriterion({ type: 'any_of', criteria: [UNMET, MET] });
    expect(some.met).toBe(true);
    expect(some.details).toBe('1/2 criteria met');

    const none = await store.checkCriterion({ type: 'any_of', criteria: [UNMET] });
    expect(none.met).toBe(false);
  });

  it('unknown criterion types are never met', async () => {
    const r = await store.checkCriterion({ type: 'telepathy' as unknown as CriteriaType });
    expect(r.met).toBe(false);
    expect(r.details).toBe('Unknown criterion type: telepathy');
  });
});

describe('checkGoalCriteria', () => {
  it('aggregates results and reports allMet correctly', async () => {
    await tick();
    const mixed = await store.createGoal(
      goalParams({
        completion_criteria: [
          { type: 'checkpoint_status', checkpoint_id: 'CP-DONE' },
          { type: 'checkpoint_status', checkpoint_id: 'CP-PEND' },
        ],
      })
    );
    const partial = await store.checkGoalCriteria(mixed);
    expect(partial.allMet).toBe(false);
    expect(partial.results).toHaveLength(2);
    expect(partial.results[0].met).toBe(true);
    expect(partial.results[1].met).toBe(false);

    await tick();
    const satisfied = await store.createGoal(
      goalParams({
        completion_criteria: [{ type: 'checkpoint_status', checkpoint_id: 'CP-DONE' }],
      })
    );
    const full = await store.checkGoalCriteria(satisfied);
    expect(full.allMet).toBe(true);
  });
});

// ─── Prompt rendering ─────────────────────────────────────────────────────────

describe('renderPrompt', () => {
  it('substitutes description, next goal and formatted criteria results', async () => {
    await tick();
    const goal = await store.createGoal(
      goalParams({
        description: 'finish QA-006',
        next_goal: 'GOAL-NEXT-1',
        prompt: 'Done: {{goal.description}} -> next {{on_complete.next_goal}}\n{{completed_criteria}}',
      })
    );
    const rendered = store.renderPrompt(goal, [
      {
        criterion: { type: 'done_outbox', terminal: 't1' },
        met: true,
        details: 'Found: alpha-report.md',
        checked_at: new Date().toISOString(),
      },
      {
        criterion: { type: 'checkpoint_status', checkpoint_id: 'CP-PEND' },
        met: false,
        details: 'still pending',
        checked_at: new Date().toISOString(),
      },
    ]);
    expect(rendered).toContain('Done: finish QA-006');
    expect(rendered).toContain('next GOAL-NEXT-1');
    expect(rendered).toContain('✓ done_outbox: Found: alpha-report.md');
    expect(rendered).toContain('✗ checkpoint_status: still pending');
  });

  it('renders an empty string for a missing next_goal', async () => {
    await tick();
    const goal = await store.createGoal(
      goalParams({ prompt: 'next=[{{on_complete.next_goal}}]' })
    );
    expect(store.renderPrompt(goal, [])).toBe('next=[]');
  });
});
