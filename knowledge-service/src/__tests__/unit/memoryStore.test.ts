/**
 * Unit tests for MemoryStore (ADR-049 Phase 1)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { MemoryStore, type MemorySection } from '../../memoryStore';
import { getTerminalsRoot } from '../../config/terminals';

const TEST_TERMINAL = 'test-backend';
const TEST_DB_PATH = path.join(getTerminalsRoot(), TEST_TERMINAL, 'memory.db');

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    // Ensure test terminal directory exists
    const terminalDir = path.dirname(TEST_DB_PATH);
    await fs.mkdir(terminalDir, { recursive: true });

    // Create fresh MemoryStore
    store = new MemoryStore(TEST_TERMINAL);
  });

  afterEach(async () => {
    // Clean up
    store.close();

    // Remove test database
    try {
      await fs.unlink(TEST_DB_PATH);
      await fs.unlink(`${TEST_DB_PATH}-wal`); // WAL file
      await fs.unlink(`${TEST_DB_PATH}-shm`); // Shared memory file
    } catch {
      // Ignore errors if files don't exist
    }
  });

  describe('append()', () => {
    it('should append a memory entry', () => {
      const id = store.append('chat', 'Test memory content', 'backend-chat');
      expect(id).toBeGreaterThan(0);
    });

    it('should append entries to different sections', () => {
      store.append('chat', 'Chat message', 'backend-chat');
      store.append('work', 'Work task completed', 'backend-work');
      store.append('shared', 'Shared knowledge', 'backend');

      const stats = store.getStats();
      expect(stats.chat).toBe(1);
      expect(stats.work).toBe(1);
      expect(stats.shared).toBe(1);
    });

    it('should auto-generate timestamp', () => {
      store.append('chat', 'Timestamped entry', 'backend-chat');
      const entries = store.read('chat', 1);

      expect(entries).toHaveLength(1);
      expect(entries[0].timestamp).toBeDefined();
      expect(new Date(entries[0].timestamp).getTime()).toBeGreaterThan(0);
    });
  });

  describe('read()', () => {
    beforeEach(() => {
      // Seed some data
      store.append('chat', 'Message 1', 'backend-chat');
      store.append('chat', 'Message 2', 'backend-chat');
      store.append('chat', 'Message 3', 'backend-chat');
      store.append('work', 'Task 1', 'backend-work');
    });

    it('should read entries from a specific section', () => {
      const chatEntries = store.read('chat');
      expect(chatEntries).toHaveLength(3);
      expect(chatEntries.every(e => e.section === 'chat')).toBe(true);
    });

    it('should respect limit parameter', () => {
      const entries = store.read('chat', 2);
      expect(entries).toHaveLength(2);
    });

    it('should return entries in DESC timestamp order (newest first)', () => {
      const entries = store.read('chat', 3);
      expect(entries[0].content).toBe('Message 3'); // Newest
      expect(entries[2].content).toBe('Message 1'); // Oldest
    });

    it('should return empty array for section with no entries', () => {
      const entries = store.read('shared');
      expect(entries).toHaveLength(0);
    });
  });

  describe('readAll()', () => {
    beforeEach(() => {
      store.append('chat', 'Chat 1', 'backend-chat');
      store.append('work', 'Work 1', 'backend-work');
      store.append('shared', 'Shared 1', 'backend');
    });

    it('should return entries grouped by section', () => {
      const all = store.readAll();
      expect(all.chat).toHaveLength(1);
      expect(all.work).toHaveLength(1);
      expect(all.shared).toHaveLength(1);
    });
  });

  describe('exportToMarkdown()', () => {
    beforeEach(() => {
      store.append('chat', 'Chat message 1', 'backend-chat');
      store.append('chat', 'Chat message 2', 'backend-chat');
      store.append('work', 'Work task completed', 'backend-work-001');
      store.append('shared', 'Shared pattern', 'backend');
    });

    it('should export all sections to markdown', () => {
      const markdown = store.exportToMarkdown();

      expect(markdown).toContain('# TEST-BACKEND Terminal Memory');
      expect(markdown).toContain('## CHAT Section');
      expect(markdown).toContain('## WORK Section');
      expect(markdown).toContain('## SHARED Section');
      expect(markdown).toContain('Chat message 1');
      expect(markdown).toContain('Work task completed');
      expect(markdown).toContain('Shared pattern');
    });

    it('should respect includeSections parameter', () => {
      const markdown = store.exportToMarkdown(['chat', 'work']);

      expect(markdown).toContain('## CHAT Section');
      expect(markdown).toContain('## WORK Section');
      expect(markdown).not.toContain('## SHARED Section');
    });

    it('should include timestamps and authors', () => {
      const markdown = store.exportToMarkdown(['chat'], 1);

      expect(markdown).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO timestamp
      expect(markdown).toContain('backend-chat');
    });

    it('should skip empty sections', () => {
      store.clearSection('shared');
      const markdown = store.exportToMarkdown();

      expect(markdown).not.toContain('## SHARED Section');
    });
  });

  describe('getStats()', () => {
    it('should return zero counts for empty database', () => {
      const stats = store.getStats();
      expect(stats.chat).toBe(0);
      expect(stats.work).toBe(0);
      expect(stats.shared).toBe(0);
    });

    it('should return accurate counts per section', () => {
      store.append('chat', 'C1', 'backend-chat');
      store.append('chat', 'C2', 'backend-chat');
      store.append('work', 'W1', 'backend-work');
      store.append('shared', 'S1', 'backend');
      store.append('shared', 'S2', 'backend');
      store.append('shared', 'S3', 'backend');

      const stats = store.getStats();
      expect(stats.chat).toBe(2);
      expect(stats.work).toBe(1);
      expect(stats.shared).toBe(3);
    });
  });

  describe('clearSection()', () => {
    beforeEach(() => {
      store.append('chat', 'C1', 'backend-chat');
      store.append('chat', 'C2', 'backend-chat');
      store.append('work', 'W1', 'backend-work');
    });

    it('should clear all entries from a section', () => {
      const deleted = store.clearSection('chat');
      expect(deleted).toBe(2);

      const chatEntries = store.read('chat');
      expect(chatEntries).toHaveLength(0);

      // Other sections should be unaffected
      const workEntries = store.read('work');
      expect(workEntries).toHaveLength(1);
    });

    it('should return 0 if section is already empty', () => {
      const deleted = store.clearSection('shared');
      expect(deleted).toBe(0);
    });
  });

  describe('WAL mode', () => {
    it('should enable WAL journal mode', () => {
      // Query journal mode via pragma
      const stmt = (store as any).db.prepare('PRAGMA journal_mode');
      const result = stmt.get() as { journal_mode: string };

      expect(result.journal_mode.toLowerCase()).toBe('wal');
    });

    it('should support concurrent reads', () => {
      // This is a basic test - true concurrent access would need separate processes
      store.append('chat', 'Message 1', 'backend-chat');

      const entries1 = store.read('chat');
      const entries2 = store.read('chat');

      expect(entries1).toHaveLength(1);
      expect(entries2).toHaveLength(1);
    });
  });
});
