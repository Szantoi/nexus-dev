/**
 * Daily Digest Routes (ADR-046 Track D)
 * Generate and retrieve terminal digests
 */

import { Router, Request, Response } from 'express';

const router = Router();

// ─── Generate Daily Digest ───────────────────────────────────────────────────

router.post('/generate', async (req: Request, res: Response) => {
  try {
    const { terminal, date } = req.body;

    if (!terminal) {
      return res.status(400).json({ error: 'Missing "terminal" field' });
    }

    const digestDate = date || new Date().toISOString().split('T')[0];
    const { generateDailyDigest } = await import('../../../digest');
    const result = await generateDailyDigest({ terminal, date: digestDate });

    res.json({
      success: true,
      digest: {
        terminal: result.terminal,
        date: result.date,
        sessionCount: result.sessionCount,
        memoriesCreated: result.memoriesCreated,
        toolCallsTotal: result.toolCallsTotal,
        tasksCompleted: result.tasksCompleted,
        tasksBlocked: result.tasksBlocked,
        summary: result.summary,
        savedAsMemory: result.savedAsMemory,
        digestMarkdown: result.digestMarkdown,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Get Daily Digest ────────────────────────────────────────────────────────

router.get('/:terminal/:date', async (req: Request, res: Response) => {
  try {
    const terminal = String(req.params.terminal);
    const date = String(req.params.date);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        error: 'Invalid date format - must be YYYY-MM-DD',
      });
    }

    const { generateDailyDigest } = await import('../../../digest');
    const result = await generateDailyDigest({ terminal, date });

    res.json({
      terminal: result.terminal,
      date: result.date,
      sessionCount: result.sessionCount,
      memoriesCreated: result.memoriesCreated,
      toolCallsTotal: result.toolCallsTotal,
      tasksCompleted: result.tasksCompleted,
      tasksBlocked: result.tasksBlocked,
      summary: result.summary,
      digestMarkdown: result.digestMarkdown,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
