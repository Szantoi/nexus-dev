/**
 * Task Audit Routes
 * Task creation, audit log, daily summary
 */

import { Router, Request, Response } from 'express';
import { createTask, queryCreationLog, getDailySummary } from '../../../task-audit/taskCreation';
import { verifyToken } from '../../../task-audit/auth';
import { generateAndPublishDailyReport } from '../../../task-audit/dailyReport';

const router = Router();

// ─── Auth Helper ─────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response): { authenticated: true; holder: string } | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return null;
  }

  const token = authHeader.substring(7);
  const authResult = verifyToken(token);

  if (!authResult.authenticated) {
    res.status(401).json({ error: authResult.error });
    return null;
  }

  return { authenticated: true, holder: authResult.holder || 'api' };
}

// ─── Task Creation ───────────────────────────────────────────────────────────

router.post('/create', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const result = await createTask(token, req.body);
    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('[Task API] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Audit Log Query ─────────────────────────────────────────────────────────

router.get('/audit', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  try {
    const entries = await queryCreationLog({
      created_by: req.query.created_by as string | undefined,
      assigned_to: req.query.assigned_to as string | undefined,
      date: req.query.date as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    });
    res.json({ entries, total: entries.length });
  } catch (error) {
    console.error('[Task API] Audit query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Daily Summary ───────────────────────────────────────────────────────────

router.get('/daily-summary', async (req: Request, res: Response) => {
  // No auth required for summary (read-only aggregate data)
  try {
    const date = req.query.date as string | undefined;
    const summary = await getDailySummary(date);
    res.json(summary);
  } catch (error) {
    console.error('[Task API] Summary error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Daily Report Generation ─────────────────────────────────────────────────

router.post('/daily-report', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  try {
    const date = req.body.date as string | undefined;
    const { report, markdownPath } = await generateAndPublishDailyReport(date);
    res.json({
      success: true,
      report,
      markdownPath,
    });
  } catch (error) {
    console.error('[Task API] Daily report error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
