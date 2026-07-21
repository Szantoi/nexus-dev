/**
 * Auth Routes
 * Simple token verification for React Dashboard
 */

import { Router, Request, Response } from 'express';

const router = Router();

// Simple auth token (no database, just static token from central config)
import { secrets } from '../../../config/env';
const DASHBOARD_TOKEN = secrets.dashboardAuthToken;

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
