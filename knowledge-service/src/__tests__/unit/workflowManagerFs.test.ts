/**
 * workflowManager unit tests — hermetic, temp WORKFLOWS_DIR + EPICS_PATH.
 *
 * PINS the YAML workflow/epic contract:
 *  - listWorkflows: only *.yaml with an id are listed; malformed YAML and
 *    id-less files are skipped; current_step falls back to steps[0]
 *  - getWorkflowState: missing -> null, plain-string state, JSON state
 *  - setWorkflowState: plain write vs JSON+history write on transition
 *    (history lands in workflow_history AND the state file — TASK-QC-011)
 *  - advanceWorkflow: fresh (no state), mid-step, end-of-flow, bogus step,
 *    unknown workflow
 *  - generateWorkflowTask: unknown workflow/step errors, message numbering,
 *    island/terminal/model/prompt defaults, generated frontmatter+body
 *  - listEpics/getEpic/updateEpicStatus incl. missing-file and unknown-epic
 *  - getWorkflowSummary totals and handleWorkflowTool dispatch (each tool
 *    plus unknown tool error)
 *
 * Hermetic /opt handling: generateWorkflowTask hardcodes /opt/<island>/...;
 * the 'fs' module is wrapped so any /opt/... path is redirected into a temp
 * sandbox (everything else passes through to the real fs). No writes leave
 * os.tmpdir(). State DB (workflowDb) lands under a temp DATA_DIR.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pathMod = require('path');
  const runId = crypto.randomBytes(6).toString('hex');
  const root = pathMod.join(os.tmpdir(), `wfmgr-${runId}`);
  process.env.WORKFLOWS_DIR = pathMod.join(root, 'workflows');
  process.env.EPICS_PATH = pathMod.join(root, 'EPICS.yaml');
  process.env.DATA_DIR = pathMod.join(root, 'data');
  process.env.SPACEOS_ROOT = root;
  process.env.TERMINALS_PATH = pathMod.join(root, 'terminals');
  return { root, optSandbox: pathMod.join(root, 'opt-sandbox') };
});

// Redirect /opt/... into the sandbox; delegate everything else to the real fs.
vi.mock('fs', async (importOriginal) => {
  type Fs = typeof import('fs');
  const actual = await importOriginal<Fs>();
  const redirect = (p: unknown): unknown => {
    if (typeof p !== 'string') return p;
    const norm = p.replace(/\\/g, '/');
    if (norm.startsWith('/opt/')) {
      return `${H.optSandbox}/${norm.slice('/opt/'.length)}`;
    }
    return p;
  };
  const r = (p: unknown) => redirect(p) as import('fs').PathLike;
  return {
    ...actual,
    existsSync: ((p: unknown) => actual.existsSync(r(p))) as Fs['existsSync'],
    readdirSync: ((p: unknown, o?: unknown) =>
      actual.readdirSync(r(p), o as BufferEncoding)) as unknown as Fs['readdirSync'],
    readFileSync: ((p: unknown, o?: unknown) =>
      actual.readFileSync(r(p), o as BufferEncoding)) as unknown as Fs['readFileSync'],
    writeFileSync: ((p: unknown, d: unknown, o?: unknown) =>
      actual.writeFileSync(r(p), d as string, o as BufferEncoding)) as unknown as Fs['writeFileSync'],
    mkdirSync: ((p: unknown, o?: unknown) =>
      actual.mkdirSync(r(p), o as import('fs').MakeDirectoryOptions)) as unknown as Fs['mkdirSync'],
    statSync: ((p: unknown) => actual.statSync(r(p))) as unknown as Fs['statSync'],
  };
});

import * as fs from 'fs'; // the wrapped module — passthrough outside /opt

const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR!;
const EPICS_FILE = process.env.EPICS_PATH!;

let wm: typeof import('../../workflowManager');

function writeEpicsFixture(): void {
  fs.writeFileSync(EPICS_FILE, [
    'epics:',
    '  - id: EPIC-ONE',
    '    name: First epic',
    '    status: pending',
    '  - id: EPIC-TWO',
    '    name: Second epic',
    '    status: active',
    '    assignee: backend',
  ].join('\n'), 'utf-8');
}

beforeAll(async () => {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });

  fs.writeFileSync(path.join(WORKFLOWS_DIR, 'wf-alpha.yaml'), [
    'id: WF-ALPHA',
    'name: Alpha Flow',
    'description: two-step test flow',
    'focus: dev',
    'priority: high',
    'enabled: true',
    'state_file: .WF-ALPHA-state',
    'steps:',
    '  - id: step-1',
    '    name: Plan Work',
    '    terminal: conductor',
    '    island: spaceos',
    '    model: sonnet',
    '    prompt: Do the planning',
    '    next_step: step-2',
    '  - id: step-2',
    '    name: Execute',
    '    next_step: ""',
  ].join('\n'), 'utf-8');

  fs.writeFileSync(path.join(WORKFLOWS_DIR, 'wf-beta.yaml'), [
    'id: WF-BETA',
    'name: Beta Flow',
    'description: disabled single-step flow',
    'focus: ops',
    'priority: low',
    'enabled: false',
    'state_file: .WF-BETA-state',
    'steps:',
    '  - id: only-step',
    '    name: Solo Step',
    '    terminal: librarian',
    '    island: spaceos',
    '    model: haiku',
    '    prompt: Beta prompt',
    '    next_step: ""',
  ].join('\n'), 'utf-8');

  fs.writeFileSync(path.join(WORKFLOWS_DIR, 'wf-gamma.yaml'), [
    'id: WF-GAMMA',
    'name: Gamma Flow',
    'description: pristine flow for advance tests',
    'focus: dev',
    'priority: medium',
    'enabled: true',
    'state_file: .WF-GAMMA-state',
    'steps:',
    '  - id: step-a',
    '    name: Step A',
    '    terminal: conductor',
    '    island: spaceos',
    '    model: sonnet',
    '    prompt: A prompt',
    '    next_step: step-b',
    '  - id: step-b',
    '    name: Step B',
    '    terminal: conductor',
    '    island: spaceos',
    '    model: sonnet',
    '    prompt: B prompt',
    '    next_step: ""',
  ].join('\n'), 'utf-8');

  // Malformed YAML: parse error -> skipped (logged, not thrown)
  fs.writeFileSync(path.join(WORKFLOWS_DIR, 'broken.yaml'), 'id: "unclosed', 'utf-8');
  // Valid YAML without an id -> skipped
  fs.writeFileSync(path.join(WORKFLOWS_DIR, 'no-id.yaml'), 'name: nameless flow\n', 'utf-8');
  // Non-yaml file -> ignored by the extension filter
  fs.writeFileSync(path.join(WORKFLOWS_DIR, 'notes.txt'), 'not a workflow', 'utf-8');

  wm = await import('../../workflowManager');

  // workflow_states has a FOREIGN KEY on workflows(id) (enforced: better-sqlite3
  // enables foreign_keys by default), and workflowManager never registers the
  // workflow row itself — setWorkflowState fails closed without it. Register the
  // fixtures the way deployment sync does, via workflowDb.saveWorkflow.
  const wdb = await import('../../workflowDb');
  wdb.saveWorkflow({ id: 'WF-ALPHA', name: 'Alpha Flow' });
  wdb.saveWorkflow({ id: 'WF-BETA', name: 'Beta Flow' });
  wdb.saveWorkflow({ id: 'WF-GAMMA', name: 'Gamma Flow' });
});

afterAll(() => {
  try { fs.rmSync(H.root, { recursive: true, force: true }); } catch { /* sqlite files may be locked */ }
});

// ─── Listing & details ──────────────────────────────────────────────────────

describe('listWorkflows / getWorkflowDetails', () => {
  it('lists only valid workflows with steps[0] as fallback current_step', () => {
    const list = wm.listWorkflows();
    const ids = list.map(w => w.id).sort();
    expect(ids).toEqual(['WF-ALPHA', 'WF-BETA', 'WF-GAMMA']); // broken + no-id + notes.txt skipped

    const alpha = list.find(w => w.id === 'WF-ALPHA')!;
    expect(alpha.name).toBe('Alpha Flow');
    expect(alpha.enabled).toBe(true);
    expect(alpha.current_step).toBe('step-1'); // no state yet
    expect(alpha.focus).toBe('dev');

    const beta = list.find(w => w.id === 'WF-BETA')!;
    expect(beta.enabled).toBe(false);
  });

  it('getWorkflowDetails returns the full workflow or null', () => {
    const alpha = wm.getWorkflowDetails('WF-ALPHA');
    expect(alpha).not.toBeNull();
    expect(alpha!.steps).toHaveLength(2);
    expect(alpha!.steps[0].prompt).toBe('Do the planning');

    expect(wm.getWorkflowDetails('WF-NOPE')).toBeNull();
  });
});

// ─── State ──────────────────────────────────────────────────────────────────

describe('get/setWorkflowState', () => {
  const stateFile = path.join(WORKFLOWS_DIR, '.WF-ALPHA-state');

  it('returns null when no state file exists', () => {
    expect(wm.getWorkflowState('WF-ALPHA')).toBeNull();
  });

  it('plain write (no history) stores the bare step name', () => {
    expect(wm.setWorkflowState('WF-ALPHA', 'step-1')).toEqual({ success: true });
    expect(fs.readFileSync(stateFile, 'utf-8')).toBe('step-1');

    const state = wm.getWorkflowState('WF-ALPHA');
    expect(state).toMatchObject({ workflow_id: 'WF-ALPHA', current_step: 'step-1', history: [] });
  });

  it('history write: cross-step transition records history and keeps file + DB in sync (TASK-QC-011)', async () => {
    // Regression for the workflowDb named-param bug: addHistory used to require
    // @terminal/@island/@task_file even though the schema columns are nullable,
    // so every cross-step history write failed closed. Fixed: optional fields
    // are bound as NULL, the transition succeeds and both stores stay in sync.
    expect(wm.setWorkflowState('WF-ALPHA', 'step-2', true)).toEqual({ success: true });

    const raw = fs.readFileSync(stateFile, 'utf-8');
    expect(raw.trim().startsWith('{')).toBe(true);

    const state = wm.getWorkflowState('WF-ALPHA')!;
    expect(state.current_step).toBe('step-2');
    expect(state.last_updated).toBeTruthy();
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ step: 'step-1', status: 'done' });

    // DB mirrors the file: workflow_states row + workflow_history row
    const wdb = await import('../../workflowDb');
    expect(wdb.getStateFromDb('WF-ALPHA')).toMatchObject({
      workflow_id: 'WF-ALPHA',
      current_step: 'step-2',
    });
    const dbHistory = wdb.getHistoryFromDb('WF-ALPHA');
    expect(dbHistory.some(h => h.step_id === 'step-1' && h.notes === 'Transitioned to step-2')).toBe(true);

    // Same-step history write skips the transition branch: no extra history row
    expect(wm.setWorkflowState('WF-ALPHA', 'step-2', true)).toEqual({ success: true });
    expect(wm.getWorkflowState('WF-ALPHA')!.history).toHaveLength(1);
    expect(wdb.getHistoryFromDb('WF-ALPHA')).toHaveLength(dbHistory.length);
  });
});

// ─── Advance ────────────────────────────────────────────────────────────────

describe('advanceWorkflow', () => {
  it('unknown workflow -> error', () => {
    expect(wm.advanceWorkflow('WF-NOPE')).toEqual({ success: false, error: 'Workflow not found' });
  });

  it('fresh workflow (no state) advances from steps[0] to the next step', () => {
    const r = wm.advanceWorkflow('WF-GAMMA');
    expect(r).toMatchObject({ success: true, previous_step: 'step-a', current_step: 'step-b' });
    expect(wm.getWorkflowState('WF-GAMMA')!.current_step).toBe('step-b');
  });

  it('at the last step (empty next_step) -> error', () => {
    const r = wm.advanceWorkflow('WF-GAMMA'); // now at step-b, next_step ""
    expect(r).toEqual({ success: false, error: 'No next step defined' });
  });

  it('state pointing at a step not in the workflow -> error', () => {
    wm.setWorkflowState('WF-GAMMA', 'ghost-step');
    const r = wm.advanceWorkflow('WF-GAMMA');
    expect(r).toEqual({ success: false, error: 'Step not found: ghost-step' });
  });
});

// ─── Task generation (sandboxed /opt) ───────────────────────────────────────

describe('generateWorkflowTask', () => {
  const conductorInbox = path.join(H.optSandbox, 'spaceos', 'terminals', 'conductor', 'inbox');

  it('unknown workflow and unknown step produce errors', () => {
    expect(wm.generateWorkflowTask('WF-NOPE')).toEqual({ success: false, error: 'Workflow not found' });
    expect(wm.generateWorkflowTask('WF-ALPHA', 'bogus-step'))
      .toEqual({ success: false, error: 'Step not found: bogus-step' });
  });

  it('writes a task file with workflow frontmatter and prompt, numbering after existing messages', () => {
    // Pre-seed the (sandboxed) inbox so the counter branch is exercised
    fs.mkdirSync(conductorInbox, { recursive: true });
    fs.writeFileSync(path.join(conductorInbox, '2026-01-01_007_old-task.md'), 'old', 'utf-8');

    const r = wm.generateWorkflowTask('WF-ALPHA', 'step-1');
    expect(r.success).toBe(true);
    expect(r.task_file).toBeTruthy();

    const files = fs.readdirSync(conductorInbox).filter(f => f.includes('wf-plan-work'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('_008_'); // 007 existed -> next is 008

    const content = fs.readFileSync(path.join(conductorInbox, files[0]), 'utf-8');
    expect(content).toContain('workflow_id: WF-ALPHA');
    expect(content).toContain('workflow_step: step-1');
    expect(content).toContain('next_step: step-2');
    expect(content).toContain('to: spaceos-conductor');
    expect(content).toContain('model: sonnet');
    expect(content).toContain('# Alpha Flow — Plan Work');
    expect(content).toContain('Do the planning');
  });

  it('missing island/terminal/model/prompt fall back to defaults (step-2)', () => {
    const r = wm.generateWorkflowTask('WF-ALPHA', 'step-2');
    expect(r.success).toBe(true);

    // step-2 has no terminal/island/model -> spaceos/conductor/sonnet defaults
    const files = fs.readdirSync(conductorInbox).filter(f => f.includes('wf-execute'));
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(conductorInbox, files[0]), 'utf-8');
    expect(content).toContain('No prompt defined');
    expect(content).toContain('next_step: none');
    expect(content).toContain('`END`');
  });
});

// ─── Epics ──────────────────────────────────────────────────────────────────

describe('epics (EPICS.yaml)', () => {
  it('missing EPICS.yaml: listEpics [] , getEpic null, update false', () => {
    expect(fs.existsSync(EPICS_FILE)).toBe(false);
    expect(wm.listEpics()).toEqual([]);
    expect(wm.getEpic('EPIC-ONE')).toBeNull();
    expect(wm.updateEpicStatus('EPIC-ONE', 'done')).toBe(false);
  });

  it('lists epics and finds one by id once the file exists', () => {
    writeEpicsFixture();
    const epics = wm.listEpics();
    expect(epics).toHaveLength(2);
    expect(epics.map(e => e.id)).toEqual(['EPIC-ONE', 'EPIC-TWO']);

    expect(wm.getEpic('EPIC-TWO')).toMatchObject({ id: 'EPIC-TWO', status: 'active', assignee: 'backend' });
    expect(wm.getEpic('EPIC-NOPE')).toBeNull();
  });

  it('updateEpicStatus rewrites the YAML for a known epic, false for unknown', () => {
    expect(wm.updateEpicStatus('EPIC-ONE', 'done')).toBe(true);
    expect(wm.getEpic('EPIC-ONE')!.status).toBe('done'); // re-read from disk

    expect(wm.updateEpicStatus('EPIC-NOPE', 'active')).toBe(false);

    // File without an epics key -> false
    fs.writeFileSync(EPICS_FILE, 'something_else: true\n', 'utf-8');
    expect(wm.updateEpicStatus('EPIC-ONE', 'blocked')).toBe(false);
    writeEpicsFixture(); // restore for later tool tests
    wm.updateEpicStatus('EPIC-ONE', 'done');
  });
});

// ─── Summary ────────────────────────────────────────────────────────────────

describe('getWorkflowSummary', () => {
  it('reports totals, enabled count, and per-workflow step position', () => {
    wm.setWorkflowState('WF-ALPHA', 'step-2'); // deterministic position 2/2
    const summary = wm.getWorkflowSummary();
    expect(summary.total).toBe(3);
    expect(summary.enabled).toBe(2); // beta disabled

    const alpha = summary.workflows.find(w => w.id === 'WF-ALPHA')!;
    expect(alpha.step_index).toBe(2);
    expect(alpha.total_steps).toBe(2);

    const beta = summary.workflows.find(w => w.id === 'WF-BETA')!;
    expect(beta.step_index).toBe(1); // no state -> steps[0]
    expect(beta.total_steps).toBe(1);
  });
});

// ─── MCP tool dispatch ──────────────────────────────────────────────────────

describe('handleWorkflowTool', () => {
  function parse<T>(res: { content: Array<{ type: string; text: string }> }): T {
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    return JSON.parse(res.content[0].text) as T;
  }

  it('list_workflows', () => {
    const data = parse<Array<{ id: string }>>(wm.handleWorkflowTool('list_workflows', {}));
    expect(data.map(w => w.id).sort()).toEqual(['WF-ALPHA', 'WF-BETA', 'WF-GAMMA']);
  });

  it('get_workflow_details / get_workflow_state', () => {
    const details = parse<{ name: string }>(wm.handleWorkflowTool('get_workflow_details', { workflow_id: 'WF-BETA' }));
    expect(details.name).toBe('Beta Flow');

    const state = parse<{ current_step: string }>(wm.handleWorkflowTool('get_workflow_state', { workflow_id: 'WF-ALPHA' }));
    expect(state.current_step).toBe('step-2');
  });

  it('set_workflow_step: same-step and cross-step writes succeed; advance walks history path to last step', () => {
    // current state is step-2 (set by the summary test); same-step write works
    const same = parse<{ success: boolean }>(wm.handleWorkflowTool('set_workflow_step', { workflow_id: 'WF-ALPHA', step_id: 'step-2' }));
    expect(same.success).toBe(true);

    // Cross-step write records history and moves the state (TASK-QC-011 fix)
    const cross = parse<{ success: boolean }>(wm.handleWorkflowTool('set_workflow_step', { workflow_id: 'WF-ALPHA', step_id: 'step-1' }));
    expect(cross.success).toBe(true);
    expect(wm.getWorkflowState('WF-ALPHA')!.current_step).toBe('step-1');

    // advance on a workflow with existing state exercises the history write path
    const adv = parse<Record<string, unknown>>(wm.handleWorkflowTool('advance_workflow', { workflow_id: 'WF-ALPHA' }));
    expect(adv).toMatchObject({ success: true, previous_step: 'step-1', current_step: 'step-2' });
    expect(wm.getWorkflowState('WF-ALPHA')!.current_step).toBe('step-2');

    // At step-2 (last step) advance reports no next step
    const advEnd = parse<Record<string, unknown>>(wm.handleWorkflowTool('advance_workflow', { workflow_id: 'WF-ALPHA' }));
    expect(advEnd).toEqual({ success: false, error: 'No next step defined' });
  });

  it('generate_workflow_task', () => {
    const gen = parse<{ success: boolean }>(wm.handleWorkflowTool('generate_workflow_task', { workflow_id: 'WF-BETA', step_id: 'only-step' }));
    expect(gen.success).toBe(true);
    const librarianInbox = path.join(H.optSandbox, 'spaceos', 'terminals', 'librarian', 'inbox');
    const files = fs.readdirSync(librarianInbox);
    expect(files.some(f => f.includes('wf-solo-step'))).toBe(true);
  });

  it('list_epics with and without status filter', () => {
    const all = parse<Array<{ id: string }>>(wm.handleWorkflowTool('list_epics', {}));
    expect(all).toHaveLength(2);

    const allExplicit = parse<Array<{ id: string }>>(wm.handleWorkflowTool('list_epics', { status_filter: 'all' }));
    expect(allExplicit).toHaveLength(2);

    const done = parse<Array<{ id: string }>>(wm.handleWorkflowTool('list_epics', { status_filter: 'done' }));
    expect(done).toHaveLength(1);
    expect(done[0].id).toBe('EPIC-ONE');
  });

  it('update_epic and workflow_summary', () => {
    const upd = parse<{ success: boolean }>(wm.handleWorkflowTool('update_epic', { epic_id: 'EPIC-TWO', status: 'blocked' }));
    expect(upd.success).toBe(true);
    expect(wm.getEpic('EPIC-TWO')!.status).toBe('blocked');

    const summary = parse<{ total: number }>(wm.handleWorkflowTool('workflow_summary', {}));
    expect(summary.total).toBe(3);
  });

  it('unknown tool -> error payload, not a throw', () => {
    const err = parse<{ error: string }>(wm.handleWorkflowTool('fly_to_moon', {}));
    expect(err.error).toContain('Unknown workflow tool: fly_to_moon');
  });

  it('WORKFLOW_TOOLS exposes a schema per dispatchable tool', () => {
    const names = wm.WORKFLOW_TOOLS.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'list_workflows', 'get_workflow_details', 'get_workflow_state', 'advance_workflow',
      'generate_workflow_task', 'set_workflow_step', 'list_epics', 'update_epic', 'workflow_summary',
    ]));
  });
});
