/**
 * Auth Routes
 * Simple token verification for React Dashboard
 */

import { Router, Request, Response } from 'express';

const router = Router();

// Simple auth token (no database, just static token from env)
const DASHBOARD_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || 'dev-token-spaceos-dashboard-2026';

// ─── Verify Auth Token ───────────────────────────────────────────────────────

const verifyAuthToken = (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (token === DASHBOARD_TOKEN) {
    res.json({ valid: true, message: 'Token is valid' });
  } else {
    res.status(401).json({ valid: false, message: 'Invalid token' });
  }
};

router.get('/verify', verifyAuthToken);
router.post('/verify', verifyAuthToken);

export default router;
