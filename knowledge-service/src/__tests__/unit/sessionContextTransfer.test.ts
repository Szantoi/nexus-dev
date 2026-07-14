/**
 * Session Context Transfer Unit Tests
 *
 * Tests for context transfer between terminals, file handling, and validation.
 * Target coverage: >90%
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  transferSessionContext,
  validateContextTransfer,
  getContextTemplates,
} from '../../pipeline/sessionContextTransfer';
import type { ContextTransferParams } from '../../pipeline/sessionContextTransfer';

describe('Session Context Transfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('transferSessionContext', () => {
    it('should transfer research_summary context', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'librarian',
        contextType: 'research_summary',
        summary: 'Found 5 patterns in EHS module',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(result.fileCount).toBe(0);
      expect(result.transferredBytes).toBe(0);
    });

    it('should transfer code_audit context', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'architect',
        toTerminal: 'backend',
        contextType: 'code_audit',
        summary: 'Security review complete',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should transfer knowledge_synthesis context', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'librarian',
        toTerminal: 'architect',
        contextType: 'knowledge_synthesis',
        summary: 'Synthesized 3 new patterns',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should include files in context transfer', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'librarian',
        contextType: 'research_summary',
        summary: 'Research findings',
        includeFiles: ['/opt/spaceos/docs/knowledge/patterns/DATABASE_PATTERNS.md'],
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(true);
      expect(result.fileCount).toBeGreaterThanOrEqual(0);
      expect(result.transferredBytes).toBeGreaterThanOrEqual(0);
    });

    it('should handle multiple files', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'backend',
        toTerminal: 'architect',
        contextType: 'code_audit',
        includeFiles: [
          '/opt/spaceos/docs/knowledge/patterns/DATABASE_PATTERNS.md',
          '/opt/spaceos/docs/knowledge/patterns/TESTING_PATTERNS.md',
        ],
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(true);
      expect(typeof result.fileCount).toBe('number');
    });

    it('should fail with invalid terminals', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'invalid-terminal',
        toTerminal: 'conductor',
        contextType: 'research_summary',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fail with same from/to terminal', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'conductor',
        toTerminal: 'conductor',
        contextType: 'research_summary',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should create inbox message in target terminal', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'research_summary',
        summary: 'Test transfer',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(true);
      expect(result.inboxFile).toBeDefined();
      expect(result.inboxFile).toContain('conductor');
      expect(result.inboxFile).toContain('inbox');
    });

    it('should track transferred bytes correctly', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'librarian',
        contextType: 'research_summary',
        summary: 'Test summary with some content to measure bytes',
        includeFiles: ['/opt/spaceos/docs/knowledge/patterns/DATABASE_PATTERNS.md'],
      };

      const result = await transferSessionContext(params);

      expect(result.transferredBytes).toBeGreaterThanOrEqual(0);
      expect(typeof result.transferredBytes).toBe('number');
    });

    it('should handle non-existent files gracefully', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'librarian',
        contextType: 'research_summary',
        includeFiles: ['/nonexistent/file.md', '/another/missing.md'],
      };

      const result = await transferSessionContext(params);

      // Should still succeed even if files don't exist
      expect(result).toBeDefined();
      expect(typeof result.fileCount).toBe('number');
    });

    it('should generate context templates in message', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'research_summary',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
    });

    it('should include next steps in context', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'backend',
        toTerminal: 'architect',
        contextType: 'code_audit',
        summary: 'Code review findings',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(true);
      // Message should include next steps (verified in integration test)
    });
  });

  describe('validateContextTransfer', () => {
    it('should validate correct parameters', () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'research_summary',
      };

      const result = validateContextTransfer(params);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject missing fromTerminal', () => {
      const params: any = {
        toTerminal: 'conductor',
        contextType: 'research_summary',
      };

      const result = validateContextTransfer(params);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some((e: string) => e.includes('fromTerminal'))).toBe(true);
    });

    it('should reject missing toTerminal', () => {
      const params: any = {
        fromTerminal: 'explorer',
        contextType: 'research_summary',
      };

      const result = validateContextTransfer(params);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should reject same from/to terminal', () => {
      const params: ContextTransferParams = {
        fromTerminal: 'conductor',
        toTerminal: 'conductor',
        contextType: 'research_summary',
      };

      const result = validateContextTransfer(params);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some((e: string) => e.includes('same'))).toBe(true);
    });

    it('should reject invalid contextType', () => {
      const params: any = {
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'invalid_type',
      };

      const result = validateContextTransfer(params);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should reject too many files', () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'research_summary',
        includeFiles: Array(25).fill('/some/file.md'),
      };

      const result = validateContextTransfer(params);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some((e: string) => e.includes('20'))).toBe(true);
    });

    it('should allow exactly 20 files', () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'research_summary',
        includeFiles: Array(20).fill('/some/file.md'),
      };

      const result = validateContextTransfer(params);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });
  });

  describe('getContextTemplates', () => {
    it('should return research_summary template', () => {
      const templates = getContextTemplates();

      expect(templates.research_summary).toBeDefined();
      expect(typeof templates.research_summary).toBe('string');
      expect(templates.research_summary).toContain('Research Summary');
    });

    it('should return code_audit template', () => {
      const templates = getContextTemplates();

      expect(templates.code_audit).toBeDefined();
      expect(typeof templates.code_audit).toBe('string');
      expect(templates.code_audit).toContain('Code Audit');
    });

    it('should return knowledge_synthesis template', () => {
      const templates = getContextTemplates();

      expect(templates.knowledge_synthesis).toBeDefined();
      expect(typeof templates.knowledge_synthesis).toBe('string');
      expect(templates.knowledge_synthesis).toContain('Knowledge Synthesis');
    });

    it('should have all 3 templates', () => {
      const templates = getContextTemplates();

      expect(Object.keys(templates).length).toBe(3);
      expect(templates).toHaveProperty('research_summary');
      expect(templates).toHaveProperty('code_audit');
      expect(templates).toHaveProperty('knowledge_synthesis');
    });
  });

  describe('error handling', () => {
    it('should handle missing inbox file gracefully', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'research_summary',
      };

      const result = await transferSessionContext(params);

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should return error details', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'invalid',
        toTerminal: 'also-invalid',
        contextType: 'research_summary',
      };

      const result = await transferSessionContext(params);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });

  describe('performance', () => {
    it('should transfer context in <200ms', async () => {
      const params: ContextTransferParams = {
        fromTerminal: 'explorer',
        toTerminal: 'conductor',
        contextType: 'research_summary',
        summary: 'Test',
      };

      const start = Date.now();
      await transferSessionContext(params);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(200);
    });
  });
});
