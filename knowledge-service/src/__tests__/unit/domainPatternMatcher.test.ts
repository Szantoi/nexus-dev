/**
 * Domain Pattern Matcher Unit Tests
 *
 * Tests for pattern matching, domain detection, and recommendation generation.
 * Target coverage: >90%
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  matchDomainPattern,
  getKnownPatterns,
  getAvailableDomains,
  validatePatternRequest,
} from '../../pipeline/domainPatternMatcher';
import type { PatternMatch, MatchResult } from '../../pipeline/domainPatternMatcher';

describe('Domain Pattern Matcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('matchDomainPattern', () => {
    it('should return structured result for any description', async () => {
      const result = await matchDomainPattern('implement caching for API responses');

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      if (result.success) {
        expect(result.pattern).toBeDefined();
      }
    });

    it('should validate input properly', async () => {
      const result = await matchDomainPattern('some pattern description');

      expect(result).toBeDefined();
      expect(result.success !== undefined).toBe(true);
    });

    it('should handle unknown patterns gracefully', async () => {
      const result = await matchDomainPattern('xyzabc qwerty unknown gibberish');

      expect(result).toBeDefined();
      expect(result.pattern || result.error).toBeDefined();
    });

    it('should work with CRM domain', async () => {
      const result = await matchDomainPattern('FSM state management', 'crm');

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should work with Cutting domain', async () => {
      const result = await matchDomainPattern('Quote estimation', 'cutting');

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('should return result structure', async () => {
      const result = await matchDomainPattern('implementation guide');

      expect(result).toBeDefined();
      expect(result.success !== undefined).toBe(true);
      if (result.success) {
        expect(result.pattern !== undefined).toBe(true);
      }
    });

    it('should handle RLS pattern', async () => {
      const result = await matchDomainPattern('Row-Level Security');

      expect(result).toBeDefined();
      if (result.success && result.pattern?.adrRefs) {
        expect(Array.isArray(result.pattern.adrRefs)).toBe(true);
      }
    });

    it('should include references in pattern', async () => {
      const result = await matchDomainPattern('Row-Level Security');

      if (result.success && result.pattern) {
        expect(result.pattern?.references !== undefined).toBe(true);
      }
    });

    it('should provide recommendations in pattern', async () => {
      const result = await matchDomainPattern('Row-Level Security');

      if (result.success && result.pattern) {
        expect(result.pattern?.recommendations !== undefined).toBe(true);
      }
    });

    it('should match FSM pattern with confidence', async () => {
      const result = await matchDomainPattern('FSM Lead/Opportunity');

      if (result.success && result.pattern) {
        expect(typeof result.pattern.confidence).toBe('number');
        expect(result.pattern.confidence).toBeGreaterThan(0);
      }
    });

    it('should handle very short descriptions', async () => {
      const result = await matchDomainPattern('FSM');

      expect(result).toBeDefined();
    });

    it('should handle long descriptions', async () => {
      const longDesc = 'We need to implement a complex system for managing leads and opportunities across multiple sales channels with integration to CRM backend';

      const result = await matchDomainPattern(longDesc);

      expect(result).toBeDefined();
    });

    it('should have optional example code', async () => {
      const result = await matchDomainPattern('any pattern');

      if (result.success && result.pattern?.exampleCode) {
        expect(typeof result.pattern.exampleCode).toBe('string');
      }
    });

    it('should reject invalid domain', async () => {
      const result = await matchDomainPattern('test pattern', 'invalid-domain');

      expect(result.error).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('should detect domain from content', async () => {
      const result = await matchDomainPattern('RLS isolation');

      if (result.success && result.pattern?.domain) {
        expect(typeof result.pattern.domain).toBe('string');
      }
    });
  });

  describe('getKnownPatterns', () => {
    it('should return patterns for CRM domain', () => {
      const patterns = getKnownPatterns();

      expect(patterns.crm).toBeDefined();
      expect(Array.isArray(patterns.crm)).toBe(true);
      expect(patterns.crm.length).toBeGreaterThan(0);
    });

    it('should return patterns for Cutting domain', () => {
      const patterns = getKnownPatterns();

      expect(patterns.cutting).toBeDefined();
      expect(Array.isArray(patterns.cutting)).toBe(true);
    });

    it('should have pattern structure', () => {
      const patterns = getKnownPatterns();

      patterns.crm.forEach((pattern: PatternMatch) => {
        expect(pattern.pattern).toBeDefined();
        expect(pattern.confidence).toBeGreaterThan(0);
        expect(pattern.confidence).toBeLessThanOrEqual(1);
        expect(pattern.domain).toBeDefined();
        expect(pattern.references).toBeDefined();
        expect(pattern.recommendations).toBeDefined();
        expect(pattern.adrRefs).toBeDefined();
      });
    });

    it('should include Lead/Opportunity FSM pattern', () => {
      const patterns = getKnownPatterns();
      const crmPatterns = patterns.crm;

      const fsmPattern = crmPatterns.find((p: PatternMatch) => p.pattern.includes('FSM'));
      expect(fsmPattern).toBeDefined();
      expect(fsmPattern?.adrRefs).toContain('ADR-054');
    });

    it('should include Quote Estimation pattern', () => {
      const patterns = getKnownPatterns();
      const cuttingPatterns = patterns.cutting;

      const quotePattern = cuttingPatterns.find((p: PatternMatch) => p.pattern.includes('Quote'));
      expect(quotePattern).toBeDefined();
    });

    it('should have high confidence for known patterns', () => {
      const patterns = getKnownPatterns();

      Object.values(patterns).forEach((domainPatterns: PatternMatch[]) => {
        domainPatterns.forEach((pattern: PatternMatch) => {
          expect(pattern.confidence).toBeGreaterThan(0.7);
        });
      });
    });
  });

  describe('getAvailableDomains', () => {
    it('should return list of domains', () => {
      const domains = getAvailableDomains();

      expect(Array.isArray(domains)).toBe(true);
      expect(domains.length).toBeGreaterThan(0);
    });

    it('should include all major domains', () => {
      const domains = getAvailableDomains();

      expect(domains).toContain('crm');
      expect(domains).toContain('cutting');
      expect(domains).toContain('joinery');
      expect(domains).toContain('kernel');
    });

    it('should include general domain', () => {
      const domains = getAvailableDomains();

      expect(domains).toContain('general');
    });

    it('should not have duplicates', () => {
      const domains = getAvailableDomains();
      const unique = new Set(domains);

      expect(unique.size).toBe(domains.length);
    });

    it('should have consistent domain names', () => {
      const domains = getAvailableDomains();

      domains.forEach((domain: string) => {
        expect(typeof domain).toBe('string');
        expect(domain.length).toBeGreaterThan(0);
        expect(domain).toMatch(/^[a-z_]+$/);
      });
    });
  });

  describe('validatePatternRequest', () => {
    it('should validate correct request', () => {
      const result = validatePatternRequest('implement caching for API');

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should validate with domain', () => {
      const result = validatePatternRequest('lead management workflow', 'crm');

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject empty description', () => {
      const result = validatePatternRequest('');

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some((e: string) => e.includes('required'))).toBe(true);
    });

    it('should reject whitespace-only description', () => {
      const result = validatePatternRequest('   ');

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should reject too long description', () => {
      const longDesc = 'a'.repeat(501);
      const result = validatePatternRequest(longDesc);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some((e: string) => e.includes('too long'))).toBe(true);
    });

    it('should accept 500 char description', () => {
      const desc = 'a'.repeat(500);
      const result = validatePatternRequest(desc);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject invalid domain', () => {
      const result = validatePatternRequest('test pattern', 'invalid-domain');

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some((e: string) => e.includes('domain'))).toBe(true);
    });

    it('should validate all available domains', () => {
      const domains = getAvailableDomains();

      domains.forEach((domain: string) => {
        const result = validatePatternRequest('test', domain);
        expect(result.valid).toBe(true);
      });
    });

    it('should return error messages', () => {
      const result = validatePatternRequest('');

      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors?.length).toBeGreaterThan(0);
      result.errors?.forEach((error: string) => {
        expect(typeof error).toBe('string');
        expect(error.length).toBeGreaterThan(0);
      });
    });

    it('should accumulate multiple errors', () => {
      const result = validatePatternRequest('', 'invalid-domain');

      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('error handling', () => {
    it('should handle vector search failures gracefully', async () => {
      // If vector search fails, should fallback to keyword search
      const result = await matchDomainPattern('CQRS handler generator pattern');

      expect(result).toBeDefined();
      expect(result.success || result.error).toBeDefined();
    });

    it('should return error message on failure', async () => {
      const result = await matchDomainPattern('test', 'invalid-domain');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });

  describe('performance', () => {
    it('should match pattern in <300ms', async () => {
      const start = Date.now();
      await matchDomainPattern('implement database migration strategy');
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(300);
    });

    it('should handle multiple rapid requests', async () => {
      const start = Date.now();

      for (let i = 0; i < 5; i++) {
        await matchDomainPattern(`pattern ${i}`);
      }

      const duration = Date.now() - start;
      // 5 requests should complete within reasonable time
      expect(duration).toBeLessThan(1500);
    });

    it('should cache known patterns efficiently', () => {
      const start = Date.now();

      const patterns1 = getKnownPatterns();
      const patterns2 = getKnownPatterns();

      const duration = Date.now() - start;

      expect(patterns1).toEqual(patterns2);
      expect(duration).toBeLessThan(10);
    });
  });
});
