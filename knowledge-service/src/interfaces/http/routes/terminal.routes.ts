/**
 * Terminal Status Routes
 * Terminal state management, heartbeat, full status
 */

import { Router, Request, Response } from 'express';
import {
  registerWorking,
  registerIdle,
  heartbeat,
  getAllStatus,
  getStatus,
  getFullTerminalStatus,
} from '../../../terminalStatus';

const router = Router();

// ─── Set/Update Terminal Status ──────────────────────────────────────────────

router.post('/:terminal/status', (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const { state, taskId } = req.body as { state?: 'working' | 'idle'; taskId?: string };

  if (state === 'working') {
    registerWorking(terminal, taskId);
    res.json({ success: true, terminal, state: 'working', taskId });
  } else if (state === 'idle') {
    registerIdle(terminal);
    res.json({ success: true, terminal, state: 'idle' });
  } else {
    // Heartbeat if no state specified
    heartbeat(terminal);
    res.json({ success: true, terminal, action: 'heartbeat' });
  }
});

// ─── Get Terminal Status ─────────────────────────────────────────────────────

router.get('/:terminal/status', (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);
  const status = getStatus(terminal);
  res.json({ terminal, status: status || { state: 'idle', lastActivity: null } });
});

// ─── Get All Terminal Status ─────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  res.json({ terminals: getAllStatus() });
});

// ─── Full Terminal Status (includes inbox/outbox counts) ─────────────────────

router.get('/:terminal/full-status', async (req: Request, res: Response) => {
  const terminal = String(req.params.terminal);

  try {
    const status = await getFullTerminalStatus(terminal);
    res.json(status);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
