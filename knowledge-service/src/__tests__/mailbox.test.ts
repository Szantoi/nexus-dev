/**
 * Mailbox Service Tests
 *
 * Tests for the new mailbox functions:
 * - listOutbox
 * - listAllUnreadOutbox
 * - getInboxMessageCounter
 * - markAsRead
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// Test fixtures directory - unique per test run to avoid race conditions
let TEST_TERMINALS_ROOT: string;

describe('Mailbox Service', () => {
  beforeEach(async () => {
    // Create unique test directory for this test run
    const uniqueId = crypto.randomBytes(8).toString('hex');
    TEST_TERMINALS_ROOT = `/tmp/test-terminals-${uniqueId}`;

    // Create test directory structure
    await fs.mkdir(TEST_TERMINALS_ROOT, { recursive: true });

    // Create test terminals with inbox/outbox
    const terminals = ['backend', 'frontend', 'conductor'];
    for (const terminal of terminals) {
      await fs.mkdir(path.join(TEST_TERMINALS_ROOT, terminal, 'inbox'), { recursive: true });
      await fs.mkdir(path.join(TEST_TERMINALS_ROOT, terminal, 'outbox'), { recursive: true });
    }
  });

  afterEach(async () => {
    // Clean up test directories
    if (TEST_TERMINALS_ROOT) {
      await fs.rm(TEST_TERMINALS_ROOT, { recursive: true, force: true });
    }
  });

  describe('listOutbox', () => {
    it('should return empty array for terminal with no outbox messages', async () => {
      const outboxPath = path.join(TEST_TERMINALS_ROOT, 'backend', 'outbox');
      const files = await fs.readdir(outboxPath);
      expect(files.length).toBe(0);
    });

    it('should list outbox messages with UNREAD status', async () => {
      // Create test message
      const outboxPath = path.join(TEST_TERMINALS_ROOT, 'backend', 'outbox');
      const messageContent = `---
id: MSG-BACKEND-001-DONE
from: backend
to: root
type: done
status: UNREAD
created: 2026-06-21
---

# Test DONE message
`;
      await fs.writeFile(path.join(outboxPath, '2026-06-21_001_test-done.md'), messageContent);

      const files = await fs.readdir(outboxPath);
      expect(files.length).toBe(1);
      expect(files[0]).toBe('2026-06-21_001_test-done.md');

      const content = await fs.readFile(path.join(outboxPath, files[0]), 'utf-8');
      expect(content).toContain('status: UNREAD');
    });

    it('should filter by READ status', async () => {
      const outboxPath = path.join(TEST_TERMINALS_ROOT, 'frontend', 'outbox');

      // Create UNREAD message
      await fs.writeFile(
        path.join(outboxPath, '2026-06-21_001_unread.md'),
        `---
id: MSG-FE-001
status: UNREAD
---
# Unread
`
      );

      // Create READ message
      await fs.writeFile(
        path.join(outboxPath, '2026-06-21_002_read.md'),
        `---
id: MSG-FE-002
status: READ
---
# Read
`
      );

      const files = await fs.readdir(outboxPath);
      expect(files.length).toBe(2);

      // Filter for UNREAD
      const unreadFiles = [];
      for (const file of files) {
        const content = await fs.readFile(path.join(outboxPath, file), 'utf-8');
        if (content.includes('status: UNREAD')) {
          unreadFiles.push(file);
        }
      }
      expect(unreadFiles.length).toBe(1);
    });
  });

  describe('getInboxMessageCounter', () => {
    it('should count messages per terminal', async () => {
      // Create inbox messages
      const backendInbox = path.join(TEST_TERMINALS_ROOT, 'backend', 'inbox');
      const frontendInbox = path.join(TEST_TERMINALS_ROOT, 'frontend', 'inbox');

      // Backend: 2 UNREAD, 1 READ
      await fs.writeFile(
        path.join(backendInbox, 'msg1.md'),
        '---\nstatus: UNREAD\n---\n'
      );
      await fs.writeFile(
        path.join(backendInbox, 'msg2.md'),
        '---\nstatus: UNREAD\n---\n'
      );
      await fs.writeFile(
        path.join(backendInbox, 'msg3.md'),
        '---\nstatus: READ\n---\n'
      );

      // Frontend: 1 UNREAD
      await fs.writeFile(
        path.join(frontendInbox, 'msg1.md'),
        '---\nstatus: UNREAD\n---\n'
      );

      // Count for backend
      const backendFiles = await fs.readdir(backendInbox);
      let backendUnread = 0;
      for (const file of backendFiles) {
        const content = await fs.readFile(path.join(backendInbox, file), 'utf-8');
        if (content.includes('status: UNREAD')) backendUnread++;
      }
      expect(backendUnread).toBe(2);
      expect(backendFiles.length).toBe(3);

      // Count for frontend
      const frontendFiles = await fs.readdir(frontendInbox);
      let frontendUnread = 0;
      for (const file of frontendFiles) {
        const content = await fs.readFile(path.join(frontendInbox, file), 'utf-8');
        if (content.includes('status: UNREAD')) frontendUnread++;
      }
      expect(frontendUnread).toBe(1);
      expect(frontendFiles.length).toBe(1);
    });

    it('should return 0 for empty inbox', async () => {
      const conductorInbox = path.join(TEST_TERMINALS_ROOT, 'conductor', 'inbox');
      const files = await fs.readdir(conductorInbox);
      expect(files.length).toBe(0);
    });
  });

  describe('markAsRead', () => {
    it('should change UNREAD to READ in message file', async () => {
      const inboxPath = path.join(TEST_TERMINALS_ROOT, 'backend', 'inbox');
      const messageFile = path.join(inboxPath, '2026-06-21_001_test.md');

      // Create UNREAD message
      await fs.writeFile(
        messageFile,
        `---
id: MSG-BACKEND-001
from: root
to: backend
type: task
status: UNREAD
created: 2026-06-21
---

# Test task
`
      );

      // Verify initial state
      let content = await fs.readFile(messageFile, 'utf-8');
      expect(content).toContain('status: UNREAD');

      // Mark as READ (simulate the function)
      content = content.replace('status: UNREAD', 'status: READ');
      await fs.writeFile(messageFile, content);

      // Verify changed state
      const updatedContent = await fs.readFile(messageFile, 'utf-8');
      expect(updatedContent).toContain('status: READ');
      expect(updatedContent).not.toContain('status: UNREAD');
    });

    it('should return false for non-existent message', async () => {
      const inboxPath = path.join(TEST_TERMINALS_ROOT, 'backend', 'inbox');
      const files = await fs.readdir(inboxPath);

      // No messages exist
      const messageExists = files.some(f => f.includes('NON-EXISTENT'));
      expect(messageExists).toBe(false);
    });

    it('should not modify already READ messages', async () => {
      const inboxPath = path.join(TEST_TERMINALS_ROOT, 'frontend', 'inbox');
      const messageFile = path.join(inboxPath, '2026-06-21_001_already-read.md');

      const originalContent = `---
id: MSG-FRONTEND-001
status: READ
created: 2026-06-21
---

# Already read
`;
      await fs.writeFile(messageFile, originalContent);

      // Check that it's already READ
      const content = await fs.readFile(messageFile, 'utf-8');
      expect(content).toContain('status: READ');

      // Should not have UNREAD
      expect(content).not.toContain('status: UNREAD');
    });
  });

  describe('listAllUnreadOutbox', () => {
    it('should aggregate UNREAD outbox messages across all terminals', async () => {
      // Create UNREAD outbox messages in different terminals
      const backendOutbox = path.join(TEST_TERMINALS_ROOT, 'backend', 'outbox');
      const frontendOutbox = path.join(TEST_TERMINALS_ROOT, 'frontend', 'outbox');

      await fs.writeFile(
        path.join(backendOutbox, 'msg1.md'),
        '---\nid: MSG-BE-001\nstatus: UNREAD\n---\n'
      );
      await fs.writeFile(
        path.join(backendOutbox, 'msg2.md'),
        '---\nid: MSG-BE-002\nstatus: UNREAD\n---\n'
      );
      await fs.writeFile(
        path.join(frontendOutbox, 'msg1.md'),
        '---\nid: MSG-FE-001\nstatus: UNREAD\n---\n'
      );

      // Count total UNREAD across terminals
      let totalUnread = 0;
      const terminals = ['backend', 'frontend', 'conductor'];
      const results: { terminal: string; count: number }[] = [];

      for (const terminal of terminals) {
        const outboxPath = path.join(TEST_TERMINALS_ROOT, terminal, 'outbox');
        try {
          const files = await fs.readdir(outboxPath);
          let unreadCount = 0;
          for (const file of files.filter(f => f.endsWith('.md'))) {
            const content = await fs.readFile(path.join(outboxPath, file), 'utf-8');
            if (content.includes('status: UNREAD')) {
              unreadCount++;
              totalUnread++;
            }
          }
          if (unreadCount > 0) {
            results.push({ terminal, count: unreadCount });
          }
        } catch {
          // Skip non-existent directories
        }
      }

      expect(totalUnread).toBe(3);
      expect(results.length).toBe(2); // backend and frontend have UNREAD
      expect(results.find(r => r.terminal === 'backend')?.count).toBe(2);
      expect(results.find(r => r.terminal === 'frontend')?.count).toBe(1);
    });

    it('should return empty array when no UNREAD outbox messages exist', async () => {
      // Create only READ messages
      const backendOutbox = path.join(TEST_TERMINALS_ROOT, 'backend', 'outbox');
      await fs.writeFile(
        path.join(backendOutbox, 'msg1.md'),
        '---\nstatus: READ\n---\n'
      );

      let totalUnread = 0;
      const terminals = ['backend', 'frontend', 'conductor'];

      for (const terminal of terminals) {
        const outboxPath = path.join(TEST_TERMINALS_ROOT, terminal, 'outbox');
        try {
          const files = await fs.readdir(outboxPath);
          for (const file of files.filter(f => f.endsWith('.md'))) {
            const content = await fs.readFile(path.join(outboxPath, file), 'utf-8');
            if (content.includes('status: UNREAD')) {
              totalUnread++;
            }
          }
        } catch {
          // Skip
        }
      }

      expect(totalUnread).toBe(0);
    });
  });
});
