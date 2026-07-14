/**
 * Channels Routes
 * Multi-channel notification (Telegram, Slack, Discord)
 */

import { Router, Request, Response } from 'express';
import {
  getMultiChannelStatus,
  validateAllTokens,
  notifyAllChannels,
  notifyChannel,
  type ChannelProviderType,
} from '../../../pipeline';

const router = Router();

// ─── Get Status ──────────────────────────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = getMultiChannelStatus();
    res.json(status);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Validate Tokens ─────────────────────────────────────────────────────────

router.get('/validate', async (_req: Request, res: Response) => {
  try {
    const results = await validateAllTokens();
    res.json(results);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Notify All Channels ─────────────────────────────────────────────────────

router.post('/notify', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    const results = await notifyAllChannels(message);
    res.json({ results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Notify Specific Channel ─────────────────────────────────────────────────

router.post('/:channel/notify', async (req: Request, res: Response) => {
  try {
    const channel = req.params.channel as ChannelProviderType;
    const { message } = req.body;

    if (!['telegram', 'slack', 'discord'].includes(channel)) {
      return res.status(400).json({ error: 'Invalid channel type' });
    }
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const result = await notifyChannel(channel, message);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
