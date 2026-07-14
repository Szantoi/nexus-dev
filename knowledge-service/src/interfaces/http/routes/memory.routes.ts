/**
 * Memory Tier Management Routes (ADR-046 Track D)
 * Tiered memory queries, save, promote
 */

import { Router, Request, Response } from 'express';

const router = Router();

// ─── Query Memories by Tier ──────────────────────────────────────────────────

router.get('/tiered', async (req: Request, res: Response) => {
  try {
    const terminal = String(req.query.terminal || '');
    const tiersParam = String(req.query.tiers || 'hot,warm');
    const limit = parseInt(req.query.limit as string) || 20;

    if (!terminal) {
      return res.status(400).json({ error: 'Missing "terminal" parameter' });
    }

    const { queryByTier } = await import('../../../pipeline/memoryStore');
    const tiers = tiersParam.split(',').map(t => t.trim()) as Array<'hot' | 'warm' | 'cold' | 'shared'>;
    const memories = queryByTier(terminal, tiers, limit);

    res.json({
      terminal,
      tiers,
      count: memories.length,
      memories: memories.map(m => ({
        id: m.id,
        tier: m.tier,
        type: m.type,
        content: m.content.substring(0, 200) + (m.content.length > 200 ? '...' : ''),
        salience: m.salience,
        createdAt: m.createdAt,
        accessedAt: m.accessedAt,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Save Tiered Memory ──────────────────────────────────────────────────────

router.post('/save', async (req: Request, res: Response) => {
  try {
    const { tier, type, source, content, terminal, context, salience } = req.body;

    if (!tier || !type || !source || !content) {
      return res.status(400).json({
        error: 'Missing required fields: tier, type, source, content',
      });
    }

    const { saveTieredMemory } = await import('../../../pipeline/memoryStore');
    const memory = await saveTieredMemory({
      tier,
      type,
      source,
      content,
      terminal,
      context,
      salience,
    });

    res.json({
      success: true,
      memory: {
        id: memory.id,
        tier: memory.tier,
        type: memory.type,
        salience: memory.salience,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Promote Memory to Higher Tier ───────────────────────────────────────────

router.post('/:id/promote', async (req: Request, res: Response) => {
  try {
    const memoryId = parseInt(String(req.params.id));
    const { newTier, reason } = req.body;

    if (!newTier || !reason) {
      return res.status(400).json({
        error: 'Missing required fields: newTier, reason',
      });
    }

    const { promoteMemory } = await import('../../../pipeline/memoryStore');
    await promoteMemory(memoryId, newTier, reason);

    res.json({
      success: true,
      memoryId,
      newTier,
      reason,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
