/**
 * Projects Routes — server-managed epics + cornerstones (sarokkövek).
 *
 * WHY server-managed (Gábor, 2026-07-12): goals managed via files can be edited
 * around the system — agents are prone to bypassing process. Through the server
 * every change is authenticated, LOGGED, and audit-trailed; and "where are we?"
 * is a single API call (GET /status). The DB (checkpointStore on the epic-router
 * store) is the source of truth; EPICS.yaml is at most a one-time seed.
 *
 *   GET  /api/projects/status                   — hol tartunk: epics + cornerstones + progress + next
 *   POST /api/projects/epic                     — create/update an epic
 *   POST /api/projects/checkpoint               — create/update a cornerstone
 *   POST /api/projects/checkpoint/:id/complete  — audited cornerstone completion
 *   GET  /api/projects/epic/:id/checkpoints     — one epic's cornerstones
 *   POST /api/projects/import-yaml              — one-time seed from legacy EPICS.yaml
 *   GET  /api/projects/                         — LEGACY dashboard stub (fake data; to be rewired)
 */

import { Router, Request, Response } from 'express';
import * as fsSync from 'fs';
import * as yaml from 'js-yaml';
import { authenticateRest } from '../../../mcp';
import { createEpic, getEpicById, createProject, getProjectById } from '../../../pipeline/epicRouter';
import {
  upsertCheckpoint, completeCheckpoint, projectStatus, importEpicsYaml, listCheckpoints,
} from '../../../projects/checkpointStore';
import { logger } from '../../../core/logger';

import { SPACEOS_ROOT } from '../../../config/paths';

const router = Router();

// ─── Server-managed project/epic/cornerstone API ─────────────────────────────

// "Hol tartunk?" — one call, straight from the DB.
router.get('/status', authenticateRest, (_req: Request, res: Response): void => {
  res.json({ success: true, projects: projectStatus() });
});

router.post('/epic', authenticateRest, (req: Request, res: Response): void => {
  const b = req.body || {};
  if (!b.id || !b.name) { res.status(400).json({ error: 'id and name required' }); return; }
  try {
    const projectId = b.project_id || 'default';
    // The epics table has a project FK — make sure the container project exists.
    if (!getProjectById(projectId)) {
      createProject({ id: projectId, name: projectId, status: 'active' });
    }
    const epic = createEpic({
      id: b.id, project_id: projectId, name: b.name,
      description: b.description,
      status: b.status || 'pending', priority: b.priority ?? 2,
      depends_on: b.depends_on, target_date: b.target_date,
    });
    logger.info(`[Projects] epic upserted: ${epic.id} (by ${(req as Request & { mcpTerminal?: string }).mcpTerminal || '?'})`);
    res.json({ success: true, epic });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/checkpoint', authenticateRest, (req: Request, res: Response): void => {
  const b = req.body || {};
  if (!b.id || !b.epic_id || !b.name || !b.condition) {
    res.status(400).json({ error: 'id, epic_id, name, condition required' });
    return;
  }
  if (!getEpicById(b.epic_id)) { res.status(404).json({ error: `epic not found: ${b.epic_id}` }); return; }
  const cp = upsertCheckpoint({
    id: b.id, epic_id: b.epic_id, name: b.name, condition: b.condition, trigger_to: b.trigger_to,
  });
  res.json({ success: true, checkpoint: cp });
});

router.post('/checkpoint/:id/complete', authenticateRest, (req: Request, res: Response): void => {
  const by = (req.body || {}).by || (req as Request & { mcpTerminal?: string }).mcpTerminal;
  const result = completeCheckpoint(String(req.params.id), by);
  if (!result.success) { res.status(404).json({ error: result.error }); return; }
  res.json({ success: true, checkpoint: result.checkpoint, notify: result.notify });
});

router.get('/epic/:id/checkpoints', authenticateRest, (req: Request, res: Response): void => {
  res.json({ success: true, checkpoints: listCheckpoints(String(req.params.id)) });
});

// One-time seed from the legacy file format. After this, the DB is the truth.
router.post('/import-yaml', authenticateRest, (req: Request, res: Response): void => {
  const filePath = (req.body || {}).path as string | undefined;
  if (!filePath || !fsSync.existsSync(filePath)) {
    res.status(400).json({ error: `path required and must exist (got: ${filePath})` });
    return;
  }
  try {
    const data = yaml.load(fsSync.readFileSync(filePath, 'utf-8')) as Parameters<typeof importEpicsYaml>[0];
    const result = importEpicsYaml(data);
    logger.info(`[Projects] EPICS.yaml seeded from ${filePath}: ${result.epics} epic(s), ${result.checkpoints} checkpoint(s)`);
    res.json({ success: true, ...result, note: 'DB is now the source of truth; the yaml file is historical.' });
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});

// ─── LEGACY dashboard stub below (fake/random data — kept only so the Gantt UI
//     doesn't break; must be rewired to projectStatus() and then removed). ─────

// ─── Get Projects ────────────────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    const projectRoot = SPACEOS_ROOT;
    const tasksDir = path.join(projectRoot, 'docs/tasks');

    const projects: any[] = [];
    const milestones: any[] = [];

    try {
      const activeFiles = await fs.readdir(path.join(tasksDir, 'active'));
      for (const file of activeFiles.filter(f => f.endsWith('.md'))) {
        const content = await fs.readFile(path.join(tasksDir, 'active', file), 'utf-8');
        const match = content.match(/^#\s+(.+)$/m);
        const title = match ? match[1] : file;

        projects.push({
          id: file,
          name: title,
          status: 'active',
          priority: 'high',
          startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          progress: Math.floor(Math.random() * 80),
          terminal: 'nexus',
          epic: 'NEXUS-001',
          tasks: 10,
          completedTasks: Math.floor(Math.random() * 8),
        });
      }
    } catch (err) { /* dir may not exist */ }

    milestones.push({
      id: 'milestone-1',
      name: 'Nexus Phase 6 Complete',
      date: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'upcoming',
    });

    res.json({ projects, milestones });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
