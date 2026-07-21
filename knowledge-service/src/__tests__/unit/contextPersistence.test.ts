/**
 * contextPersistence unit tests — hermetic, temp TERMINALS_PATH tree.
 *
 * PINS the terminal context-file contract:
 *  - STATUS.md write/read round-trip incl. system-status parsing (operational/
 *    in_progress/paused/blocked) and metadata fallbacks on malformed content
 *  - .session-state.json merge semantics (existing state preserved, savedAt
 *    refreshed, malformed JSON -> null)
 *  - .turn-count increment/reset and the saturation thresholds:
 *    30 = WARNING, 50 = CRITICAL + needsReanchor
 *  - CHECKPOINTS.md header bootstrap + append + parse
 *  - unknown terminal name -> throws; aliases resolve to canonical names
 *
 * All paths derive from TERMINALS_PATH (env, read at import by config/paths),
 * so the env is set at module top level BEFORE the dynamic import in beforeAll.
 * Only system-role terminals (root/conductor/librarian) are used: their
 * directories derive from TERMINALS_PATH, unlike custom terminals whose
 * directories are pinned in config/terminals.yaml.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const runId = crypto.randomBytes(6).toString('hex');
const TERMINALS_ROOT = path.join(os.tmpdir(), `ctx-persist-${runId}`);
process.env.TERMINALS_PATH = TERMINALS_ROOT;
process.env.DATA_DIR = path.join(os.tmpdir(), `ctx-persist-data-${runId}`);

let cp: typeof import('../../contextPersistence');

function tdir(terminal: string): string {
  return path.join(TERMINALS_ROOT, terminal);
}

beforeAll(async () => {
  for (const t of ['root', 'conductor', 'librarian', 'explorer']) {
    fs.mkdirSync(tdir(t), { recursive: true });
  }
  cp = await import('../../contextPersistence');
});

afterAll(() => {
  try { fs.rmSync(TERMINALS_ROOT, { recursive: true, force: true }); } catch { /* locked on Windows is fine */ }
});

// ─── STATUS.md ──────────────────────────────────────────────────────────────

describe('STATUS.md read/write', () => {
  it('returns null when STATUS.md does not exist', async () => {
    expect(await cp.readStatusMd('root')).toBeNull();
  });

  it('write -> read round-trip with all optional sections', async () => {
    const w = await cp.writeStatusMd('root', {
      systemStatus: 'in_progress',
      currentFocus: 'Ship the release',
      epicProgress: { name: 'EPIC-REL', progress: 42, details: 'halfway there' },
      recentActions: ['did a thing', 'did another'],
      nextSteps: ['verify', 'deploy'],
      customContent: 'CUSTOM-MARKER-XYZ',
    });
    expect(w.success).toBe(true);
    expect(w.path).toBe(path.join(tdir('root'), 'STATUS.md'));
    expect(fs.existsSync(w.path)).toBe(true);

    const s = await cp.readStatusMd('root');
    expect(s).not.toBeNull();
    expect(s!.terminal).toBe('root');
    expect(s!.systemStatus).toBe('in_progress');
    expect(s!.currentFocus).toBe('Ship the release');
    // Full content is preserved and includes every optional section
    expect(s!.content).toContain('## Epic Progress');
    expect(s!.content).toContain('### EPIC-REL (42%)');
    expect(s!.content).toContain('- did a thing');
    expect(s!.content).toContain('1. verify');
    expect(s!.content).toContain('2. deploy');
    expect(s!.content).toContain('CUSTOM-MARKER-XYZ');
    // in_progress footer renders as WORKING
    expect(s!.content).toContain('**Root Status:** WORKING');
  });

  it('parses paused and blocked statuses from raw content', async () => {
    fs.writeFileSync(
      path.join(tdir('conductor'), 'STATUS.md'),
      '# Conductor\n\n**Last Updated:** 2026-07-18 10:00 UTC\n**System Status:** PAUSED\n**Active Task:** waiting on root\n',
      'utf-8'
    );
    const paused = await cp.readStatusMd('conductor');
    expect(paused!.systemStatus).toBe('paused');
    expect(paused!.lastUpdated).toContain('2026-07-18');
    expect(paused!.currentFocus).toBe('waiting on root');

    fs.writeFileSync(
      path.join(tdir('conductor'), 'STATUS.md'),
      '**System Status:** BLOCKED\n',
      'utf-8'
    );
    expect((await cp.readStatusMd('conductor'))!.systemStatus).toBe('blocked');
  });

  it('falls back to operational / null focus / generated timestamp on bare content', async () => {
    fs.writeFileSync(path.join(tdir('conductor'), 'STATUS.md'), 'just some text\n', 'utf-8');
    const s = await cp.readStatusMd('conductor');
    expect(s!.systemStatus).toBe('operational');
    expect(s!.currentFocus).toBeNull();
    expect(typeof s!.lastUpdated).toBe('string');
    expect(s!.lastUpdated.length).toBeGreaterThan(0);
  });

  it('resolves aliases to the canonical terminal name', async () => {
    // "dragon" is an alias of "root" in config/terminals.yaml
    const s = await cp.readStatusMd('dragon');
    expect(s).not.toBeNull();
    expect(s!.terminal).toBe('root');
  });

  it('throws for unknown terminals (read and write)', async () => {
    await expect(cp.readStatusMd('no-such-terminal')).rejects.toThrow('Unknown terminal');
    await expect(cp.writeStatusMd('no-such-terminal', { systemStatus: 'operational' }))
      .rejects.toThrow('Unknown terminal');
  });
});

// ─── .session-state.json ────────────────────────────────────────────────────

describe('.session-state.json', () => {
  it('returns null when missing and null on malformed JSON', async () => {
    expect(await cp.readSessionState('librarian')).toBeNull();
    fs.writeFileSync(path.join(tdir('librarian'), '.session-state.json'), '{{{not json', 'utf-8');
    expect(await cp.readSessionState('librarian')).toBeNull();
    fs.unlinkSync(path.join(tdir('librarian'), '.session-state.json'));
  });

  it('first write fills defaults, second write merges without losing fields', async () => {
    const w1 = await cp.writeSessionState('librarian', {
      epicId: 'EPIC-X', epicName: 'X epic', epicProgress: 10,
    });
    expect(w1.success).toBe(true);

    const s1 = await cp.readSessionState('librarian');
    expect(s1!.epicId).toBe('EPIC-X');
    expect(s1!.epicProgress).toBe(10);
    expect(s1!.completedCheckpoints).toEqual([]);
    expect(s1!.sessionId).toMatch(/^session-/);
    expect(s1!.savedAt).toBeTruthy();

    await cp.writeSessionState('librarian', { epicProgress: 55, lastActiveTask: 'TASK-9' });
    const s2 = await cp.readSessionState('librarian');
    expect(s2!.epicId).toBe('EPIC-X'); // preserved from previous state
    expect(s2!.epicProgress).toBe(55); // updated
    expect(s2!.lastActiveTask).toBe('TASK-9');
    expect(s2!.sessionId).toBe(s1!.sessionId); // merge keeps identity
  });

  it('throws for unknown terminals', async () => {
    await expect(cp.readSessionState('nope')).rejects.toThrow('Unknown terminal');
    await expect(cp.writeSessionState('nope', {})).rejects.toThrow('Unknown terminal');
  });
});

// ─── .turn-count + saturation ───────────────────────────────────────────────

describe('.turn-count and context saturation', () => {
  const turnPath = () => path.join(tdir('explorer'), '.turn-count');

  it('reads 0 when missing and 0 on malformed content', async () => {
    expect(await cp.readTurnCount('explorer')).toBe(0);
    fs.writeFileSync(turnPath(), 'not-a-number', 'utf-8');
    expect(await cp.readTurnCount('explorer')).toBe(0);
  });

  it('increments from current value; below 30 no flags', async () => {
    fs.writeFileSync(turnPath(), '28', 'utf-8');
    const r = await cp.incrementTurnCount('explorer');
    expect(r).toMatchObject({ success: true, count: 29, warning: false, critical: false, needsReanchor: false });
    expect(fs.readFileSync(turnPath(), 'utf-8')).toBe('29');
  });

  it('30..49 is WARNING only', async () => {
    const r = await cp.incrementTurnCount('explorer'); // 29 -> 30
    expect(r.count).toBe(30);
    expect(r.warning).toBe(true);
    expect(r.critical).toBe(false);
    expect(r.needsReanchor).toBe(false);

    const sat = await cp.getContextSaturation('explorer');
    expect(sat.status).toBe('warning');
    expect(sat.message).toContain('WARNING');
    expect(sat.needsReanchor).toBe(false);
  });

  it('50+ is CRITICAL and needsReanchor', async () => {
    fs.writeFileSync(turnPath(), '49', 'utf-8');
    const r = await cp.incrementTurnCount('explorer', 1);
    expect(r.count).toBe(50);
    expect(r.warning).toBe(false); // warning band is exclusive of critical
    expect(r.critical).toBe(true);
    expect(r.needsReanchor).toBe(true);

    const sat = await cp.getContextSaturation('explorer');
    expect(sat).toMatchObject({ terminal: 'explorer', turnCount: 50, status: 'critical', needsReanchor: true });
    expect(sat.message).toContain('CRITICAL');
  });

  it('supports custom increments and reset to 0', async () => {
    const r = await cp.incrementTurnCount('explorer', 5); // 50 -> 55
    expect(r.count).toBe(55);

    const reset = await cp.resetTurnCount('explorer');
    expect(reset.success).toBe(true);
    expect(await cp.readTurnCount('explorer')).toBe(0);

    const sat = await cp.getContextSaturation('explorer');
    expect(sat.status).toBe('ok');
    expect(sat.message).toContain('healthy');
  });

  it('throws for unknown terminals', async () => {
    await expect(cp.readTurnCount('nope')).rejects.toThrow('Unknown terminal');
    await expect(cp.incrementTurnCount('nope')).rejects.toThrow('Unknown terminal');
    await expect(cp.resetTurnCount('nope')).rejects.toThrow('Unknown terminal');
    await expect(cp.getContextSaturation('nope')).rejects.toThrow('Unknown terminal');
  });
});

// ─── CHECKPOINTS.md ─────────────────────────────────────────────────────────

describe('CHECKPOINTS.md', () => {
  it('returns null when missing', async () => {
    expect(await cp.readCheckpointsMd('conductor')).toBeNull();
  });

  it('append bootstraps the header, appends sections, and readCheckpointsMd parses them', async () => {
    const a1 = await cp.appendCheckpoint('conductor', {
      date: '2026-07-18',
      name: 'Go-live',
      decision: 'GO',
      evaluationCriteria: ['tests green', 'no P1 bugs'],
      goActions: ['deploy'],
      noGoActions: ['rollback'],
      refs: ['ADR-041'],
    });
    expect(a1.success).toBe(true);

    const raw = fs.readFileSync(a1.path, 'utf-8');
    expect(raw).toContain('# Conductor Checkpoints'); // bootstrapped header
    expect(raw).toContain('### 2026-07-18 — Go-live GO');
    expect(raw).toContain('- tests green');
    expect(raw).toContain('**HA GO:**');
    expect(raw).toContain('1. deploy');
    expect(raw).toContain('- ADR-041');

    // Second append (without refs) lands in the same file
    await cp.appendCheckpoint('conductor', {
      date: '2026-08-01',
      name: 'Scale-up',
      decision: 'GO',
      evaluationCriteria: ['load ok'],
      goActions: ['scale'],
      noGoActions: ['hold'],
    });

    const parsed = await cp.readCheckpointsMd('conductor');
    expect(parsed).not.toBeNull();
    expect(parsed!.terminal).toBe('conductor');
    expect(parsed!.checkpoints.length).toBe(2);
    expect(parsed!.checkpoints[0].date).toBe('2026-07-18');
    expect(parsed!.checkpoints[0].name).toContain('Go-live');
    expect(parsed!.checkpoints[1].date).toBe('2026-08-01');
  });

  it('throws for unknown terminals', async () => {
    await expect(cp.readCheckpointsMd('nope')).rejects.toThrow('Unknown terminal');
    await expect(cp.appendCheckpoint('nope', {
      date: 'x', name: 'x', decision: 'GO', evaluationCriteria: [], goActions: [], noGoActions: [],
    })).rejects.toThrow('Unknown terminal');
  });
});

// ─── Combined status + session-start context ────────────────────────────────

describe('combined context status', () => {
  it('getContextFilesStatus reflects which files exist', async () => {
    // conductor now has STATUS.md + CHECKPOINTS.md (from earlier tests), no session state / turn count
    const c = await cp.getContextFilesStatus('conductor');
    expect(c.terminal).toBe('conductor');
    expect(c.hasStatus).toBe(true);
    expect(c.hasCheckpoints).toBe(true);
    expect(c.hasSessionState).toBe(false);
    expect(c.hasTurnCount).toBe(false); // 0 counts as "no turn count"
    expect(c.turnCount).toBe(0);
    expect(c.sessionState).toBeNull();

    // librarian has session state only
    const l = await cp.getContextFilesStatus('librarian');
    expect(l.hasSessionState).toBe(true);
    expect(l.sessionState!.epicId).toBe('EPIC-X');
    expect(l.hasStatus).toBe(false);

    await expect(cp.getContextFilesStatus('nope')).rejects.toThrow('Unknown terminal');
  });

  it('getAllContextFilesStatus covers every configured terminal without throwing', async () => {
    const all = await cp.getAllContextFilesStatus();
    const names = all.map(s => s.terminal);
    expect(names).toContain('root');
    expect(names).toContain('conductor');
    expect(names).toContain('librarian');
    const lib = all.find(s => s.terminal === 'librarian')!;
    expect(lib.hasSessionState).toBe(true);
  });

  it('buildSessionStartContext assembles recovery + saturation + status sections', async () => {
    await cp.writeSessionState('root', {
      epicId: 'EPIC-BOOT', epicName: 'Boot epic', epicProgress: 60,
      completedCheckpoints: ['CP-1', 'CP-2'],
      nextCheckpointId: 'CP-3', nextCheckpointName: 'Third stone',
      lastActiveTask: 'TASK-42',
    });
    fs.writeFileSync(path.join(tdir('root'), '.turn-count'), '35', 'utf-8');
    // STATUS.md for root was written in the write round-trip test (currentFocus set)

    const ctx = await cp.buildSessionStartContext('root');
    expect(ctx).toContain('## Session Recovery Context');
    expect(ctx).toContain('EPIC-BOOT');
    expect(ctx).toContain('**Completed Checkpoints:** CP-1, CP-2');
    expect(ctx).toContain('**Next Checkpoint:** CP-3 — Third stone');
    expect(ctx).toContain('## Context Saturation Warning');
    expect(ctx).toContain('## Current Status');
    expect(ctx).toContain('**Current Focus:** Ship the release');
  });

  it('buildSessionStartContext is empty for a terminal with no context files', async () => {
    fs.mkdirSync(tdir('reviewer'), { recursive: true });
    const ctx = await cp.buildSessionStartContext('reviewer');
    expect(ctx).toBe('');
    await expect(cp.buildSessionStartContext('nope')).rejects.toThrow('Unknown terminal');
  });
});
