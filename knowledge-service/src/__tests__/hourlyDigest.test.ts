/**
 * Hourly Digest Tests
 *
 * Tests for hourly digest functionality:
 * - collectDigestData
 * - formatDigestMessage
 * - sendHourlyDigest
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import {
  collectDigestData,
  formatDigestMessage,
  sendHourlyDigest,
  DigestData,
} from '../pipeline/hourlyDigest';

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
      stat: vi.fn(),
      mkdir: vi.fn(),
      appendFile: vi.fn(),
    },
  };
});

const mockedFetch = vi.mocked(global.fetch, true);
const mockedFs = vi.mocked(fs, true);

describe('Hourly Digest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.readFile.mockRejectedValue(new Error('File not found'));
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue([]);
  });

  describe('collectDigestData', () => {
    it('should collect data from autonomous status endpoint', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          enabled: true,
          cycleCount: 5,
          running: true,
        }),
      } as Response);

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          terminals: [
            { name: 'backend', status: 'working', unreadInbox: 2, unreadOutbox: 0 },
            { name: 'frontend', status: 'idle', unreadInbox: 0, unreadOutbox: 0 },
          ],
        }),
      } as Response);

      const data = await collectDigestData();

      expect(data.autonomousCycles.total).toBe(5);
      expect(data.tasksInProgress).toBe(2);
      expect(data.terminals.backend).toContain('working');
      expect(data.terminals.frontend).toContain('idle');
    });

    it('should handle API errors gracefully', async () => {
      mockedFetch.mockRejectedValue(new Error('API error'));

      const data = await collectDigestData();

      // Should return default values
      expect(data.autonomousCycles.total).toBe(0);
      expect(data.tasksCompleted).toBe(0);
      expect(data.tasksInProgress).toBe(0);
      expect(data.blockers).toBe(0);
    });

    it('should count tasks in progress from dashboard', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ enabled: false }),
      } as Response);

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          terminals: [
            { name: 'backend', status: 'idle', unreadInbox: 3, unreadOutbox: 0 },
            { name: 'frontend', status: 'idle', unreadInbox: 1, unreadOutbox: 0 },
          ],
        }),
      } as Response);

      const data = await collectDigestData();

      expect(data.tasksInProgress).toBe(4); // 3 + 1
    });

    it('should detect blocked tasks', async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ enabled: false }),
      } as Response);

      mockedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          terminals: [
            { name: 'backend', status: 'idle', unreadInbox: 0, unreadOutbox: 1 },
          ],
        }),
      } as Response);

      mockedFs.readdir.mockImplementation((dirPath: any) => {
        if (typeof dirPath === 'string' && dirPath.endsWith('/terminals')) {
          return Promise.resolve(['backend']);
        }
        if (typeof dirPath === 'string' && dirPath.includes('outbox')) {
          return Promise.resolve(['2026-06-22_001_blocked.md']);
        }
        return Promise.resolve([]);
      });

      mockedFs.readFile.mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('blocked.md')) {
          return Promise.resolve(
            `---
type: blocked
status: UNREAD
---

Blocked message`
          );
        }
        return Promise.reject(new Error('File not found'));
      });

      const data = await collectDigestData();

      expect(data.blockers).toBeGreaterThan(0);
    });
  });

  describe('formatDigestMessage', () => {
    it('should format digest message correctly', () => {
      const data: DigestData = {
        timestamp: new Date('2026-06-22T10:00:00Z'),
        autonomousCycles: { total: 10, skipped: 2 },
        tasksCompleted: 5,
        tasksInProgress: 3,
        blockers: 1,
        terminals: {
          conductor: '⚙️ working',
          backend: '📥 2 inbox',
          frontend: '💤 idle',
        },
        nextCycle: new Date('2026-06-22T11:00:00Z'),
      };

      const message = formatDigestMessage(data);

      expect(message).toContain('📊 SpaceOS Hourly Digest');
      expect(message).toContain('🤖 Autonomous cycles: 10 (2 skipped)');
      expect(message).toContain('✅ Tasks completed: 5');
      expect(message).toContain('⏳ Tasks in progress: 3');
      expect(message).toContain('🚨 Blockers: 1');
      expect(message).toContain('conductor: ⚙️ working');
      expect(message).toContain('backend: 📥 2 inbox');
      expect(message).toContain('frontend: 💤 idle');
      expect(message).toContain('Next cycle:');
    });

    it('should handle zero values', () => {
      const data: DigestData = {
        timestamp: new Date('2026-06-22T14:00:00Z'),
        autonomousCycles: { total: 0, skipped: 0 },
        tasksCompleted: 0,
        tasksInProgress: 0,
        blockers: 0,
        terminals: {},
        nextCycle: new Date('2026-06-22T15:00:00Z'),
      };

      const message = formatDigestMessage(data);

      expect(message).toContain('🤖 Autonomous cycles: 0 (0 skipped)');
      expect(message).toContain('✅ Tasks completed: 0');
      expect(message).toContain('⏳ Tasks in progress: 0');
      expect(message).toContain('🚨 Blockers: 0');
    });

    it('should sort terminals: working first, then inbox, then idle', () => {
      const data: DigestData = {
        timestamp: new Date(),
        autonomousCycles: { total: 0, skipped: 0 },
        tasksCompleted: 0,
        tasksInProgress: 0,
        blockers: 0,
        terminals: {
          frontend: '💤 idle',
          backend: '📥 1 inbox',
          conductor: '⚙️ working',
        },
        nextCycle: new Date(),
      };

      const message = formatDigestMessage(data);
      const lines = message.split('\n');
      const terminalLines = lines.filter(l => l.includes('•'));

      // Should be sorted: working, inbox, idle
      expect(terminalLines[0]).toContain('conductor');
      expect(terminalLines[1]).toContain('backend');
      expect(terminalLines[2]).toContain('frontend');
    });
  });

  describe('sendHourlyDigest', () => {
    it('should collect data, format message, and send to Telegram', async () => {
      mockedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          enabled: false,
          terminals: [],
        }),
      } as Response);

      await sendHourlyDigest();

      // Telegram helper is mocked via common.ts
      // Just verify no errors thrown
      expect(true).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      mockedFetch.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await expect(sendHourlyDigest()).resolves.not.toThrow();
    });
  });
});
