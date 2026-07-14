import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  hashToken,
  verifyToken,
  hasScope,
  authorizeScope,
  clearCache,
  isValidTerminal,
  VALID_TERMINALS,
} from '../../task-audit/auth';

/**
 * Token Authentication Tests — Phase 2 Implementation
 *
 * Coverage requirement: 100% (P0 critical path)
 */

describe('TokenAuth', () => {
  beforeEach(() => {
    clearCache();
  });

  describe('hashToken', () => {
    it('should return sha256 prefixed hash', () => {
      const hash = hashToken('test-token');
      expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it('should return consistent hash for same input', () => {
      const hash1 = hashToken('my-token');
      const hash2 = hashToken('my-token');
      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different input', () => {
      const hash1 = hashToken('token-a');
      const hash2 = hashToken('token-b');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('hasScope', () => {
    it('should match exact scope', () => {
      expect(hasScope(['task:create:backend'], 'task:create:backend')).toBe(true);
    });

    it('should match wildcard scope', () => {
      expect(hasScope(['task:create:*'], 'task:create:backend')).toBe(true);
      expect(hasScope(['task:create:*'], 'task:create:frontend')).toBe(true);
    });

    it('should not match different scope', () => {
      expect(hasScope(['task:create:backend'], 'task:create:frontend')).toBe(false);
    });

    it('should not match partial wildcard incorrectly', () => {
      expect(hasScope(['task:*'], 'session:start')).toBe(false);
    });

    it('should match with multiple scopes', () => {
      const scopes = ['task:create:backend', 'task:create:frontend'];
      expect(hasScope(scopes, 'task:create:backend')).toBe(true);
      expect(hasScope(scopes, 'task:create:frontend')).toBe(true);
      expect(hasScope(scopes, 'task:create:designer')).toBe(false);
    });
  });

  describe('verifyToken', () => {
    it('should reject invalid token', () => {
      const result = verifyToken('invalid-token-123');
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Invalid token');
    });

    it('should accept valid dev token (root)', () => {
      const result = verifyToken('dev-token-root-2026');
      expect(result.authenticated).toBe(true);
      expect(result.holder).toBe('root');
      expect(result.scopes).toContain('task:create:*');
    });

    it('should NOT expose token in error messages', () => {
      const result = verifyToken('super-secret-token-12345');
      expect(result.error).not.toContain('super-secret');
      expect(result.error).not.toContain('12345');
    });
  });

  describe('authorizeScope', () => {
    it('should authorize valid token with matching scope', () => {
      const result = authorizeScope('dev-token-root-2026', 'task:create:backend');
      expect(result.authenticated).toBe(true);
    });

    it('should reject valid token with insufficient scope', () => {
      const result = authorizeScope('dev-token-conductor-2026', 'session:start');
      // Conductor doesn't have session:* scope
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Insufficient scope');
    });

    it('should reject invalid token before checking scope', () => {
      const result = authorizeScope('invalid-token', 'task:create:backend');
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Invalid token');
    });
  });

  describe('isValidTerminal', () => {
    it('should accept valid terminals', () => {
      expect(isValidTerminal('backend')).toBe(true);
      expect(isValidTerminal('frontend')).toBe(true);
      expect(isValidTerminal('conductor')).toBe(true);
    });

    it('should reject invalid terminals', () => {
      expect(isValidTerminal('root')).toBe(false);  // root is not a worker terminal
      expect(isValidTerminal('invalid')).toBe(false);
      expect(isValidTerminal('')).toBe(false);
    });

    it('should have all expected terminals', () => {
      expect(VALID_TERMINALS).toContain('backend');
      expect(VALID_TERMINALS).toContain('frontend');
      expect(VALID_TERMINALS).toContain('designer');
      expect(VALID_TERMINALS).toContain('architect');
      expect(VALID_TERMINALS).toContain('librarian');
      expect(VALID_TERMINALS).toContain('explorer');
      expect(VALID_TERMINALS).toContain('conductor');
    });
  });

  describe('Cache behavior', () => {
    it('should cache valid token permissions', () => {
      // First call - cache miss
      const result1 = verifyToken('dev-token-root-2026');
      expect(result1.authenticated).toBe(true);

      // Second call - cache hit (same result)
      const result2 = verifyToken('dev-token-root-2026');
      expect(result2.authenticated).toBe(true);
      expect(result2.holder).toBe(result1.holder);
    });

    it('should clear cache on clearCache()', () => {
      verifyToken('dev-token-root-2026');
      clearCache();
      // After clear, token should still work (re-validates)
      const result = verifyToken('dev-token-root-2026');
      expect(result.authenticated).toBe(true);
    });
  });
});
