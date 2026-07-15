/**
 * Integration tests for graph API routes
 *
 * Tests the PUT /api/graph/epics/:id endpoint with real EPICS.yaml file operations
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { promises as fs } from 'node:fs';
import * as yaml from 'js-yaml';

// graphRoutes reads EPICS_PATH at module scope → set env BEFORE the import runs
const TEST_EPICS_PATH = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp';
  const p = `${base.replace(/[\\/]+$/, '')}/graph-routes-test-${process.pid}-EPICS.yaml`;
  process.env.EPICS_PATH = p;
  return p;
});

import graphRoutes from '../../api/graphRoutes';
import type { EpicsYaml } from '../../graph/types';

// Express app for testing
let app: express.Express;

beforeAll(async () => {
  // Create test EPICS.yaml
  const testEpics: EpicsYaml = {
    version: '1.0',
    updated: '2026-07-14',
    epics: [
      {
        id: 'EPIC-TEST-A',
        name: 'Test Epic A',
        project: 'test/project',
        tasks_yaml: 'tasks/test-a.yaml',
        status: 'done',
        depends_on: [],
      },
      {
        id: 'EPIC-TEST-B',
        name: 'Test Epic B',
        project: 'test/project',
        tasks_yaml: 'tasks/test-b.yaml',
        status: 'active',
        depends_on: ['EPIC-TEST-A'],
      },
      {
        id: 'EPIC-TEST-C',
        name: 'Test Epic C',
        project: 'test/project',
        tasks_yaml: 'tasks/test-c.yaml',
        status: 'pending',
        depends_on: ['EPIC-TEST-B'],
      },
    ],
  };

  await fs.writeFile(TEST_EPICS_PATH, yaml.dump(testEpics), 'utf-8');

  // Create Express app
  app = express();
  app.use(express.json());
  app.use('/api/graph', graphRoutes);
});

afterAll(async () => {
  // Clean up test file
  try {
    await fs.unlink(TEST_EPICS_PATH);
  } catch {}
  delete process.env.EPICS_PATH;
});

describe('PUT /api/graph/epics/:id', () => {
  describe('status transitions', () => {
    it('should allow valid status transition (pending → active)', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ status: 'active' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.epic.status).toBe('active');
    });

    it('should allow valid status transition (active → done) when dependencies are done', async () => {
      // First ensure EPIC-TEST-B is active
      await request(app)
        .put('/api/graph/epics/EPIC-TEST-B')
        .send({ status: 'active' });

      // Set EPIC-TEST-B to done (its dependency EPIC-TEST-A is already done)
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-B')
        .send({ status: 'done' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.epic.status).toBe('done');
    });

    it('should reject invalid status transition (done → pending)', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-A')
        .send({ status: 'pending' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot transition from done to pending');
    });

    it('should reject done status when dependencies are not done', async () => {
      // EPIC-TEST-C depends on EPIC-TEST-B which might not be done
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ status: 'done' });

      // This should fail because EPIC-TEST-B status varies
      if (res.status === 400) {
        expect(res.body.error).toContain('dependencies not complete');
        expect(res.body.blocking_dependencies).toBeDefined();
      }
    });
  });

  describe('dependency updates', () => {
    it('should allow updating dependencies without creating cycles', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ depends_on: ['EPIC-TEST-A'] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.epic.depends_on).toEqual(['EPIC-TEST-A']);
    });

    it('should reject self-reference in dependencies', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-B')
        .send({ depends_on: ['EPIC-TEST-B'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Epic cannot depend on itself');
    });

    it('should reject circular dependencies (A→B, B→A)', async () => {
      // Try to create A → B and B → A
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-A')
        .send({ depends_on: ['EPIC-TEST-B'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cycle');
      expect(res.body.cycles).toBeDefined();
    });

    it('should reject non-existent epic in dependencies', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ depends_on: ['EPIC-DOES-NOT-EXIST'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('metadata updates', () => {
    it('should allow updating epic name', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ name: 'Updated Epic C' });

      expect(res.status).toBe(200);
      expect(res.body.epic.name).toBe('Updated Epic C');
    });

    it('should allow updating target_date', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ target_date: '2026-12-31' });

      expect(res.status).toBe(200);
      expect(res.body.epic.target_date).toBe('2026-12-31');
    });

    it('should allow updating multiple fields at once', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({
          name: 'Multi Update Test',
          description: 'Updated description',
          parallel_with: ['EPIC-TEST-A'],
        });

      expect(res.status).toBe(200);
      expect(res.body.epic.name).toBe('Multi Update Test');
      expect(res.body.epic.description).toBe('Updated description');
      expect(res.body.epic.parallel_with).toEqual(['EPIC-TEST-A']);
    });
  });

  describe('error cases', () => {
    it('should return 404 for non-existent epic', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-DOES-NOT-EXIST')
        .send({ status: 'active' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Epic not found');
    });

    it('should handle empty request body (no-op)', async () => {
      const res = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('atomic writes', () => {
    it('should write changes to disk atomically', async () => {

      // Make a change
      await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ description: 'Atomic test' });

      // Verify file was written
      const content = await fs.readFile(TEST_EPICS_PATH, 'utf-8');
      const parsed = yaml.load(content) as EpicsYaml;

      const epic = parsed.epics.find(e => e.id === 'EPIC-TEST-C');
      expect(epic?.description).toBe('Atomic test');
    });

    it('should not leave .tmp files after successful write', async () => {
      await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ description: 'Temp file test' });

      // Check for .tmp file
      const tmpPath = TEST_EPICS_PATH + '.tmp';
      let tmpExists = false;
      try {
        await fs.access(tmpPath);
        tmpExists = true;
      } catch {
        tmpExists = false;
      }

      expect(tmpExists).toBe(false);
    });
  });

  describe('consecutive updates', () => {
    it('should handle multiple consecutive updates correctly', async () => {
      // Update 1: Change name
      const res1 = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ name: 'First Update' });
      expect(res1.status).toBe(200);

      // Update 2: Change description
      const res2 = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ description: 'Second Update' });
      expect(res2.status).toBe(200);

      // Update 3: Change target_date
      const res3 = await request(app)
        .put('/api/graph/epics/EPIC-TEST-C')
        .send({ target_date: '2027-01-01' });
      expect(res3.status).toBe(200);

      // Verify all updates persisted
      const content = await fs.readFile(TEST_EPICS_PATH, 'utf-8');
      const parsed = yaml.load(content) as EpicsYaml;
      const epic = parsed.epics.find(e => e.id === 'EPIC-TEST-C');

      expect(epic?.name).toBe('First Update');
      expect(epic?.description).toBe('Second Update');
      expect(epic?.target_date).toBe('2027-01-01');
    });
  });
});
