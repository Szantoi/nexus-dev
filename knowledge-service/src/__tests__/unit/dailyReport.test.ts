import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  generateDailyReport,
  saveDailyReportMarkdown,
  type DailyReport,
} from '../../task-audit/dailyReport';

/**
 * Daily Report Tests — Phase 3 Implementation
 *
 * Tests report generation, markdown saving, and metrics aggregation.
 */

// Mock dependencies
vi.mock('../../pipeline/common', () => ({
  telegram: vi.fn().mockResolvedValue(undefined),
  log: vi.fn().mockResolvedValue(undefined),
  SPACEOS_ROOT: '/tmp/spaceos-test',
}));

vi.mock('../../task-audit/taskCreation', () => ({
  getDailySummary: vi.fn().mockResolvedValue({
    date: '2026-06-23',
    total_tasks: 5,
    by_terminal: { backend: 3, frontend: 2 },
    by_priority: { high: 2, medium: 3 },
    by_creator: { conductor: 4, root: 1 },
  }),
  queryCreationLog: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../pipeline/reviewLog', () => ({
  queryReviewLog: vi.fn().mockResolvedValue([
    { timestamp: '2026-06-23T10:00:00Z', final_verdict: 'APPROVED', escalated: false },
    { timestamp: '2026-06-23T11:00:00Z', final_verdict: 'APPROVED', escalated: false },
    { timestamp: '2026-06-23T12:00:00Z', final_verdict: 'REJECTED', escalated: false },
    { timestamp: '2026-06-23T13:00:00Z', final_verdict: 'APPROVED', escalated: true },
  ]),
}));

describe('DailyReport', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Ensure test directory exists
    try {
      await fs.mkdir('/tmp/spaceos-test/docs/reports/daily', { recursive: true });
    } catch {
      // Directory may already exist
    }
  });

  afterEach(async () => {
    // Cleanup test files
    try {
      await fs.rm('/tmp/spaceos-test', { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('generateDailyReport', () => {
    it('should generate report for current date by default', async () => {
      const report = await generateDailyReport();

      expect(report.date).toBeDefined();
      expect(report.generated_at).toBeDefined();
      expect(report.tasks_created).toBeDefined();
      expect(report.reviews).toBeDefined();
      expect(report.highlights).toBeDefined();
    });

    it('should generate report for specific date', async () => {
      const report = await generateDailyReport('2026-06-23');

      expect(report.date).toBe('2026-06-23');
    });

    it('should aggregate task creation stats', async () => {
      const report = await generateDailyReport('2026-06-23');

      expect(report.tasks_created.total).toBe(5);
      expect(report.tasks_created.by_terminal.backend).toBe(3);
      expect(report.tasks_created.by_terminal.frontend).toBe(2);
    });

    it('should aggregate review stats', async () => {
      const report = await generateDailyReport('2026-06-23');

      expect(report.reviews.total).toBe(4);
      expect(report.reviews.approved).toBe(3);
      expect(report.reviews.rejected).toBe(1);
      expect(report.reviews.escalated).toBe(1);
    });

    it('should generate meaningful highlights', async () => {
      const report = await generateDailyReport('2026-06-23');

      expect(report.highlights.length).toBeGreaterThan(0);
      // Should include task count highlight
      expect(report.highlights.some(h => h.includes('task'))).toBe(true);
    });

    it('should include escalation warning in highlights', async () => {
      const report = await generateDailyReport('2026-06-23');

      // Should warn about escalations
      expect(report.highlights.some(h => h.includes('escalation'))).toBe(true);
    });

    it('should identify most active terminal', async () => {
      const report = await generateDailyReport('2026-06-23');

      // Backend had most tasks (3)
      expect(report.highlights.some(h => h.includes('backend'))).toBe(true);
    });
  });

  describe('saveDailyReportMarkdown', () => {
    it('should save markdown file with correct name', async () => {
      const report: DailyReport = {
        date: '2026-06-23',
        generated_at: '2026-06-23T15:00:00Z',
        tasks_created: {
          total: 5,
          by_terminal: { backend: 3, frontend: 2 },
          by_priority: { high: 2, medium: 3 },
          by_creator: { conductor: 4, root: 1 },
        },
        reviews: {
          total: 4,
          approved: 3,
          rejected: 1,
          escalated: 1,
          by_type: { formal: 1, content: 3, manual: 0 },
        },
        highlights: ['5 task(s) created via API'],
      };

      const filepath = await saveDailyReportMarkdown(report);

      expect(filepath).toContain('2026-06-23.md');

      // Verify file exists
      const content = await fs.readFile(filepath, 'utf-8');
      expect(content).toContain('# Daily Report: 2026-06-23');
    });

    it('should include all report sections', async () => {
      const report: DailyReport = {
        date: '2026-06-23',
        generated_at: '2026-06-23T15:00:00Z',
        tasks_created: {
          total: 5,
          by_terminal: { backend: 3 },
          by_priority: { high: 2 },
          by_creator: { conductor: 4 },
        },
        reviews: {
          total: 4,
          approved: 3,
          rejected: 1,
          escalated: 1,
          by_type: { formal: 1, content: 3, manual: 0 },
        },
        highlights: ['Test highlight'],
      };

      const filepath = await saveDailyReportMarkdown(report);
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).toContain('## Summary');
      expect(content).toContain('## Highlights');
      expect(content).toContain('## Tasks by Terminal');
      expect(content).toContain('## Tasks by Priority');
      expect(content).toContain('## Reviews by Type');
    });

    it('should create directory if not exists', async () => {
      // Remove directory first
      try {
        await fs.rm('/tmp/spaceos-test/docs/reports/daily', { recursive: true, force: true });
      } catch {
        // Ignore
      }

      const report: DailyReport = {
        date: '2026-06-24',
        generated_at: '2026-06-24T10:00:00Z',
        tasks_created: {
          total: 0,
          by_terminal: {},
          by_priority: {},
          by_creator: {},
        },
        reviews: {
          total: 0,
          approved: 0,
          rejected: 0,
          escalated: 0,
          by_type: { formal: 0, content: 0, manual: 0 },
        },
        highlights: [],
      };

      // Should not throw
      const filepath = await saveDailyReportMarkdown(report);
      expect(filepath).toContain('2026-06-24.md');
    });
  });

  describe('Report Structure', () => {
    it('should have all required fields', async () => {
      const report = await generateDailyReport('2026-06-23');

      // Top-level fields
      expect(report).toHaveProperty('date');
      expect(report).toHaveProperty('generated_at');
      expect(report).toHaveProperty('tasks_created');
      expect(report).toHaveProperty('reviews');
      expect(report).toHaveProperty('highlights');

      // Task creation fields
      expect(report.tasks_created).toHaveProperty('total');
      expect(report.tasks_created).toHaveProperty('by_terminal');
      expect(report.tasks_created).toHaveProperty('by_priority');
      expect(report.tasks_created).toHaveProperty('by_creator');

      // Review fields
      expect(report.reviews).toHaveProperty('total');
      expect(report.reviews).toHaveProperty('approved');
      expect(report.reviews).toHaveProperty('rejected');
      expect(report.reviews).toHaveProperty('escalated');
      expect(report.reviews).toHaveProperty('by_type');
    });

    it('should have ISO timestamp for generated_at', async () => {
      const report = await generateDailyReport();

      // Should be valid ISO date
      const parsed = new Date(report.generated_at);
      expect(parsed.toISOString()).toBe(report.generated_at);
    });

    it('should have YYYY-MM-DD format for date', async () => {
      const report = await generateDailyReport('2026-06-23');

      expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
