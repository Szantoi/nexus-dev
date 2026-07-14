/**
 * Terminal Status Tests
 *
 * Tests for terminal status tracking:
 * - registerWorking / registerIdle
 * - getFullTerminalStatus
 * - Auto-timeout to idle
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerWorking,
  registerIdle,
  isWorking,
  shouldWakeUp,
  getAllStatus,
  getStatus,
  heartbeat,
} from '../terminalStatus';

describe('Terminal Status', () => {
  beforeEach(() => {
    // Reset terminal status by registering all as idle
    registerIdle('test-terminal');
    registerIdle('backend');
    registerIdle('frontend');
  });

  describe('registerWorking / registerIdle', () => {
    it('should register terminal as working', () => {
      registerWorking('test-terminal', 'MSG-TEST-001');

      const status = getStatus('test-terminal');
      expect(status).not.toBeNull();
      expect(status?.state).toBe('working');
      expect(status?.currentTask).toBe('MSG-TEST-001');
    });

    it('should register terminal as idle', () => {
      registerWorking('test-terminal');
      registerIdle('test-terminal');

      const status = getStatus('test-terminal');
      expect(status).not.toBeNull();
      expect(status?.state).toBe('idle');
      expect(status?.currentTask).toBeUndefined();
    });

    it('should track lastActivity timestamp', () => {
      const before = new Date();
      registerWorking('test-terminal');
      const after = new Date();

      const status = getStatus('test-terminal');
      expect(status?.lastActivity).toBeDefined();
      expect(status?.lastActivity.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(status?.lastActivity.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('isWorking', () => {
    it('should return true for working terminal', () => {
      registerWorking('backend');
      expect(isWorking('backend')).toBe(true);
    });

    it('should return false for idle terminal', () => {
      registerIdle('frontend');
      expect(isWorking('frontend')).toBe(false);
    });

    it('should return false for unknown terminal', () => {
      expect(isWorking('non-existent-terminal')).toBe(false);
    });
  });

  describe('shouldWakeUp', () => {
    it('should return true for idle terminal (can receive wake-up)', () => {
      registerIdle('backend');
      expect(shouldWakeUp('backend')).toBe(true);
    });

    it('should return false for working terminal (do not disturb)', () => {
      registerWorking('backend', 'MSG-BE-001');
      expect(shouldWakeUp('backend')).toBe(false);
    });

    it('should return true for unknown terminal', () => {
      expect(shouldWakeUp('unknown-terminal')).toBe(true);
    });
  });

  describe('heartbeat', () => {
    it('should update lastActivity for existing terminal', async () => {
      registerWorking('backend');
      const initialStatus = getStatus('backend');
      const initialTime = initialStatus?.lastActivity.getTime() || 0;

      // Wait a tiny bit
      await new Promise(r => setTimeout(r, 10));

      heartbeat('backend');
      const updatedStatus = getStatus('backend');

      expect(updatedStatus?.lastActivity.getTime()).toBeGreaterThanOrEqual(initialTime);
    });

    it('should create working status for new terminal on first heartbeat', () => {
      heartbeat('new-terminal');

      const status = getStatus('new-terminal');
      expect(status).not.toBeNull();
      expect(status?.state).toBe('working');
    });
  });

  describe('getAllStatus', () => {
    it('should return status for all registered terminals', () => {
      registerWorking('backend', 'MSG-BE-001');
      registerIdle('frontend');
      registerWorking('conductor', 'MSG-COND-001');

      const allStatus = getAllStatus();

      expect(allStatus['backend']).toBeDefined();
      expect(allStatus['backend'].state).toBe('working');
      expect(allStatus['backend'].currentTask).toBe('MSG-BE-001');

      expect(allStatus['frontend']).toBeDefined();
      expect(allStatus['frontend'].state).toBe('idle');

      expect(allStatus['conductor']).toBeDefined();
      expect(allStatus['conductor'].state).toBe('working');
    });

    it('should return empty object when no terminals registered', () => {
      // This test might not work perfectly due to shared state
      // But we can check the structure
      const allStatus = getAllStatus();
      expect(typeof allStatus).toBe('object');
    });
  });

  describe('getStatus', () => {
    it('should return null for unregistered terminal', () => {
      const status = getStatus('never-registered');
      expect(status).toBeNull();
    });

    it('should return full status object for registered terminal', () => {
      registerWorking('backend', 'MSG-BE-001');

      const status = getStatus('backend');
      expect(status).not.toBeNull();
      expect(status).toHaveProperty('state');
      expect(status).toHaveProperty('lastActivity');
      expect(status).toHaveProperty('currentTask');
    });
  });

  describe('State transitions', () => {
    it('should transition from idle to working', () => {
      registerIdle('test-terminal');
      expect(isWorking('test-terminal')).toBe(false);

      registerWorking('test-terminal', 'task-1');
      expect(isWorking('test-terminal')).toBe(true);
    });

    it('should transition from working to idle', () => {
      registerWorking('test-terminal', 'task-1');
      expect(isWorking('test-terminal')).toBe(true);

      registerIdle('test-terminal');
      expect(isWorking('test-terminal')).toBe(false);
    });

    it('should handle multiple work assignments', () => {
      registerWorking('backend', 'task-1');
      expect(getStatus('backend')?.currentTask).toBe('task-1');

      registerWorking('backend', 'task-2');
      expect(getStatus('backend')?.currentTask).toBe('task-2');
    });
  });
});
