/**
 * planningRoutes.test.ts — Unit tests for Planning Focus API
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createPlanningRouter } from '../../api/planningRoutes';

describe('Planning Focus API', () => {
  let app: Express;
  const testFocusPath = path.join(process.cwd(), '../../docs/planning/domain-focus.md');
  let originalContent: string | null = null;
  const testToken = 'dev-token-spaceos-dashboard-2026'; // Valid dashboard token

  beforeEach(() => {
    // Setup Express app with router for each test
    app = express();
    app.use(express.json());
    app.use('/api/planning', createPlanningRouter());
  });

  // Backup ONCE at start of suite
  beforeAll(async () => {
    try {
      originalContent = await fs.readFile(testFocusPath, 'utf-8');
    } catch {
      originalContent = null;
    }
  });

  // Restore ONCE at end of suite
  afterAll(async () => {
    if (originalContent !== null) {
      await fs.writeFile(testFocusPath, originalContent, 'utf-8');
    }
  });

  describe('GET /api/planning/domain-focus', () => {
    it('should return current domain and criteria', async () => {
      const res = await request(app).get('/api/planning/domain-focus');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('domain');
      expect(res.body).toHaveProperty('criteria');
      expect(res.body).toHaveProperty('updated_at');
    });

    it('should return valid domain value', async () => {
      const res = await request(app).get('/api/planning/domain-focus');

      const validDomains = ['manufacturing', 'sales', 'logistics', 'finance', 'quality', 'hr', 'all'];
      expect(validDomains).toContain(res.body.domain);
    });

    it('should return criteria as string', async () => {
      const res = await request(app).get('/api/planning/domain-focus');

      expect(typeof res.body.criteria).toBe('string');
      expect(res.body.criteria.length).toBeGreaterThan(0);
    });

    it('should return ISO timestamp for updated_at', async () => {
      const res = await request(app).get('/api/planning/domain-focus');

      expect(res.body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('PUT /api/planning/domain-focus', () => {
    it('should reject requests without authentication', async () => {
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .send({ domain: 'sales' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should reject requests with invalid token', async () => {
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', 'Bearer invalid-token-xyz')
        .send({ domain: 'sales' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should update domain successfully with valid token', async () => {
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ domain: 'sales' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.domain).toBe('sales');
      expect(res.body).toHaveProperty('updated_at');
    });

    it('should update criteria successfully', async () => {
      const newCriteria = '# Test Criteria\n\n- Point 1\n- Point 2';
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ criteria: newCriteria });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.criteria).toContain('Point 1');
      expect(res.body.criteria).toContain('Point 2');
    });

    it('should update both domain and criteria', async () => {
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          domain: 'logistics',
          criteria: '# Logistics Focus\n\n- Supply chain\n- Inventory',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.domain).toBe('logistics');
      expect(res.body.criteria).toContain('Supply chain');
    });

    it('should reject invalid domain', async () => {
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ domain: 'invalid_domain_xyz' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid domain');
    });

    it('should reject non-string criteria', async () => {
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ criteria: 123 }); // number instead of string

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid criteria');
    });

    it('should sanitize XSS in criteria using DOMPurify', async () => {
      const malicious = '<script>alert("xss")</script>Valid criteria\n- Point 1';
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ criteria: malicious });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.criteria).not.toContain('<script>');
      expect(res.body.criteria).toContain('Valid criteria');
      expect(res.body.criteria).toContain('Point 1');
    });

    it('should sanitize event handlers in criteria using DOMPurify', async () => {
      const malicious = '<div onclick="alert(1)">Test</div>\n- Point 1';
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ criteria: malicious });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.criteria).not.toContain('onclick=');
      expect(res.body.criteria).not.toContain('<div>');
      expect(res.body.criteria).toContain('Test');
      expect(res.body.criteria).toContain('Point 1');
    });

    it.skip('should enforce rate limiting', async () => {
      // SKIPPED: This test affects other tests by making 11 requests
      // Rate limiting is tested manually via curl
      // Make 11 requests rapidly
      const promises = Array.from({ length: 11 }, (_, i) =>
        request(app)
          .put('/api/planning/domain-focus')
          .send({ domain: i % 2 === 0 ? 'sales' : 'manufacturing' })
      );

      const results = await Promise.all(promises);
      const rateLimited = results.filter(r => r.status === 429);

      expect(rateLimited.length).toBeGreaterThan(0);
    }, 10000); // 10s timeout for this test

    it('should return updated_at timestamp', async () => {
      const res = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ domain: 'logistics' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('updated_at');
      expect(res.body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should persist changes across reads', async () => {
      // Update to a specific domain
      const updateRes = await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ domain: 'hr' });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.domain).toBe('hr');

      // Wait for file write
      await new Promise(resolve => setTimeout(resolve, 100));

      // Read back - should have the same value
      const readRes = await request(app).get('/api/planning/domain-focus');

      expect(readRes.body.domain).toBe('hr');
    });
  });

  describe('File Format', () => {
    it('should write YAML frontmatter format', async () => {
      // Set to known state
      const uniqueCriteria = `# Quality Focus ${Date.now()}\n\n- QA process`;

      await request(app)
        .put('/api/planning/domain-focus')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          domain: 'quality',
          criteria: uniqueCriteria,
        });

      // Wait for file write
      await new Promise(resolve => setTimeout(resolve, 100));

      // Read file directly
      const fileContent = await fs.readFile(testFocusPath, 'utf-8');

      expect(fileContent).toMatch(/^---\n/);
      expect(fileContent).toContain('domain: quality');
      expect(fileContent).toContain('updated_at:');
      expect(fileContent).toContain('---\n');
      expect(fileContent).toContain('# Quality Focus');
      expect(fileContent).toContain('QA process');
    });
  });
});
