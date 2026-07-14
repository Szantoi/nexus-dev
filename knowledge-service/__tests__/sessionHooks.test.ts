/**
 * Session Hooks Integration Tests (ADR-046 Track B)
 *
 * Tests for session lifecycle hooks:
 * - buildStartContext()
 * - handleSessionEnd()
 * - session_history table
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Set test DB path BEFORE importing the modules (env must be set before module load)
const TEST_DB_DIR = path.join(os.tmpdir(), 'spaceos-sessionhooks-test-' + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'session-test.db');

// Set env before importing modules
process.env.MEMORY_DATA_DIR = TEST_DB_DIR;
process.env.MEMORY_DB_PATH = TEST_DB_PATH;

// Import types statically
import type { SessionStartContext, SessionEndContext } from '../src/sessionHooks';

// Dynamic imports for runtime values
let buildStartContext: typeof import('../src/sessionHooks').buildStartContext;
let handleSessionEnd: typeof import('../src/sessionHooks').handleSessionEnd;
let closeSessionHooks: typeof import('../src/sessionHooks').closeSessionHooks;
let saveTieredMemory: typeof import('../src/pipeline/memoryStore').saveTieredMemory;
let closeMemoryStore: typeof import('../src/pipeline/memoryStore').closeMemoryStore;

describe('Session Hooks — Integration Tests (ADR-046)', () => {
  beforeAll(async () => {
    // Create test directory
    await fs.mkdir(TEST_DB_DIR, { recursive: true });

    // Import modules after env is set
    const sessionHooks = await import('../src/sessionHooks');
    buildStartContext = sessionHooks.buildStartContext;
    handleSessionEnd = sessionHooks.handleSessionEnd;
    closeSessionHooks = sessionHooks.closeSessionHooks;

    const memoryStore = await import('../src/pipeline/memoryStore');
    saveTieredMemory = memoryStore.saveTieredMemory;
    closeMemoryStore = memoryStore.closeMemoryStore;
  });

  beforeEach(async () => {
    // Close any existing connections and clean up test database
    closeMemoryStore?.();
    closeSessionHooks?.();
    try {
      await fs.unlink(TEST_DB_PATH);
      await fs.unlink(TEST_DB_PATH + '-wal').catch(() => {});
      await fs.unlink(TEST_DB_PATH + '-shm').catch(() => {});
    } catch {
      // Ignore if file doesn't exist
    }
  });

  afterEach(() => {
    closeMemoryStore?.();
    closeSessionHooks?.();
  });

  afterAll(async () => {
    // Cleanup test directory
    try {
      await fs.rm(TEST_DB_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('buildStartContext', () => {
    beforeEach(async () => {
      // Seed test memories
      await saveTieredMemory({
        tier: 'hot',
        type: 'semantic',
        source: 'manual',
        content: 'Hot memory for backend terminal',
        terminal: 'backend',
        salience: 0.9,
      });

      await saveTieredMemory({
        tier: 'hot',
        type: 'episodic',
        source: 'digest',
        content: 'Another hot memory',
        terminal: 'backend',
        salience: 0.85,
      });

      await saveTieredMemory({
        tier: 'warm',
        type: 'procedural',
        source: 'skill',
        content: 'Warm memory for backend',
        terminal: 'backend',
        salience: 0.6,
      });

      await saveTieredMemory({
        tier: 'shared',
        type: 'semantic',
        source: 'document',
        content: 'Shared memory across all terminals',
        salience: 0.8,
      });

      // Memory for different terminal (should not be loaded)
      await saveTieredMemory({
        tier: 'hot',
        type: 'semantic',
        source: 'manual',
        content: 'Hot memory for frontend (should not appear)',
        terminal: 'frontend',
        salience: 0.9,
      });
    });

    it('should load hot + warm + shared memories for terminal', async () => {
      const ctx: SessionStartContext = {
        terminal: 'backend',
        taskId: 'MSG-BACKEND-007',
        inboxMessageId: '2026-06-21_007_adr046-track-a-memory-tier.md',
      };

      const result = await buildStartContext(ctx);

      expect(result.memoriesLoaded).toBe(4); // 2 hot + 1 warm + 1 shared
      expect(result.hotMemories.length).toBe(2);
      expect(result.warmMemories.length).toBe(1);
      expect(result.sharedMemories.length).toBe(1);
    });

    it('should generate markdown context', async () => {
      const ctx: SessionStartContext = {
        terminal: 'backend',
        inboxMessageId: '2026-06-21_007_adr046-track-a.md',
      };

      const result = await buildStartContext(ctx);

      expect(result.contextMarkdown).toBeTruthy();
      expect(result.contextMarkdown).toContain('# Session Context');
      expect(result.contextMarkdown).toContain('**Terminal:** backend');
      expect(result.contextMarkdown).toContain('🔥 Hot Memories');
      expect(result.contextMarkdown).toContain('Hot memory for backend terminal');
      expect(result.contextMarkdown).toContain('🌍 Shared Memories');
    });

    it('should estimate context tokens', async () => {
      const ctx: SessionStartContext = {
        terminal: 'backend',
      };

      const result = await buildStartContext(ctx);

      expect(result.contextTokens).toBeGreaterThan(0);
      expect(result.contextTokens).toBeLessThan(5000); // Should be under 5K tokens
    });

    it('should not load memories from other terminals', async () => {
      const ctx: SessionStartContext = {
        terminal: 'backend',
      };

      const result = await buildStartContext(ctx);

      // Should NOT contain frontend memory
      const allContent = result.contextMarkdown;
      expect(allContent).not.toContain('frontend');
      expect(allContent).not.toContain('should not appear');
    });

    it('should handle terminal with no memories', async () => {
      const ctx: SessionStartContext = {
        terminal: 'librarian', // No memories for this terminal
      };

      const result = await buildStartContext(ctx);

      // Should only get shared memories
      expect(result.memoriesLoaded).toBe(1); // Only shared memory
      expect(result.hotMemories.length).toBe(0);
      expect(result.warmMemories.length).toBe(0);
      expect(result.sharedMemories.length).toBe(1);
    });
  });

  describe('handleSessionEnd', () => {
    it('should save session history', async () => {
      const ctx: SessionEndContext = {
        terminal: 'backend',
        endReason: 'done',
        taskId: 'MSG-BACKEND-007',
        summary: 'Implemented memory tier management',
        hadCorrections: false,
        toolCallCount: 15,
      };

      const result = await handleSessionEnd(ctx);

      expect(result.sessionId).toBeGreaterThan(0);
      expect(result.memoriesSaved).toBe(1); // Summary saved as hot memory
    });

    it('should auto-save summary as hot memory', async () => {
      const ctx: SessionEndContext = {
        terminal: 'frontend',
        endReason: 'done',
        taskId: 'MSG-FRONTEND-001',
        summary: 'Fixed login bug',
        hadCorrections: false,
        toolCallCount: 5,
      };

      const result = await handleSessionEnd(ctx);

      expect(result.memoriesSaved).toBe(1);
    });

    it('should NOT save memory if no summary', async () => {
      const ctx: SessionEndContext = {
        terminal: 'backend',
        endReason: 'timeout',
        hadCorrections: false,
        toolCallCount: 0,
      };

      const result = await handleSessionEnd(ctx);

      expect(result.memoriesSaved).toBe(0);
    });

    it('should trigger retrospective if had corrections', async () => {
      const ctx: SessionEndContext = {
        terminal: 'backend',
        endReason: 'done',
        taskId: 'MSG-BACKEND-007',
        summary: 'Task completed with fixes',
        hadCorrections: true,
        toolCallCount: 8,
      };

      const result = await handleSessionEnd(ctx);

      expect(result.retrospectiveTriggered).toBe(true);
    });

    it('should trigger retrospective if many tool calls', async () => {
      const ctx: SessionEndContext = {
        terminal: 'backend',
        endReason: 'done',
        taskId: 'MSG-BACKEND-007',
        summary: 'Complex task completed',
        hadCorrections: false,
        toolCallCount: 25,
      };

      const result = await handleSessionEnd(ctx);

      expect(result.retrospectiveTriggered).toBe(true);
    });

    it('should NOT trigger retrospective for simple tasks', async () => {
      const ctx: SessionEndContext = {
        terminal: 'backend',
        endReason: 'done',
        taskId: 'MSG-BACKEND-001',
        summary: 'Simple fix',
        hadCorrections: false,
        toolCallCount: 3,
      };

      const result = await handleSessionEnd(ctx);

      expect(result.retrospectiveTriggered).toBe(false);
    });
  });

  describe('session_history table', () => {
    it('should create session_history table', async () => {
      // Trigger ensureSessionHistoryTable by calling handleSessionEnd
      await handleSessionEnd({
        terminal: 'backend',
        endReason: 'done',
        hadCorrections: false,
        toolCallCount: 0,
      });

      // If no error thrown, table was created successfully
      expect(true).toBe(true);
    });

    it('should store multiple sessions', async () => {
      const ctx1: SessionEndContext = {
        terminal: 'backend',
        endReason: 'done',
        taskId: 'TASK-001',
        hadCorrections: false,
        toolCallCount: 5,
      };

      const ctx2: SessionEndContext = {
        terminal: 'frontend',
        endReason: 'blocked',
        taskId: 'TASK-002',
        hadCorrections: true,
        toolCallCount: 10,
      };

      const result1 = await handleSessionEnd(ctx1);
      const result2 = await handleSessionEnd(ctx2);

      expect(result1.sessionId).toBeGreaterThan(0);
      expect(result2.sessionId).toBeGreaterThan(result1.sessionId);
    });
  });
});
