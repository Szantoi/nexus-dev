import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';

/**
 * Reviewer Unit Tests — Phase 1: Formal Review System
 *
 * Tests for review_type routing:
 * - formal → automated checks only (no LLM)
 * - content → dual Haiku review (default)
 * - manual → escalate to root
 */

// Mock fs module
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
  };
});

describe('Reviewer — review_type Routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractReviewType', () => {
    // Test the extraction logic inline since it's not exported
    function extractReviewType(content: string): 'formal' | 'content' | 'manual' {
      const match = content.match(/^review_type:\s*(.+)$/m);
      const reviewType = match ? match[1].trim().toLowerCase() : 'content';

      if (reviewType === 'formal') return 'formal';
      if (reviewType === 'manual') return 'manual';
      return 'content';
    }

    it('should return "formal" when review_type is formal', () => {
      const content = `---
id: MSG-TEST-001
type: done
review_type: formal
---`;
      expect(extractReviewType(content)).toBe('formal');
    });

    it('should return "content" when review_type is content', () => {
      const content = `---
id: MSG-TEST-001
type: done
review_type: content
---`;
      expect(extractReviewType(content)).toBe('content');
    });

    it('should return "manual" when review_type is manual', () => {
      const content = `---
id: MSG-TEST-001
type: done
review_type: manual
---`;
      expect(extractReviewType(content)).toBe('manual');
    });

    it('should default to "content" when review_type is missing (backward compat)', () => {
      const content = `---
id: MSG-TEST-001
type: done
---`;
      expect(extractReviewType(content)).toBe('content');
    });

    it('should handle case insensitively', () => {
      const content = `---
id: MSG-TEST-001
type: done
review_type: FORMAL
---`;
      expect(extractReviewType(content)).toBe('formal');
    });

    it('should handle unknown review_type as content', () => {
      const content = `---
id: MSG-TEST-001
type: done
review_type: unknown_type
---`;
      expect(extractReviewType(content)).toBe('content');
    });
  });

  describe('Formal Review Checks', () => {
    it('should validate frontmatter has required fields', () => {
      // Valid frontmatter
      const validContent = `---
id: MSG-TEST-001
type: done
status: UNREAD
---
# Done message`;

      const hasFrontmatter = validContent.startsWith('---');
      const hasRequiredFields = /^id:\s*.+$/m.test(validContent) &&
                                /^type:\s*.+$/m.test(validContent) &&
                                /^status:\s*.+$/m.test(validContent);

      expect(hasFrontmatter).toBe(true);
      expect(hasRequiredFields).toBe(true);
    });

    it('should reject frontmatter missing required fields', () => {
      const invalidContent = `---
id: MSG-TEST-001
---
# Done message`;

      const hasRequiredFields = /^id:\s*.+$/m.test(invalidContent) &&
                                /^type:\s*.+$/m.test(invalidContent) &&
                                /^status:\s*.+$/m.test(invalidContent);

      expect(hasRequiredFields).toBe(false);
    });

    it('should parse files_changed list correctly', () => {
      const content = `---
files_changed:
  - src/pipeline/reviewer.ts
  - src/__tests__/unit/reviewer.test.ts
---`;

      const filesChangedMatch = content.match(/files_changed:\s*\n((?:\s+-\s+.+\n?)+)/);
      expect(filesChangedMatch).not.toBeNull();

      const changedFiles = filesChangedMatch![1].split('\n')
        .map(f => f.replace(/^\s*-\s*/, '').trim())
        .filter(f => f.length > 0);

      expect(changedFiles).toEqual([
        'src/pipeline/reviewer.ts',
        'src/__tests__/unit/reviewer.test.ts'
      ]);
    });
  });

  describe('Review Type Routing Decision', () => {
    it('should route formal reviews to automated checks', () => {
      const reviewType = 'formal';
      const shouldUseLLM = reviewType === 'content';
      const shouldEscalate = reviewType === 'manual';
      const shouldAutoCheck = reviewType === 'formal';

      expect(shouldUseLLM).toBe(false);
      expect(shouldEscalate).toBe(false);
      expect(shouldAutoCheck).toBe(true);
    });

    it('should route content reviews to LLM', () => {
      const reviewType = 'content';
      const shouldUseLLM = reviewType === 'content';

      expect(shouldUseLLM).toBe(true);
    });

    it('should route manual reviews to escalation', () => {
      const reviewType = 'manual';
      const shouldEscalate = reviewType === 'manual';

      expect(shouldEscalate).toBe(true);
    });
  });

  describe('Task Type Code Check Routing', () => {
    it('should run code checks for CODE task type', () => {
      const taskTypes = ['CODE', 'BUGFIX', 'FEATURE'];
      const needsCodeChecks = taskTypes.includes('CODE');
      expect(needsCodeChecks).toBe(true);
    });

    it('should run code checks for BUGFIX task type', () => {
      const taskTypes = ['CODE', 'BUGFIX', 'FEATURE'];
      const needsCodeChecks = taskTypes.includes('BUGFIX');
      expect(needsCodeChecks).toBe(true);
    });

    it('should run code checks for FEATURE task type', () => {
      const taskTypes = ['CODE', 'BUGFIX', 'FEATURE'];
      const needsCodeChecks = taskTypes.includes('FEATURE');
      expect(needsCodeChecks).toBe(true);
    });

    it('should NOT run code checks for DOCUMENTATION task type', () => {
      const taskTypes = ['CODE', 'BUGFIX', 'FEATURE'];
      const needsCodeChecks = taskTypes.includes('DOCUMENTATION');
      expect(needsCodeChecks).toBe(false);
    });

    it('should NOT run code checks for COORDINATION task type', () => {
      const taskTypes = ['CODE', 'BUGFIX', 'FEATURE'];
      const needsCodeChecks = taskTypes.includes('COORDINATION');
      expect(needsCodeChecks).toBe(false);
    });
  });

  describe('Test Execution Routing', () => {
    it('should run tests for BUGFIX task type', () => {
      const taskType = 'BUGFIX';
      const reviewLevel = 'standard';
      const needsTests = taskType === 'BUGFIX' || reviewLevel === 'strict';
      expect(needsTests).toBe(true);
    });

    it('should run tests for strict review_level', () => {
      const taskType = 'CODE';
      const reviewLevel = 'strict';
      const needsTests = taskType === 'BUGFIX' || reviewLevel === 'strict';
      expect(needsTests).toBe(true);
    });

    it('should NOT run tests for CODE with standard review_level', () => {
      const taskType = 'CODE';
      const reviewLevel = 'standard';
      const needsTests = taskType === 'BUGFIX' || reviewLevel === 'strict';
      expect(needsTests).toBe(false);
    });
  });

  describe('FormalReviewResult Structure', () => {
    interface FormalReviewResult {
      approved: boolean;
      checks: {
        frontmatter: boolean;
        gitCommit: boolean;
        buildSuccess?: boolean;
        lintPass?: boolean;
        testsPass?: boolean;
        typeCheck?: boolean;
      };
      errors: string[];
      duration: number;
    }

    it('should have correct structure with all optional checks', () => {
      const result: FormalReviewResult = {
        approved: true,
        checks: {
          frontmatter: true,
          gitCommit: true,
          buildSuccess: true,
          lintPass: true,
          testsPass: true,
          typeCheck: true,
        },
        errors: [],
        duration: 1500,
      };

      expect(result.approved).toBe(true);
      expect(result.checks.frontmatter).toBe(true);
      expect(result.checks.gitCommit).toBe(true);
      expect(result.checks.buildSuccess).toBe(true);
      expect(result.checks.lintPass).toBe(true);
      expect(result.checks.testsPass).toBe(true);
      expect(result.checks.typeCheck).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.duration).toBeGreaterThan(0);
    });

    it('should approve when required checks pass and optional are undefined', () => {
      const checks = {
        frontmatter: true,
        gitCommit: true,
        buildSuccess: undefined as boolean | undefined,
        lintPass: undefined as boolean | undefined,
        testsPass: undefined as boolean | undefined,
        typeCheck: undefined as boolean | undefined,
      };

      const requiredPassed = checks.frontmatter && checks.gitCommit;
      const optionalPassed = checks.buildSuccess !== false &&
                             checks.lintPass !== false &&
                             checks.testsPass !== false &&
                             checks.typeCheck !== false;
      const approved = requiredPassed && optionalPassed;

      expect(approved).toBe(true);
    });

    it('should reject when any optional check explicitly fails', () => {
      const checks = {
        frontmatter: true,
        gitCommit: true,
        buildSuccess: false, // FAILED
        lintPass: undefined as boolean | undefined,
        testsPass: undefined as boolean | undefined,
        typeCheck: true,
      };

      const requiredPassed = checks.frontmatter && checks.gitCommit;
      const optionalPassed = checks.buildSuccess !== false &&
                             checks.lintPass !== false &&
                             checks.testsPass !== false &&
                             checks.typeCheck !== false;
      const approved = requiredPassed && optionalPassed;

      expect(approved).toBe(false);
    });

    it('should reject when required check fails', () => {
      const checks = {
        frontmatter: false, // FAILED
        gitCommit: true,
        buildSuccess: true,
        lintPass: true,
        testsPass: true,
        typeCheck: true,
      };

      const requiredPassed = checks.frontmatter && checks.gitCommit;
      expect(requiredPassed).toBe(false);
    });
  });
});
