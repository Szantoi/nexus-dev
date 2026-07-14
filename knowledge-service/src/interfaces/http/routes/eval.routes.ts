/**
 * Agent-eval API (Golden Path Recording + Trajectory Comparison).
 *
 * Endpoints (Bearer-authed, same island auth as /api/federation):
 *   POST /api/eval/golden          { message_id, name }  — record a golden path
 *   GET  /api/eval/golden          — list recorded golden paths
 *   GET  /api/eval/golden/:name    — one golden path, full content
 *   POST /api/eval/compare         { message_id, golden } — score a message's
 *        actual trajectory against a golden path; returns score + named deviations
 *
 * WHY HTTP: the eval runner (fleet CLI / CI) and the dashboard consume these
 * without touching the DB directly; every consumer sees the same deterministic
 * scoring. See src/eval/* for the domain logic and the research doc
 * (AGENT_BEHAVIOR_TESTING_2026.md) for the methodology.
 */
import { Router, Request, Response } from 'express';
import { authenticateRest } from '../../../mcp';
import { recordGoldenPath, loadGoldenPath, listGoldenPaths, importGoldenPaths } from '../../../eval/goldenPath';
import { compareTrajectory } from '../../../eval/trajectoryComparator';
import { expectedTrajectory } from '../../../eval/workflowModel';
import { getMessage, getStatusHistory } from '../../../task-message-box/store';
import { logger } from '../../../core/logger';

export function createEvalApiRouter(): Router {
  const router = Router();
  router.use(authenticateRest);

  router.post('/golden', async (req: Request, res: Response): Promise<void> => {
    const { message_id, name } = (req.body || {}) as { message_id?: string; name?: string };
    if (!message_id || !name) { res.status(400).json({ error: 'message_id and name required' }); return; }
    const result = await recordGoldenPath(message_id, name);
    if (!result.success) {
      res.status(result.error?.includes('not found') ? 404 : 422).json({ error: result.error });
      return;
    }
    res.json({ success: true, name, trajectory: result.golden?.trajectory });
  });

  router.get('/golden', (_req: Request, res: Response): void => {
    res.json({ success: true, golden_paths: listGoldenPaths() });
  });

  // POST /api/eval/golden/import   { golden_paths: GoldenPath[] }
  // Bulk-load golden paths from an external migration (e.g. the VPS legacy-DONE
  // parser). Each is validated (name + canonical-status trajectory); per-item
  // accept/reject is returned so nothing is silently dropped.
  router.post('/golden/import', (req: Request, res: Response): void => {
    const items = (req.body || {}).golden_paths;
    if (!Array.isArray(items)) { res.status(400).json({ error: 'golden_paths array required' }); return; }
    const result = importGoldenPaths(items);
    logger.info(`[Eval] golden import: ${result.imported.length} accepted, ${result.rejected.length} rejected`);
    res.json({ success: true, ...result });
  });

  router.get('/golden/:name', (req: Request, res: Response): void => {
    const gp = loadGoldenPath(String(req.params.name));
    if (!gp) { res.status(404).json({ error: 'golden path not found' }); return; }
    res.json({ success: true, golden: gp });
  });

  router.post('/compare', async (req: Request, res: Response): Promise<void> => {
    const { message_id, golden } = (req.body || {}) as { message_id?: string; golden?: string };
    if (!message_id || !golden) { res.status(400).json({ error: 'message_id and golden required' }); return; }

    const gp = loadGoldenPath(golden);
    if (!gp) { res.status(404).json({ error: `golden path not found: ${golden}` }); return; }
    const msg = await getMessage(message_id);
    if (!msg) { res.status(404).json({ error: `message not found: ${message_id}` }); return; }

    const actual = getStatusHistory(message_id).map(h => h.to);
    const result = compareTrajectory(actual, gp.trajectory);
    logger.info(`[Eval] ${message_id} vs '${golden}': score ${result.score} (${result.deviations.length} deviation(s))`);
    res.json({ success: true, message_id, golden_name: golden, ...result });
  });

  // POST /api/eval/conformance   { message_id }
  // Score a message's ACTUAL trajectory against the DECLARED workflow for its
  // type (config/workflows.yaml) — the prescriptive counterpart of golden-path
  // comparison. No recorded reference needed: the expectation is config.
  router.post('/conformance', async (req: Request, res: Response): Promise<void> => {
    const { message_id } = (req.body || {}) as { message_id?: string };
    if (!message_id) { res.status(400).json({ error: 'message_id required' }); return; }
    const msg = await getMessage(message_id);
    if (!msg) { res.status(404).json({ error: `message not found: ${message_id}` }); return; }

    const expected = expectedTrajectory(msg.type);
    const actual = getStatusHistory(message_id).map(h => h.to);
    const result = compareTrajectory(actual, expected);
    logger.info(`[Eval] conformance ${message_id} (type=${msg.type}): score ${result.score} vs declared workflow`);
    res.json({ success: true, message_id, type: msg.type, workflow: expected, ...result });
  });

  return router;
}

export default { createEvalApiRouter };
