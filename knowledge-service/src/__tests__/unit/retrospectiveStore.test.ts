/**
 * retrospective.ts unit tests (TASK-QC-006, ADR-046 Track C).
 *
 * PINS the retrospective contract:
 *  - analysis scopes (session / last-task / last-hour) read session_history,
 *  - proposal heuristics (corrections -> skill, done -> warm memory,
 *    high tool-call average -> workflow) and focus filtering,
 *  - proposals persist to SQLite and only APPROVED ids execute,
 *  - execution failures are collected per proposal, never thrown.
 *
 * Hermetic: MEMORY_DB_PATH + SPACEOS_ROOT point at a per-run temp area, so
 * the shared pipeline log and the sqlite store never touch the checkout.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fsSync from 'node:fs';
import Database from 'better-sqlite3';

const TMP_ROOT = vi.hoisted(() => {
  const runId = require('crypto').randomBytes(6).toString('hex');
  const p = require('path');
  const root = p.join(require('os').tmpdir(), `retro-${runId}`);
  process.env.SPACEOS_ROOT = p.join(root, 'spaceos');
  process.env.MEMORY_DB_PATH = p.join(root, 'memory.db');
  process.env.DATA_DIR = p.join(root, 'data');
  process.env.TERMINALS_PATH = p.join(root, 'terminals');
  return root as string;
});

import * as retro from '../../retrospective';
import * as memoryStore from '../../pipeline/memoryStore';

let rawDb: Database.Database;

beforeAll(() => {
  fsSync.mkdirSync(TMP_ROOT, { recursive: true });

  // The session_history table is produced by the session hooks in production;
  // the retrospective only READS it, so the fixture creates the columns it
  // consumes.
  rawDb = new Database(process.env.MEMORY_DB_PATH as string);
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal TEXT NOT NULL,
      started_at TEXT NOT NULL,
      end_reason TEXT,
      task_id TEXT,
      tool_calls INTEGER,
      had_corrections INTEGER
    )
  `);
});

afterAll(() => {
  retro.closeRetrospective();
  memoryStore.closeMemoryStore?.();
  rawDb.close();
  fsSync.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function insertSession(row: {
  terminal: string;
  started_at?: string;
  end_reason?: string;
  task_id?: string;
  tool_calls?: number;
  had_corrections?: number;
}): number {
  const r = rawDb
    .prepare(
      `INSERT INTO session_history (terminal, started_at, end_reason, task_id, tool_calls, had_corrections)
       VALUES (@terminal, @started_at, @end_reason, @task_id, @tool_calls, @had_corrections)`,
    )
    .run({
      started_at: new Date().toISOString(),
      end_reason: null,
      task_id: null,
      tool_calls: 0,
      had_corrections: 0,
      ...row,
    });
  return r.lastInsertRowid as number;
}

describe('runRetrospective', () => {
  it('returns an empty result when there is no session to analyze', async () => {
    const r = await retro.runRetrospective({ terminal: 'ghost', scope: 'last-task', focus: 'all' });
    expect(r).toEqual({
      sessionSummary: 'No sessions found',
      proposals: [],
      approved: false,
      executedCount: 0,
    });
  });

  it('last-task scope + focus=all generates skill, memory and workflow proposals', async () => {
    insertSession({
      terminal: 'backend',
      end_reason: 'done',
      task_id: 'TASK-42',
      tool_calls: 30,
      had_corrections: 1,
    });
    const r = await retro.runRetrospective({ terminal: 'backend', scope: 'last-task', focus: 'all' });

    expect(r.approved).toBe(false); // execution always needs explicit approval
    expect(r.sessionSummary).toContain('Analyzed 1 session(s)');
    const types = r.proposals.map((p: { type: string }) => p.type).sort();
    expect(types).toEqual(['memory', 'skill', 'workflow']);
    // Every proposal got a persisted DB id.
    for (const p of r.proposals) expect(p.id).toBeGreaterThan(0);

    const memory = r.proposals.find((p: { type: string }) => p.type === 'memory');
    expect(memory).toMatchObject({ action: 'save', target: 'task-TASK-42', newTier: 'warm' });
  });

  it('focus filtering only produces the requested proposal family', async () => {
    const r = await retro.runRetrospective({ terminal: 'backend', scope: 'last-task', focus: 'skills' });
    expect(r.proposals.length).toBeGreaterThan(0);
    expect(r.proposals.every((p: { type: string }) => p.type === 'skill')).toBe(true);
  });

  it('session scope analyzes exactly the given session id', async () => {
    const quietId = insertSession({ terminal: 'frontend', end_reason: 'idle', tool_calls: 2 });
    const r = await retro.runRetrospective({
      terminal: 'frontend', scope: 'session', focus: 'all', sessionId: quietId,
    });
    // Quiet session: no corrections, not done, few tool calls -> no proposals.
    expect(r.proposals).toEqual([]);
    expect(r.sessionSummary).toContain('frontend');
  });

  it('last-hour scope aggregates recent sessions of the terminal', async () => {
    insertSession({ terminal: 'designer', end_reason: 'done', task_id: 'T-A', tool_calls: 25 });
    insertSession({ terminal: 'designer', end_reason: 'done', task_id: 'T-B', tool_calls: 25 });
    const r = await retro.runRetrospective({ terminal: 'designer', scope: 'last-hour', focus: 'memory' });
    expect(r.sessionSummary).toContain('Analyzed 2 session(s)');
    // One warm-memory proposal per successfully completed task.
    expect(r.proposals.map((p: { target: string }) => p.target).sort()).toEqual(['task-T-A', 'task-T-B']);
  });
});

describe('applyRetrospective', () => {
  function insertProposal(row: {
    type: string; action: string; target: string; content?: string; new_tier?: string;
  }): number {
    const r = rawDb
      .prepare(
        `INSERT INTO retrospective_proposals (terminal, type, action, target, reason, content, new_tier, priority)
         VALUES ('backend', @type, @action, @target, 'test fixture', @content, @new_tier, 'medium')`,
      )
      .run({ content: null, new_tier: null, ...row });
    return r.lastInsertRowid as number;
  }

  it('executes approved memory-save and workflow proposals and marks them executed', async () => {
    const saveId = insertProposal({
      type: 'memory', action: 'save', target: 'task-T-9', content: 'done well', new_tier: 'warm',
    });
    const wfId = insertProposal({ type: 'workflow', action: 'create', target: 'backend-wf' });

    const r = await retro.applyRetrospective({ terminal: 'backend', approvedProposals: [saveId, wfId] });
    expect(r.errors).toEqual([]);
    expect(r.memoriesSaved).toBe(1);
    expect(r.workflowsUpdated).toBe(1);
    expect(r.executedCount).toBe(2);

    const row = rawDb
      .prepare('SELECT approved, executed FROM retrospective_proposals WHERE id = ?')
      .get(saveId) as { approved: number; executed: number };
    expect(row).toEqual({ approved: 1, executed: 1 });
  });

  it('re-tiers an existing memory through promoteMemory', async () => {
    const saved = await memoryStore.saveTieredMemory({
      tier: 'warm', type: 'episodic', source: 'skill',
      content: 'memory to promote', terminal: 'backend', salience: 0.5,
    });
    const retierId = insertProposal({
      type: 'memory', action: 'retier', target: `memory-${saved.id}`, new_tier: 'hot',
    });
    const r = await retro.applyRetrospective({ terminal: 'backend', approvedProposals: [retierId] });
    expect(r.errors).toEqual([]);
    expect(r.memoriesSaved).toBe(1);
  });

  it('collects errors per proposal instead of throwing (not found / bad target)', async () => {
    const badRetier = insertProposal({
      type: 'memory', action: 'retier', target: 'not-a-memory-ref', new_tier: 'hot',
    });
    const r = await retro.applyRetrospective({
      terminal: 'backend', approvedProposals: [999999, badRetier],
    });
    expect(r.executedCount).toBe(0);
    expect(r.errors.some((e: string) => e.includes('#999999 not found'))).toBe(true);
    expect(r.errors.some((e: string) => e.includes('Invalid memory target'))).toBe(true);
  });

  // NOTE (testability gap, documented in TASK-QC-006): the skill/create path
  // writes to os.homedir()/.claude/skills. os.homedir cannot be stubbed here
  // (esModuleInterop star-import copies the namespace), so a hermetic test
  // would write into the REAL home directory. Covering it needs a small
  // production change (env-overridable skills root) — intentionally skipped.
});
