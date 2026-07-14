/**
 * Knowledge Service Routes
 * Vector search and indexing
 */

import { Router, Request, Response } from 'express';
import { searchKnowledge } from '../../../vectorStore';
import { buildIndex } from '../../../indexer';
import { validate, SearchBodySchema, SearchQuerySchema } from '../../../validation';

const router = Router();

// ─── Search Knowledge (GET) ──────────────────────────────────────────────────

router.get('/search', async (req: Request, res: Response) => {
  const queryParam = String(req.query.q || '');
  const topKParam = parseInt(String(req.query.topK || '5'), 10);

  if (!queryParam) {
    return res.status(400).json({ error: 'Missing query parameter "q"' });
  }

  try {
    const results = await searchKnowledge(queryParam, topKParam);
    res.json({ query: queryParam, topK: topKParam, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Search Knowledge (POST) ─────────────────────────────────────────────────

router.post('/search', validate(SearchBodySchema), async (req: Request, res: Response) => {
  const { q, topK = 5 } = req.body;

  try {
    const results = await searchKnowledge(q, topK);
    res.json({ query: q, topK, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Re-index Knowledge Base ─────────────────────────────────────────────────

router.post('/index', async (_req: Request, res: Response) => {
  try {
    await buildIndex();
    res.json({ success: true, message: 'Re-indexing complete' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
