/**
 * Alert Rules Tests
 *
 * Tests for alert rule triggers:
 * - checkSessionStuck
 * - checkConsecutiveSkips
 * - checkBlockedTimeout
 * - checkNoActivity
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  checkSessionStuck,
  checkConsecutiveSkips,
  checkBlockedTimeout,
  checkNoActivity,
  checkMemoryOverflow,
  runAlertRules,
} from '../pipeline/alertRules';

// Mock dependencies
global.fetch = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      readdir: vi.fn(),
      mkdir: vi.fn(),
      appendFile: vi.fn(),
      stat: vi.fn(),
    },
  };
});

const mockedFetch = vi.mocked(global.fetch, true);
const mockedFs = vi.mocked(fs, true);

describe('Alert Rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock alert state file (empty state)
    mockedFs.readFile.mockRejectedValue(new Error('File not found'));
    mockedFs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkSessionStuck', () => {
    it('should return null when no sessions are stuck', async () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago

      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { terminal: 'backend', active: true, lastActivity: recent.toISOString() },
          { terminal: 'frontend', active: true, lastActivity: recent.toISOString() },
        ],
      } as Response);

      const result = await checkSessionStuck();
      expect(result).toBeNull();
    });

    it('should detect session stuck >30 min', async () => {
      const now = new Date();
      const stuckTime = new Date(now.getTime() - 35 * 60 * 1000); // 35 minutes ago

      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { terminal: 'backend', active: true, lastActivity: stuckTime.toISOString() },
        ],
      } as Response);

      // Mock state file for cooldown check
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify({ lastFired: {} }));
      mockedFs.writeFile.mockResolvedValue(undefined);

      const result = await checkSessionStuck();
      expect(result).toContain('🔴 [ALERT]');
      expect(result).toContain('backend');
      expect(result).toContain('stuck');
    });

    it('should respect cooldown period', async () => {
      const now = new Date();
      const stuckTime = new Date(now.getTime() - 35 * 60 * 1000);
      const recentAlert = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago

      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { terminal: 'backend', active: true, lastActivity: stuckTime.toISOString() },
        ],
      } as Response);

      // Mock state file - alert already fired recently
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          lastFired: {
            session_stuck_backend: recentAlert.toISOString(),
          },
        })
      );

      const result = await checkSessionStuck();
      expect(result).toBeNull(); // Should not fire due to cooldown
    });

    it('should handle API errors gracefully', async () => {
      mockedFetch.mockRejectedValue(new Error('API error'));

      const result = await checkSessionStuck();
      expect(result).toBeNull();
    });
  });

  describe('checkConsecutiveSkips', () => {
    it('should return null when autonomous dev is disabled', async () => {
      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: false }),
      } as Response);

      const result = await checkConsecutiveSkips();
      expect(result).toBeNull();
    });

    it('should detect 3+ consecutive skips', async () => {
      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      } as Response);

      // Mock log file with consecutive skips
      mockedFs.readFile.mockImplementation((filePath: any) => {
        if (filePath.includes('nightwatch.log')) {
          return Promise.resolve(
            '2026-06-22 10:00:00 [AutonomousDev] Cycle 1 skipped: too many tasks\n' +
            '2026-06-22 10:20:00 [AutonomousDev] Cycle 2 skipped: backend busy\n' +
            '2026-06-22 10:40:00 [AutonomousDev] Cycle 3 skipped: frontend busy\n'
          );
        }
        // Alert state file
        return Promise.resolve(JSON.stringify({ lastFired: {} }));
      });

      const result = await checkConsecutiveSkips();
      expect(result).toContain('⚠️ [WARNING]');
      expect(result).toContain('skip');
    });

    it('should not trigger on non-consecutive skips', async () => {
      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      } as Response);

      mockedFs.readFile.mockImplementation((filePath: any) => {
        if (filePath.includes('nightwatch.log')) {
          return Promise.resolve(
            '2026-06-22 10:00:00 [AutonomousDev] Cycle 1 skipped: too many tasks\n' +
            '2026-06-22 10:20:00 [AutonomousDev] Cycle 2 dispatched: backend\n' +
            '2026-06-22 10:40:00 [AutonomousDev] Cycle 3 skipped: frontend busy\n'
          );
        }
        return Promise.resolve(JSON.stringify({ lastFired: {} }));
      });

      const result = await checkConsecutiveSkips();
      expect(result).toBeNull();
    });
  });

  describe('checkBlockedTimeout', () => {
    it('should return null when no blocked tasks', async () => {
      mockedFs.readdir.mockImplementation((dirPath: any) => {
        if (dirPath.includes('terminals')) {
          return Promise.resolve(['backend', 'frontend']);
        }
        // Outbox directories
        return Promise.resolve([]);
      });

      const result = await checkBlockedTimeout();
      expect(result).toBeNull();
    });

    it('should detect blocked task >2h', async () => {
      const now = new Date();
      const blockedDate = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 hours ago

      mockedFs.readdir.mockImplementation((dirPath: any) => {
        if (typeof dirPath === 'string' && dirPath.endsWith('/terminals')) {
          return Promise.resolve(['backend']);
        }
        if (typeof dirPath === 'string' && dirPath.includes('outbox')) {
          return Promise.resolve(['2026-06-22_001_task-blocked.md']);
        }
        return Promise.resolve([]);
      });

      mockedFs.readFile.mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('task-blocked.md')) {
          return Promise.resolve(
            `---
id: MSG-BACKEND-001
from: backend
to: conductor
type: blocked
status: UNREAD
created: ${blockedDate.toISOString().split('T')[0]}
---

Task is blocked.`
          );
        }
        // Alert state file
        return Promise.reject(new Error('File not found'));
      });

      // Separate mock for writeFile (alert state persistence)
      mockedFs.writeFile.mockResolvedValue(undefined);

      const result = await checkBlockedTimeout();
      expect(result).toContain('🟡 [ESCALATION]');
      expect(result).toContain('blocked');
    });

    it('should ignore non-blocked or READ messages', async () => {
      mockedFs.readdir.mockImplementation((dirPath: any) => {
        if (dirPath.includes('terminals')) {
          return Promise.resolve(['backend']);
        }
        return Promise.resolve(['2026-06-22_001_task-done.md']);
      });

      mockedFs.readFile.mockImplementation((filePath: any) => {
        if (filePath.includes('task-done.md')) {
          return Promise.resolve(
            `---
id: MSG-BACKEND-001
from: backend
to: conductor
type: done
status: READ
created: 2026-06-22
---

Task completed.`
          );
        }
        return Promise.resolve(JSON.stringify({ lastFired: {} }));
      });

      const result = await checkBlockedTimeout();
      expect(result).toBeNull();
    });
  });

  describe('checkNoActivity', () => {
    it('should return null when recent activity exists', async () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 30 * 60 * 1000); // 30 minutes ago

      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { terminal: 'backend', lastActivity: recent.toISOString() },
          { terminal: 'frontend', lastActivity: recent.toISOString() },
        ],
      } as Response);

      const result = await checkNoActivity();
      expect(result).toBeNull();
    });

    it('should detect no activity >2h', async () => {
      const now = new Date();
      const oldActivity = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 hours ago

      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { terminal: 'backend', lastActivity: oldActivity.toISOString() },
          { terminal: 'frontend', lastActivity: oldActivity.toISOString() },
        ],
      } as Response);

      // Mock state file
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ lastFired: {} }));

      const result = await checkNoActivity();
      expect(result).toContain('ℹ️ [INFO]');
      expect(result).toContain('Nincs aktív fejlesztés');
    });

    it('should handle empty sessions gracefully', async () => {
      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      const result = await checkNoActivity();
      expect(result).toBeNull();
    });
  });

  describe('checkMemoryOverflow', () => {
    it('should return null when all terminals are within threshold', async () => {
      // Mock stat to return small file sizes
      mockedFs.stat.mockResolvedValue({
        size: 20 * 1024, // 20KB (below all thresholds)
      } as any);

      const result = await checkMemoryOverflow();
      expect(result).toBeNull();
    });

    it('should detect WARNING for memory >threshold but <2×threshold', async () => {
      mockedFs.stat.mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('monitor/MEMORY.md')) {
          // 40KB - above 35KB threshold but below 70KB (2×threshold)
          return Promise.resolve({ size: 40 * 1024 } as any);
        }
        // Other terminals are fine
        return Promise.resolve({ size: 20 * 1024 } as any);
      });

      // Mock state file for cooldown check
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ lastFired: {} }));

      const result = await checkMemoryOverflow();
      expect(result).toContain('🟡 [WARNING]');
      expect(result).toContain('monitor');
      expect(result).toContain('40KB');
    });

    it('should detect CRITICAL for memory >2×threshold', async () => {
      mockedFs.stat.mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('monitor/MEMORY.md')) {
          // 150KB - above 2× threshold (70KB)
          return Promise.resolve({ size: 150 * 1024 } as any);
        }
        if (typeof filePath === 'string' && filePath.includes('conductor/MEMORY.md')) {
          // 120KB - above 2× threshold (100KB)
          return Promise.resolve({ size: 120 * 1024 } as any);
        }
        return Promise.resolve({ size: 20 * 1024 } as any);
      });

      mockedFs.readFile.mockResolvedValue(JSON.stringify({ lastFired: {} }));

      const result = await checkMemoryOverflow();
      expect(result).toContain('🔴 [CRITICAL]');
      expect(result).toContain('Memory overflow');
    });

    it('should respect daily cooldown period', async () => {
      const now = new Date();
      const recentAlert = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12 hours ago

      mockedFs.stat.mockResolvedValue({ size: 150 * 1024 } as any);

      // Mock state file - alert already fired <24h ago
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({
          lastFired: {
            memory_overflow: recentAlert.toISOString(),
          },
        })
      );

      const result = await checkMemoryOverflow();
      expect(result).toBeNull(); // Should not fire due to cooldown
    });

    it('should handle missing MEMORY.md files gracefully', async () => {
      // Mock some terminals with no MEMORY.md
      mockedFs.stat.mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('designer/MEMORY.md')) {
          return Promise.reject(new Error('File not found'));
        }
        return Promise.resolve({ size: 20 * 1024 } as any);
      });

      const result = await checkMemoryOverflow();
      expect(result).toBeNull(); // Should not crash
    });

    it('should use correct thresholds for different terminal types', async () => {
      mockedFs.stat.mockImplementation((filePath: any) => {
        const fileName = typeof filePath === 'string' ? filePath : '';

        // conductor/root/backend: threshold 50KB
        if (fileName.includes('conductor') || fileName.includes('root/MEMORY.md') || fileName.includes('backend')) {
          return Promise.resolve({ size: 55 * 1024 } as any); // Above 50KB
        }

        // Others: threshold 35KB
        return Promise.resolve({ size: 20 * 1024 } as any);
      });

      mockedFs.readFile.mockResolvedValue(JSON.stringify({ lastFired: {} }));

      const result = await checkMemoryOverflow();
      expect(result).toContain('🟡 [WARNING]');
      expect(result).toContain('55KB');
    });
  });

  describe('runAlertRules', () => {
    it('should run all alert checks', async () => {
      // Mock all checks to return null
      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);
      mockedFs.readdir.mockResolvedValue([]);
      mockedFs.stat.mockResolvedValue({ size: 20 * 1024 } as any);

      await runAlertRules();

      // Verify fetch was called (for session checks)
      expect(mockedFetch).toHaveBeenCalled();
    });

    it('should handle errors in individual checks gracefully', async () => {
      // Mock one check to fail
      mockedFetch.mockRejectedValueOnce(new Error('API error'));
      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);
      mockedFs.stat.mockResolvedValue({ size: 20 * 1024 } as any);

      // Should not throw
      await expect(runAlertRules()).resolves.not.toThrow();
    });
  });
});
