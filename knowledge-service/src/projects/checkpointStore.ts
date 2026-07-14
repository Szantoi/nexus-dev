/**
 * Checkpoint (sarokkő / cornerstone) store — server-managed project milestones.
 *
 * WHY server-managed (Gábor, 2026-07-12): if goals live in a file, anyone (agents
 * included) can edit the file and bypass the system — agents are prone to routing
 * around process. Managed through the server: every change is authenticated,
 * validated, LOGGED, and audit-trailed; and "where are we?" is a single API call
 * instead of file archaeology. The EPICS.yaml file is at most a one-time SEED
 * (see /api/projects/import-yaml) — the DB is the source of truth.
 *
 * Extends the EXISTING epic-router SQLite store (same DB, additive table) —
 * deliberately NOT a parallel store; one project/epic database.
 */
import { getEpicRouterDb, createEpic, createProject, getProjectById } from '../pipeline/epicRouter';
import { logger } from '../core/logger';

const log = (msg: string) => logger.info(`[Checkpoints] ${msg}`);

export interface Checkpoint {
  id: string;
  epic_id: string;
  name: string;
  status: 'pending' | 'done';
  condition: string;           // measurable completion condition (human-readable)
  trigger_to?: string[];       // terminals to notify on completion (dense milestone feedback)
  status_history?: Array<{ from: string | null; to: string; at: string; by?: string }>;
  created_at: string;
  updated_at: string;
  done_at?: string;
}

let schemaReady = false;
function ensureSchema(): void {
  if (schemaReady) return;
  getEpicRouterDb().exec(`
    CREATE TABLE IF NOT EXISTS epic_checkpoints (
      id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
      condition TEXT NOT NULL,
      trigger_to TEXT,
      status_history TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      done_at TEXT,
      FOREIGN KEY (epic_id) REFERENCES epics(id)
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_epic ON epic_checkpoints(epic_id, status);
  `);
  schemaReady = true;
}

function rowToCheckpoint(r: Record<string, unknown>): Checkpoint {
  return {
    ...(r as unknown as Checkpoint),
    trigger_to: r.trigger_to ? JSON.parse(r.trigger_to as string) : undefined,
    status_history: r.status_history ? JSON.parse(r.status_history as string) : [],
  };
}

/** Create or update a checkpoint definition (server-mediated, logged). */
export function upsertCheckpoint(cp: {
  id: string; epic_id: string; name: string; condition: string;
  trigger_to?: string[]; status?: 'pending' | 'done';
}): Checkpoint {
  ensureSchema();
  const db = getEpicRouterDb();
  db.prepare(`
    INSERT INTO epic_checkpoints (id, epic_id, name, condition, trigger_to, status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, condition = excluded.condition,
      trigger_to = excluded.trigger_to, updated_at = datetime('now')
  `).run(cp.id, cp.epic_id, cp.name, cp.condition,
    cp.trigger_to ? JSON.stringify(cp.trigger_to) : null, cp.status || 'pending');
  log(`upsert ${cp.id} (epic ${cp.epic_id})`);
  return getCheckpoint(cp.id)!;
}

export function getCheckpoint(id: string): Checkpoint | null {
  ensureSchema();
  const row = getEpicRouterDb().prepare('SELECT * FROM epic_checkpoints WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToCheckpoint(row) : null;
}

export function listCheckpoints(epicId: string): Checkpoint[] {
  ensureSchema();
  return (getEpicRouterDb().prepare('SELECT * FROM epic_checkpoints WHERE epic_id = ? ORDER BY created_at')
    .all(epicId) as Record<string, unknown>[]).map(rowToCheckpoint);
}

/**
 * Complete a cornerstone — THE audited transition. Records who/when in the
 * checkpoint's status_history and logs it; returns the terminals to notify
 * (trigger_to) so the caller can emit dense milestone feedback.
 */
export function completeCheckpoint(id: string, by?: string): { success: boolean; checkpoint?: Checkpoint; notify?: string[]; error?: string } {
  ensureSchema();
  const cp = getCheckpoint(id);
  if (!cp) return { success: false, error: `Checkpoint not found: ${id}` };
  if (cp.status === 'done') return { success: true, checkpoint: cp, notify: [] }; // idempotent

  const history = cp.status_history || [];
  history.push({ from: cp.status, to: 'done', at: new Date().toISOString(), by: by || 'system' });
  getEpicRouterDb().prepare(`
    UPDATE epic_checkpoints
    SET status = 'done', done_at = datetime('now'), updated_at = datetime('now'), status_history = ?
    WHERE id = ?
  `).run(JSON.stringify(history), id);

  log(`✅ cornerstone DONE: ${id} (${cp.name}) by ${by || 'system'}`);
  return { success: true, checkpoint: getCheckpoint(id)!, notify: cp.trigger_to || [] };
}

/** Epic progress from the DB: done/total cornerstones. */
export function epicProgress(epicId: string): { done: number; total: number; percent: number } {
  const cps = listCheckpoints(epicId);
  const done = cps.filter(c => c.status === 'done').length;
  return { done, total: cps.length, percent: cps.length ? Math.round((done / cps.length) * 100) : 0 };
}

/**
 * "Where are we?" in ONE call: every active project/epic with its cornerstones,
 * progress, and the next pending cornerstone. This is what the coordinator (and
 * any agent) queries for goal focus — no file reads, fully served + logged.
 */
export function projectStatus(): Array<{
  epic_id: string; epic_name: string; epic_status: string;
  progress: { done: number; total: number; percent: number };
  next_checkpoint: { id: string; name: string; condition: string } | null;
  checkpoints: Array<{ id: string; name: string; status: string }>;
}> {
  ensureSchema();
  const db = getEpicRouterDb();
  const epics = db.prepare(`SELECT id, name, status FROM epics WHERE status IN ('active', 'pending') ORDER BY priority DESC`)
    .all() as Array<{ id: string; name: string; status: string }>;
  return epics.map(e => {
    const cps = listCheckpoints(e.id);
    const next = cps.find(c => c.status === 'pending') || null;
    return {
      epic_id: e.id,
      epic_name: e.name,
      epic_status: e.status,
      progress: epicProgress(e.id),
      next_checkpoint: next ? { id: next.id, name: next.name, condition: next.condition } : null,
      checkpoints: cps.map(c => ({ id: c.id, name: c.name, status: c.status })),
    };
  });
}

/**
 * One-time seed from an EPICS.yaml structure (the legacy file format). After
 * import, the DB is the source of truth; the file is historical.
 */
export function importEpicsYaml(data: {
  epics: Array<{
    id: string; name: string; status: string;
    depends_on?: string[];
    checkpoints?: Array<{ id: string; name: string; status?: string; condition?: string; trigger_to?: string[] }>;
  }>;
}, projectId = 'default'): { epics: number; checkpoints: number } {
  ensureSchema();
  if (!getProjectById(projectId)) {
    createProject({ id: projectId, name: projectId, status: 'active' });
  }
  let epics = 0, checkpoints = 0;
  for (const e of data.epics || []) {
    createEpic({
      id: e.id, project_id: projectId, name: e.name,
      status: (['pending', 'active', 'done', 'blocked'].includes(e.status) ? e.status : 'pending') as 'pending' | 'active' | 'done' | 'blocked',
      priority: 2, depends_on: e.depends_on,
    });
    epics++;
    for (const cp of e.checkpoints || []) {
      upsertCheckpoint({
        id: cp.id, epic_id: e.id, name: cp.name,
        condition: cp.condition || '(no condition declared)',
        trigger_to: cp.trigger_to,
        status: cp.status === 'done' ? 'done' : 'pending',
      });
      checkpoints++;
    }
  }
  log(`imported ${epics} epic(s), ${checkpoints} checkpoint(s) from EPICS.yaml seed`);
  return { epics, checkpoints };
}
