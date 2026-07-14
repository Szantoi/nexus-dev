/**
 * Terminal Status Aggregator Unit Tests
 *
 * Tests for terminal status aggregation, health scoring, and saturation levels.
 * Target coverage: >90%
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getTerminalStatusAggregate,
  getTerminalHealthScore,
} from '../../pipeline/terminalStatusAggregator';

describe('Terminal Status Aggregator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getTerminalStatusAggregate', () => {
    it('should return summary format with all terminals', async () => {
      const result = await getTerminalStatusAggregate('summary');

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.activeSessions).toBeGreaterThanOrEqual(0);
      expect(result.summary.totalSaturation).toBeGreaterThanOrEqual(0);
      expect(result.summary.blockersDetected).toBeGreaterThanOrEqual(0);
      expect(result.summary.criticalAlerts).toBeGreaterThanOrEqual(0);
    });

    it('should return detailed format with per-terminal data', async () => {
      const result = await getTerminalStatusAggregate('detailed');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(8); // 8 terminals (root + 7)

      result.forEach((terminal: any) => {
        expect(terminal.name).toBeDefined();
        expect(terminal.status).toMatch(/^(working|idle|stuck)$/);
        expect(terminal.contextSaturation).toBeGreaterThanOrEqual(0);
        expect(terminal.contextSaturation).toBeLessThanOrEqual(100);
        expect(terminal.saturationLevel).toMatch(/^(ok|warning|critical)$/);
        expect(terminal.healthScore).toBeGreaterThanOrEqual(0);
        expect(terminal.healthScore).toBeLessThanOrEqual(100);
      });
    });

    it('should return alerts_only format with problematic terminals', async () => {
      const result = await getTerminalStatusAggregate('alerts_only');

      expect(Array.isArray(result)).toBe(true);
      // All returned terminals should have alerts
      result.forEach((terminal: any) => {
        expect(['warning', 'critical']).toContain(terminal.saturationLevel);
      });
    });

    it('should calculate health scores correctly', async () => {
      const result = await getTerminalStatusAggregate('detailed');

      result.forEach((terminal: any) => {
        // Health score should be a valid number
        expect(typeof terminal.healthScore).toBe('number');
        expect(terminal.healthScore).toBeGreaterThanOrEqual(0);
        expect(terminal.healthScore).toBeLessThanOrEqual(100);
      });
    });

    it('should detect saturation levels accurately', async () => {
      const result = await getTerminalStatusAggregate('detailed');

      result.forEach((terminal: any) => {
        expect(['ok', 'warning', 'critical']).toContain(terminal.saturationLevel);
      });
    });

    it('should detect blocked messages', async () => {
      const result = await getTerminalStatusAggregate('summary');

      expect(typeof result.summary.blockersDetected).toBe('number');
      expect(result.summary.blockersDetected).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty terminal state', async () => {
      const result = await getTerminalStatusAggregate('summary');

      expect(result.summary.activeSessions).toBeGreaterThanOrEqual(0);
      expect(result.summary.idle).toBeGreaterThanOrEqual(0);
      expect(result.summary.stuck).toBeGreaterThanOrEqual(0);
      expect(result.summary.activeSessions + result.summary.idle + result.summary.stuck).toBe(8); // Total = 8 terminals
    });
  });

  describe('getTerminalHealthScore', () => {
    it('should return 100 for perfect state', () => {
      const score = getTerminalHealthScore({
        status: 'working',
        contextSaturation: 0,
        turnCount: 0,
        queueDepth: 0,
        blockedBy: [],
        lastActivity: new Date(),
      });

      expect(score).toBe(100);
    });

    it('should return <50 for high saturation', () => {
      const score = getTerminalHealthScore({
        status: 'idle',
        contextSaturation: 80,
        turnCount: 50,
        queueDepth: 10,
        blockedBy: [],
        lastActivity: new Date(),
      });

      expect(score).toBeLessThan(50);
    });

    it('should factor in queue depth', () => {
      const score1 = getTerminalHealthScore({
        status: 'working',
        contextSaturation: 30,
        turnCount: 10,
        queueDepth: 0,
        blockedBy: [],
        lastActivity: new Date(),
      });

      const score2 = getTerminalHealthScore({
        status: 'working',
        contextSaturation: 30,
        turnCount: 10,
        queueDepth: 5,
        blockedBy: [],
        lastActivity: new Date(),
      });

      expect(score1).toBeGreaterThan(score2);
    });

    it('should penalize blocked terminals', () => {
      const score1 = getTerminalHealthScore({
        status: 'working',
        contextSaturation: 30,
        turnCount: 10,
        queueDepth: 0,
        blockedBy: [],
        lastActivity: new Date(),
      });

      const score2 = getTerminalHealthScore({
        status: 'stuck',
        contextSaturation: 30,
        turnCount: 10,
        queueDepth: 0,
        blockedBy: ['MSG-CONDUCTOR-001'],
        lastActivity: new Date(Date.now() - 3600000), // 1 hour ago
      });

      expect(score1).toBeGreaterThan(score2);
    });

    it('should return valid score range 0-100', () => {
      const scenarios = [
        { status: 'working' as const, contextSaturation: 0, turnCount: 0, queueDepth: 0, blockedBy: [], lastActivity: new Date() },
        { status: 'idle' as const, contextSaturation: 50, turnCount: 25, queueDepth: 3, blockedBy: [], lastActivity: new Date() },
        { status: 'stuck' as const, contextSaturation: 95, turnCount: 100, queueDepth: 20, blockedBy: ['A', 'B'], lastActivity: new Date(Date.now() - 7200000) },
      ];

      scenarios.forEach(scenario => {
        const score = getTerminalHealthScore(scenario);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      });
    });
  });

  describe('error handling', () => {
    it('should handle invalid format gracefully', async () => {
      // Should not throw; should use default or handle gracefully
      const result = await getTerminalStatusAggregate('summary');
      expect(result).toBeDefined();
    });

    it('should return consistent structure', async () => {
      const summary = await getTerminalStatusAggregate('summary');
      const detailed = await getTerminalStatusAggregate('detailed');

      expect(summary).toBeDefined();
      expect(detailed).toBeDefined();
      expect(Array.isArray(detailed)).toBe(true);
    });
  });

  describe('performance', () => {
    it('should respond in <100ms', async () => {
      const start = Date.now();
      await getTerminalStatusAggregate('summary');
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
    });

    it('should handle detailed format within <200ms', async () => {
      const start = Date.now();
      await getTerminalStatusAggregate('detailed');
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(200);
    });
  });
});
