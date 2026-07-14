/**
 * Escalation API Routes
 * Manage task escalation configuration and status
 */

import { Router } from 'express';
import {
  taskEscalationManager,
  setEscalationConfig,
  getEscalationConfig,
} from '../pipeline/taskEscalation';

const router = Router();

/**
 * GET /api/escalation/config
 * Get current escalation configuration
 */
router.get('/config', (req, res) => {
  const config = getEscalationConfig();
  res.json(config);
});

/**
 * POST /api/escalation/config
 * Update escalation configuration
 *
 * Body: Partial<EscalationConfig>
 * {
 *   maxRetries?: number,
 *   retryIntervalMinutes?: number,
 *   escalateTo?: string,
 *   retryStrategies?: { first: ..., second: ... }
 * }
 */
router.post('/config', (req, res) => {
  const { maxRetries, retryIntervalMinutes, escalateTo, retryStrategies } = req.body;

  const updates: any = {};
  if (maxRetries !== undefined) updates.maxRetries = maxRetries;
  if (retryIntervalMinutes !== undefined) updates.retryIntervalMinutes = retryIntervalMinutes;
  if (escalateTo !== undefined) updates.escalateTo = escalateTo;
  if (retryStrategies !== undefined) updates.retryStrategies = retryStrategies;

  setEscalationConfig(updates);

  res.json({
    success: true,
    config: getEscalationConfig(),
  });
});

/**
 * GET /api/escalation/status
 * Get all escalations (active, resolved, escalated)
 */
router.get('/status', (req, res) => {
  const { status } = req.query;

  const escalations = taskEscalationManager.getEscalations(
    status as 'active' | 'resolved' | 'escalated' | undefined
  );

  res.json({
    total: escalations.length,
    escalations,
  });
});

/**
 * POST /api/escalation/:id/resolve
 * Mark escalation as resolved
 */
router.post('/:id/resolve', async (req, res) => {
  const { id } = req.params;

  const success = await taskEscalationManager.resolveEscalation(id);

  if (success) {
    res.json({ success: true, message: 'Escalation resolved' });
  } else {
    res.status(404).json({ success: false, message: 'Escalation not found' });
  }
});

export default router;
