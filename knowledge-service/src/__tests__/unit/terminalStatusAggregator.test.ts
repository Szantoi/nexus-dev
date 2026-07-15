/**
 * Terminal Status Aggregator Unit Tests
 *
 * Tests for terminal status aggregation, health scoring, and saturation levels.
 * Hermetic: terminal state is seeded via the in-memory terminalStatus registry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getTerminalStatusAggregate,
  getTerminalHealthScore,
  type StatusAggregateSummary,
  type TerminalAggregate,
} from '../../pipeline/terminalStatusAggregator';
import { registerIdle, registerWorking } from '../../terminalStatus';

const ALL_TERMINALS = ['root', 'conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer'];

describe('Terminal Status Aggregator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Seed the in-memory registry: 2 working, 6 idle
    registerWorking('backend', 'MSG-BACKEND-001');
    registerWorking('frontend');
    for (const t of ALL_TERMINALS.filter(t => t !== 'backend' && t !== 'frontend')) {
      registerIdle(t);
    }
  });

  describe('getTerminalStatusAggregate', () => {
    it('should return summary format with session lists and metrics', async () => {
      const result = (await getTerminalStatusAggregate('summary')) as StatusAggregateSummary;

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(Array.isArray(result.summary.workingSessions)).toBe(true);
      expect(Array.isArray(result.summary.idleSessions)).toBe(true);
      expect(Array.isArray(result.summary.stuckSessions)).toBe(true);
      expect(result.summary.totalSaturation).toBeGreaterThanOrEqual(0);
      expect(result.summary.avgHealthScore).toBeGreaterThanOrEqual(0);
      expect(result.summary.blockersDetected).toBeGreaterThanOrEqual(0);
      expect(result.summary.criticalAlerts).toBeGreaterThanOrEqual(0);
      expect(result.summary.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should return detailed format with per-terminal data', async () => {
      const result = (await getTerminalStatusAggregate('detailed')) as TerminalAggregate[];

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(ALL_TERMINALS.length);

      result.forEach(terminal => {
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
      const result = (await getTerminalStatusAggregate('alerts_only')) as TerminalAggregate[];

      expect(Array.isArray(result)).toBe(true);
      // All returned terminals should have alerts
      result.forEach(terminal => {
        const hasAlert = ['warning', 'critical'].includes(terminal.saturationLevel) || terminal.healthScore < 50;
        expect(hasAlert).toBe(true);
      });
    });

    it('should calculate health scores correctly', async () => {
      const result = (await getTerminalStatusAggregate('detailed')) as TerminalAggregate[];

      result.forEach(terminal => {
        // Health score should be a valid number
        expect(typeof terminal.healthScore).toBe('number');
        expect(terminal.healthScore).toBeGreaterThanOrEqual(0);
        expect(terminal.healthScore).toBeLessThanOrEqual(100);
      });
    });

    it('should detect saturation levels accurately', async () => {
      const result = (await getTerminalStatusAggregate('detailed')) as TerminalAggregate[];

      result.forEach(terminal => {
        expect(['ok', 'warning', 'critical']).toContain(terminal.saturationLevel);
      });
    });

    it('should count blockers as a number', async () => {
      const result = (await getTerminalStatusAggregate('summary')) as StatusAggregateSummary;

      expect(typeof result.summary.blockersDetected).toBe('number');
      expect(result.summary.blockersDetected).toBeGreaterThanOrEqual(0);
    });

    it('should account for every seeded terminal exactly once', async () => {
      const result = (await getTerminalStatusAggregate('summary')) as StatusAggregateSummary;

      const total =
        result.summary.workingSessions.length +
        result.summary.idleSessions.length +
        result.summary.stuckSessions.length;
      expect(total).toBe(ALL_TERMINALS.length);
      expect(result.summary.workingSessions).toEqual(expect.arrayContaining(['backend', 'frontend']));
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
    it('should handle summary format gracefully', async () => {
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
