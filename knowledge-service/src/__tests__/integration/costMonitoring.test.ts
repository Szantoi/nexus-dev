/**
 * Cost Monitoring Integration Tests
 * Tests HTTP endpoints for cost monitoring dashboard
 * Part of MSG-BACKEND-126
 */

import request from 'supertest';
import express from 'express';
import costMonitoringRoutes from '../../interfaces/http/routes/costMonitoringRoutes';

describe('Cost Monitoring API Endpoints', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/monitoring/cost', costMonitoringRoutes);
  });

  describe('GET /api/monitoring/cost/today', () => {
    it('should return today cost summary', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/today')
        .expect(200);

      expect(res.body).toHaveProperty('date');
      expect(res.body).toHaveProperty('dailyBudget');
      expect(res.body).toHaveProperty('current');
      expect(res.body).toHaveProperty('currency', 'USD');
      expect(res.body).toHaveProperty('thresholdStatus');
      expect(res.body).toHaveProperty('percentageUsed');
      expect(res.body).toHaveProperty('remaining');
      expect(res.body).toHaveProperty('terminals');
      expect(Array.isArray(res.body.terminals)).toBe(true);
    });

    it('should use cache for repeated requests', async () => {
      const res1 = await request(app).get('/api/monitoring/cost/today');
      const res2 = await request(app).get('/api/monitoring/cost/today');

      expect(res1.body).toEqual(res2.body);
    });
  });

  describe('GET /api/monitoring/cost/terminal/:terminal', () => {
    it('should return terminal cost detail', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/terminal/backend')
        .expect(200);

      expect(res.body).toHaveProperty('terminal', 'backend');
      expect(res.body).toHaveProperty('today');
      expect(res.body.today).toHaveProperty('cost');
      expect(res.body.today).toHaveProperty('workers');
      expect(res.body).toHaveProperty('history');
      expect(res.body).toHaveProperty('averageDailyCost');
      expect(res.body).toHaveProperty('costTrend');
    });

    it('should reject invalid terminal names', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/terminal/invalid-terminal')
        .expect(400);

      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toContain('Invalid terminal');
    });

    it('should accept days query parameter', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/terminal/backend?days=14')
        .expect(200);

      expect(res.body.history.length).toBeLessThanOrEqual(14);
    });
  });

  describe('GET /api/monitoring/cost/history', () => {
    it('should return cost history', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/history')
        .expect(200);

      expect(res.body).toHaveProperty('period');
      expect(res.body.period).toHaveProperty('start');
      expect(res.body.period).toHaveProperty('end');
      expect(res.body.period).toHaveProperty('days');
      expect(res.body).toHaveProperty('dailyBudget');
      expect(res.body).toHaveProperty('totalCost');
      expect(res.body).toHaveProperty('averageDailyCost');
      expect(res.body).toHaveProperty('history');
      expect(Array.isArray(res.body.history)).toBe(true);
    });

    it('should respect days parameter with max 30 days', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/history?days=50')
        .expect(200);

      expect(res.body.period.days).toBeLessThanOrEqual(30);
    });
  });

  describe('GET /api/monitoring/cost/config', () => {
    it('should return cost configuration', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/config')
        .expect(200);

      expect(res.body).toHaveProperty('dailyBudget');
      expect(res.body).toHaveProperty('softAlertThreshold');
      expect(res.body).toHaveProperty('hardAlertThreshold');
      expect(res.body).toHaveProperty('autoPauseThreshold');
      expect(res.body).toHaveProperty('alertChannels');
      expect(res.body).toHaveProperty('pauseNotification');
    });
  });

  describe('PUT /api/monitoring/cost/config', () => {
    it('should update daily budget', async () => {
      const res = await request(app)
        .put('/api/monitoring/cost/config')
        .send({ dailyBudget: 75 })
        .expect(200);

      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('config');
      expect(res.body.config.dailyBudget).toBe(75);
      expect(res.body).toHaveProperty('updatedAt');
    });

    it('should reject invalid budget values', async () => {
      const res = await request(app)
        .put('/api/monitoring/cost/config')
        .send({ dailyBudget: -10 })
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });
  });

  describe('POST /api/monitoring/cost/pause-notification', () => {
    it('should record pause notification', async () => {
      const res = await request(app)
        .post('/api/monitoring/cost/pause-notification')
        .send({
          currentCost: 40,
          dailyBudget: 50,
          thresholdStatus: 'critical',
          terminals: [{ name: 'backend', cost: 25 }],
        })
        .expect(200);

      expect(res.body).toHaveProperty('status', 'acknowledged');
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('coordinatorNotified');
    });

    it('should reject missing fields', async () => {
      const res = await request(app)
        .post('/api/monitoring/cost/pause-notification')
        .send({ currentCost: 40 })
        .expect(400);

      expect(res.body).toHaveProperty('error');
    });
  });

  describe('GET /api/monitoring/cost/stream (SSE)', () => {
    it('should return SSE stream headers', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/stream')
        .timeout(1000); // Short timeout to avoid waiting full 5 minutes

      // SSE should set correct headers
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
    });
  });

  describe('GET /api/monitoring/cost/health', () => {
    it('should return health status', async () => {
      const res = await request(app)
        .get('/api/monitoring/cost/health')
        .expect(200);

      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('service', 'cost-monitoring');
      expect(res.body).toHaveProperty('cacheSize');
    });
  });
});
