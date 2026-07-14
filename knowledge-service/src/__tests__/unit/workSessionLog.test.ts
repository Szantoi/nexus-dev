/**
 * Work Session Log Unit Tests
 *
 * Tests for ADR-049 Phase 2 work session logging functionality
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  logWorkSessionRequest,
  logWorkSessionSpawn,
  queryWorkRequests,
  queryWorkSpawns,
  getWorkSessionStats,
  hashTask,
  generateRequestId,
  generateSpawnId,
} from '../../pipeline/workSessionLog';

// Test with a temporary directory
const TEST_LOG_DIR = '/tmp/spaceos-test-logs';
const ORIGINAL_ROOT = process.env.SPACEOS_ROOT;

describe('Work Session Log', () => {
  beforeEach(async () => {
    // Set up test directory
    process.env.SPACEOS_ROOT = TEST_LOG_DIR;
    await fs.mkdir(path.join(TEST_LOG_DIR, 'logs/work-sessions'), { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(TEST_LOG_DIR, { recursive: true, force: true });
    } catch {}
    if (ORIGINAL_ROOT) {
      process.env.SPACEOS_ROOT = ORIGINAL_ROOT;
    }
  });

  describe('hashTask', () => {
    it('should generate consistent hash for same input', async () => {
      const task = 'Implement user authentication';
      const hash1 = await hashTask(task);
      const hash2 = await hashTask(task);
      expect(hash1).toBe(hash2);
    });

    it('should generate different hash for different input', async () => {
      const hash1 = await hashTask('Task A');
      const hash2 = await hashTask('Task B');
      expect(hash1).not.toBe(hash2);
    });

    it('should return 16-character hash', async () => {
      const hash = await hashTask('Any task');
      expect(hash).toHaveLength(16);
    });
  });

  describe('generateRequestId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      expect(id1).not.toBe(id2);
    });

    it('should start with WORK-REQ-', () => {
      const id = generateRequestId();
      expect(id).toMatch(/^WORK-REQ-/);
    });

    it('should include date', () => {
      const id = generateRequestId();
      const today = new Date().toISOString().split('T')[0];
      expect(id).toContain(today);
    });
  });

  describe('generateSpawnId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateSpawnId();
      const id2 = generateSpawnId();
      expect(id1).not.toBe(id2);
    });

    it('should start with WORK-SPAWN-', () => {
      const id = generateSpawnId();
      expect(id).toMatch(/^WORK-SPAWN-/);
    });
  });

  describe('logWorkSessionRequest', () => {
    it('should log request and return full entry', async () => {
      const entry = await logWorkSessionRequest({
        from_terminal: 'librarian',
        task_summary: 'Create knowledge summary',
        task_hash: 'abc123def456',
        priority: 'medium',
        success: true,
      });

      expect(entry.request_id).toMatch(/^WORK-REQ-/);
      expect(entry.type).toBe('request');
      expect(entry.from_terminal).toBe('librarian');
      expect(entry.priority).toBe('medium');
      expect(entry.success).toBe(true);
      expect(entry.timestamp).toBeDefined();
    });

    it('should log optional fields', async () => {
      const entry = await logWorkSessionRequest({
        from_terminal: 'backend',
        task_summary: 'Fix API bug',
        task_hash: 'hash123',
        priority: 'high',
        suggested_terminal: 'backend',
        conductor_inbox_file: '2026-06-29_work-req-123.md',
        success: true,
      });

      expect(entry.suggested_terminal).toBe('backend');
      expect(entry.conductor_inbox_file).toBe('2026-06-29_work-req-123.md');
    });

    it('should log failures with error message', async () => {
      const entry = await logWorkSessionRequest({
        from_terminal: 'frontend',
        task_summary: 'Update UI',
        task_hash: 'hashxyz',
        priority: 'low',
        success: false,
        error: 'Conductor inbox not writable',
      });

      expect(entry.success).toBe(false);
      expect(entry.error).toBe('Conductor inbox not writable');
    });
  });

  describe('logWorkSessionSpawn', () => {
    it('should log spawn and return full entry', async () => {
      const entry = await logWorkSessionSpawn({
        terminal: 'backend',
        session_name: 'spaceos-backend',
        model: 'sonnet',
        task_summary: 'Implement feature X',
        task_hash: 'hash456',
        spawned_by: 'conductor',
        success: true,
      });

      expect(entry.spawn_id).toMatch(/^WORK-SPAWN-/);
      expect(entry.terminal).toBe('backend');
      expect(entry.model).toBe('sonnet');
      expect(entry.spawned_by).toBe('conductor');
      expect(entry.success).toBe(true);
    });

    it('should link to request_id when provided', async () => {
      const entry = await logWorkSessionSpawn({
        terminal: 'frontend',
        session_name: 'spaceos-frontend',
        model: 'sonnet',
        task_summary: 'Build UI component',
        task_hash: 'hash789',
        spawned_by: 'conductor',
        request_id: 'WORK-REQ-2026-06-29-123456-001',
        success: true,
      });

      expect(entry.request_id).toBe('WORK-REQ-2026-06-29-123456-001');
    });
  });

  describe('queryWorkRequests', () => {
    it('should return empty array when no logs exist', async () => {
      const results = await queryWorkRequests();
      expect(results).toEqual([]);
    });

    it('should filter by from_terminal', async () => {
      await logWorkSessionRequest({
        from_terminal: 'librarian',
        task_summary: 'Task 1',
        task_hash: 'h1',
        priority: 'low',
        success: true,
      });
      await logWorkSessionRequest({
        from_terminal: 'backend',
        task_summary: 'Task 2',
        task_hash: 'h2',
        priority: 'low',
        success: true,
      });

      const results = await queryWorkRequests({ from_terminal: 'librarian' });
      expect(results).toHaveLength(1);
      expect(results[0].from_terminal).toBe('librarian');
    });
  });

  describe('queryWorkSpawns', () => {
    it('should return empty array when no logs exist', async () => {
      const results = await queryWorkSpawns();
      expect(results).toEqual([]);
    });

    it('should filter by terminal', async () => {
      await logWorkSessionSpawn({
        terminal: 'backend',
        session_name: 'spaceos-backend',
        model: 'sonnet',
        task_summary: 'Task A',
        task_hash: 'ha',
        spawned_by: 'conductor',
        success: true,
      });
      await logWorkSessionSpawn({
        terminal: 'frontend',
        session_name: 'spaceos-frontend',
        model: 'sonnet',
        task_summary: 'Task B',
        task_hash: 'hb',
        spawned_by: 'conductor',
        success: true,
      });

      const results = await queryWorkSpawns({ terminal: 'backend' });
      expect(results).toHaveLength(1);
      expect(results[0].terminal).toBe('backend');
    });

    it('should filter by spawned_by', async () => {
      await logWorkSessionSpawn({
        terminal: 'backend',
        session_name: 'spaceos-backend',
        model: 'sonnet',
        task_summary: 'Task A',
        task_hash: 'ha',
        spawned_by: 'conductor',
        success: true,
      });
      await logWorkSessionSpawn({
        terminal: 'frontend',
        session_name: 'spaceos-frontend',
        model: 'opus',
        task_summary: 'Task B',
        task_hash: 'hb',
        spawned_by: 'root',
        success: true,
      });

      const results = await queryWorkSpawns({ spawned_by: 'root' });
      expect(results).toHaveLength(1);
      expect(results[0].spawned_by).toBe('root');
    });
  });

  describe('getWorkSessionStats', () => {
    it('should return zero stats when no logs exist', async () => {
      const stats = await getWorkSessionStats();
      expect(stats.total_requests).toBe(0);
      expect(stats.total_spawns).toBe(0);
      expect(stats.success_rate).toBe(1); // No failures = 100%
    });

    it('should calculate correct statistics', async () => {
      // Log some requests
      await logWorkSessionRequest({
        from_terminal: 'librarian',
        task_summary: 'Task 1',
        task_hash: 'h1',
        priority: 'medium',
        success: true,
      });
      await logWorkSessionRequest({
        from_terminal: 'backend',
        task_summary: 'Task 2',
        task_hash: 'h2',
        priority: 'high',
        success: false,
        error: 'Test error',
      });

      // Log some spawns
      await logWorkSessionSpawn({
        terminal: 'backend',
        session_name: 'spaceos-backend',
        model: 'sonnet',
        task_summary: 'Task A',
        task_hash: 'ha',
        spawned_by: 'conductor',
        success: true,
      });

      const stats = await getWorkSessionStats();
      expect(stats.total_requests).toBe(2);
      expect(stats.total_spawns).toBe(1);
      expect(stats.by_terminal.librarian.requests).toBe(1);
      expect(stats.by_terminal.backend.requests).toBe(1);
      expect(stats.by_terminal.backend.spawns).toBe(1);
      expect(stats.success_rate).toBeCloseTo(2 / 3); // 2 success out of 3
    });
  });
});
