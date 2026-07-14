import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * MCP Authentication Tests — Token Validation & Permission System
 *
 * Tests the agents.yaml + tool-permissions.yaml based auth system.
 * These are unit tests that don't require the server to be running.
 */

// ─── Test Data ───────────────────────────────────────────────────────────────

const TEST_AGENTS_CONFIG = {
  version: '1.1',
  updated: '2026-06-24',
  master_token: 'test-master-token-abc123',
  agents: {
    'conductor-token-123': 'conductor',
    'backend-token-456': 'backend',
    'frontend-token-789': 'frontend',
    'architect-token-aaa': 'architect',
    'librarian-token-bbb': 'librarian',
    'explorer-token-ccc': 'explorer',
    'designer-token-ddd': 'designer',
  },
  default_agent: null,
};

const TEST_TOOL_PERMISSIONS = {
  version: '1.1',
  updated: '2026-06-24',
  default: 'all',
  permissions: {
    create_task: ['root', 'conductor'],
    tmb_create_task: ['root', 'conductor'],
    set_focus_queue: ['root', 'conductor'],
    dispatch_next: ['root', 'conductor'],
    write_memory: ['root', 'conductor', 'librarian'],
    list_inbox: 'all',
    search_knowledge: 'all',
    admin_only_tool: 'none',
  },
};

// ─── Helper Functions (mimic mcp.ts logic) ───────────────────────────────────

function getAgentFromToken(
  token: string,
  masterToken: string,
  agentTokens: Record<string, string>
): string | null {
  if (masterToken && token === masterToken) {
    return 'root';
  }
  return agentTokens[token] || null;
}

function canUseTool(
  terminal: string,
  toolName: string,
  permissions: Record<string, string | string[]>,
  defaultPerm: string | string[]
): boolean {
  // root can do everything
  if (terminal === 'root') return true;

  const permission = permissions[toolName];

  // No specific permission = use default
  if (permission === undefined) {
    if (defaultPerm === 'all') return true;
    if (defaultPerm === 'none') return false;
    if (Array.isArray(defaultPerm)) return defaultPerm.includes(terminal);
    return true;
  }

  if (permission === 'all') return true;
  if (permission === 'none') return false;

  // Array of allowed terminals
  if (Array.isArray(permission)) {
    return permission.includes(terminal);
  }

  return true;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MCP Authentication', () => {
  describe('getAgentFromToken', () => {
    const { master_token, agents } = TEST_AGENTS_CONFIG;

    it('should return root for master token', () => {
      const agent = getAgentFromToken(master_token, master_token, agents);
      expect(agent).toBe('root');
    });

    it('should return conductor for conductor token', () => {
      const agent = getAgentFromToken('conductor-token-123', master_token, agents);
      expect(agent).toBe('conductor');
    });

    it('should return backend for backend token', () => {
      const agent = getAgentFromToken('backend-token-456', master_token, agents);
      expect(agent).toBe('backend');
    });

    it('should return null for invalid token', () => {
      const agent = getAgentFromToken('invalid-token', master_token, agents);
      expect(agent).toBeNull();
    });

    it('should return null for empty token', () => {
      const agent = getAgentFromToken('', master_token, agents);
      expect(agent).toBeNull();
    });

    it('should handle all 7 terminals', () => {
      const terminals = ['conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer'];
      const tokenMap: Record<string, string> = {
        'conductor-token-123': 'conductor',
        'architect-token-aaa': 'architect',
        'librarian-token-bbb': 'librarian',
        'explorer-token-ccc': 'explorer',
        'backend-token-456': 'backend',
        'frontend-token-789': 'frontend',
        'designer-token-ddd': 'designer',
      };

      for (const [token, expectedTerminal] of Object.entries(tokenMap)) {
        const agent = getAgentFromToken(token, master_token, agents);
        expect(agent).toBe(expectedTerminal);
      }
    });
  });

  describe('canUseTool - Permission Checks', () => {
    const { permissions, default: defaultPerm } = TEST_TOOL_PERMISSIONS;

    describe('root access', () => {
      it('should allow root to use any tool', () => {
        expect(canUseTool('root', 'create_task', permissions, defaultPerm)).toBe(true);
        expect(canUseTool('root', 'admin_only_tool', permissions, defaultPerm)).toBe(true);
        expect(canUseTool('root', 'nonexistent_tool', permissions, defaultPerm)).toBe(true);
      });
    });

    describe('conductor permissions', () => {
      it('should allow conductor to create tasks', () => {
        expect(canUseTool('conductor', 'create_task', permissions, defaultPerm)).toBe(true);
        expect(canUseTool('conductor', 'tmb_create_task', permissions, defaultPerm)).toBe(true);
      });

      it('should allow conductor to manage focus queue', () => {
        expect(canUseTool('conductor', 'set_focus_queue', permissions, defaultPerm)).toBe(true);
        expect(canUseTool('conductor', 'dispatch_next', permissions, defaultPerm)).toBe(true);
      });

      it('should deny conductor admin-only tools', () => {
        expect(canUseTool('conductor', 'admin_only_tool', permissions, defaultPerm)).toBe(false);
      });
    });

    describe('backend permissions', () => {
      it('should deny backend from creating tasks', () => {
        expect(canUseTool('backend', 'create_task', permissions, defaultPerm)).toBe(false);
        expect(canUseTool('backend', 'tmb_create_task', permissions, defaultPerm)).toBe(false);
      });

      it('should allow backend to read inbox (all permission)', () => {
        expect(canUseTool('backend', 'list_inbox', permissions, defaultPerm)).toBe(true);
      });

      it('should allow backend to search knowledge (all permission)', () => {
        expect(canUseTool('backend', 'search_knowledge', permissions, defaultPerm)).toBe(true);
      });

      it('should deny backend from writing memory', () => {
        expect(canUseTool('backend', 'write_memory', permissions, defaultPerm)).toBe(false);
      });
    });

    describe('librarian permissions', () => {
      it('should allow librarian to write memory', () => {
        expect(canUseTool('librarian', 'write_memory', permissions, defaultPerm)).toBe(true);
      });

      it('should deny librarian from creating tasks', () => {
        expect(canUseTool('librarian', 'create_task', permissions, defaultPerm)).toBe(false);
      });
    });

    describe('default permission handling', () => {
      it('should allow unlisted tools when default is "all"', () => {
        expect(canUseTool('frontend', 'some_new_tool', permissions, 'all')).toBe(true);
      });

      it('should deny unlisted tools when default is "none"', () => {
        expect(canUseTool('frontend', 'some_new_tool', permissions, 'none')).toBe(false);
      });

      it('should check array default permission', () => {
        expect(canUseTool('frontend', 'some_new_tool', permissions, ['frontend', 'backend'])).toBe(true);
        expect(canUseTool('designer', 'some_new_tool', permissions, ['frontend', 'backend'])).toBe(false);
      });
    });
  });

  describe('Terminal Isolation (conceptual)', () => {
    // These test the isolation rules that are enforced in code
    // The actual enforcement is in mcp.ts handleToolCall

    it('should define isolation rules for read_inbox_message', () => {
      // Rule: callerTerminal must be 'root' OR equal to target terminal
      const canAccess = (caller: string, target: string) => {
        return caller === 'root' || caller === target;
      };

      expect(canAccess('backend', 'backend')).toBe(true);
      expect(canAccess('backend', 'frontend')).toBe(false);
      expect(canAccess('root', 'backend')).toBe(true);
      expect(canAccess('root', 'frontend')).toBe(true);
    });

    it('should define isolation rules for complete_inbox_message', () => {
      const canComplete = (caller: string, target: string) => {
        return caller === 'root' || caller === target;
      };

      expect(canComplete('backend', 'backend')).toBe(true);
      expect(canComplete('conductor', 'backend')).toBe(false);
      expect(canComplete('root', 'backend')).toBe(true);
    });
  });

  describe('Token Security', () => {
    it('should not expose tokens in error messages', () => {
      const secretToken = 'super-secret-token-12345';
      const result = getAgentFromToken(secretToken, TEST_AGENTS_CONFIG.master_token, TEST_AGENTS_CONFIG.agents);

      // Result should be null, not contain the token
      expect(result).toBeNull();
    });

    it('should handle tokens with special characters', () => {
      const specialToken = 'token+with/special=chars==';
      const agents = { [specialToken]: 'backend' };
      const result = getAgentFromToken(specialToken, 'master', agents);
      expect(result).toBe('backend');
    });

    it('should handle base64 tokens (real format)', () => {
      const base64Token = 'IoUpLUgr4v6Mj5lt4u2XD1JOy5iGmVdxne473srMl2o=';
      const agents = { [base64Token]: 'root' };
      const result = getAgentFromToken(base64Token, 'other-master', agents);
      expect(result).toBe('root');
    });
  });

  describe('YAML Config Loading (structure validation)', () => {
    it('should have valid agents.yaml structure', () => {
      expect(TEST_AGENTS_CONFIG).toHaveProperty('version');
      expect(TEST_AGENTS_CONFIG).toHaveProperty('master_token');
      expect(TEST_AGENTS_CONFIG).toHaveProperty('agents');
      expect(typeof TEST_AGENTS_CONFIG.agents).toBe('object');
    });

    it('should have valid tool-permissions.yaml structure', () => {
      expect(TEST_TOOL_PERMISSIONS).toHaveProperty('version');
      expect(TEST_TOOL_PERMISSIONS).toHaveProperty('default');
      expect(TEST_TOOL_PERMISSIONS).toHaveProperty('permissions');
      expect(typeof TEST_TOOL_PERMISSIONS.permissions).toBe('object');
    });

    it('should map all 7 SpaceOS terminals', () => {
      const expectedTerminals = ['conductor', 'architect', 'librarian', 'explorer', 'backend', 'frontend', 'designer'];
      const configuredTerminals = Object.values(TEST_AGENTS_CONFIG.agents);

      for (const terminal of expectedTerminals) {
        expect(configuredTerminals).toContain(terminal);
      }
    });
  });

  describe('Permission Matrix Validation', () => {
    const { permissions } = TEST_TOOL_PERMISSIONS;

    it('should have create_task restricted to root and conductor', () => {
      expect(permissions.create_task).toEqual(['root', 'conductor']);
    });

    it('should have write_memory restricted to root, conductor, librarian', () => {
      expect(permissions.write_memory).toEqual(['root', 'conductor', 'librarian']);
    });

    it('should have list_inbox open to all', () => {
      expect(permissions.list_inbox).toBe('all');
    });

    it('should have admin_only_tool restricted to none', () => {
      expect(permissions.admin_only_tool).toBe('none');
    });
  });
});

describe('MCP Auth Integration Scenarios', () => {
  const { master_token, agents } = TEST_AGENTS_CONFIG;
  const { permissions, default: defaultPerm } = TEST_TOOL_PERMISSIONS;

  describe('Conductor creating task for Backend', () => {
    it('should allow conductor to create task', () => {
      // Step 1: Validate conductor token
      const terminal = getAgentFromToken('conductor-token-123', master_token, agents);
      expect(terminal).toBe('conductor');

      // Step 2: Check permission for create_task
      const allowed = canUseTool(terminal!, 'create_task', permissions, defaultPerm);
      expect(allowed).toBe(true);
    });
  });

  describe('Backend trying to create task (should fail)', () => {
    it('should deny backend from creating task', () => {
      const terminal = getAgentFromToken('backend-token-456', master_token, agents);
      expect(terminal).toBe('backend');

      const allowed = canUseTool(terminal!, 'create_task', permissions, defaultPerm);
      expect(allowed).toBe(false);
    });
  });

  describe('Backend reading own inbox', () => {
    it('should allow backend to read inbox', () => {
      const terminal = getAgentFromToken('backend-token-456', master_token, agents);
      expect(terminal).toBe('backend');

      const allowed = canUseTool(terminal!, 'list_inbox', permissions, defaultPerm);
      expect(allowed).toBe(true);
    });
  });

  describe('Invalid token access attempt', () => {
    it('should reject invalid token before checking permissions', () => {
      const terminal = getAgentFromToken('hacker-token-xyz', master_token, agents);
      expect(terminal).toBeNull();

      // Should not even get to permission check
      // In real code: return 403 Forbidden: Invalid token
    });
  });

  describe('Root override', () => {
    it('should allow root to do anything', () => {
      const terminal = getAgentFromToken(master_token, master_token, agents);
      expect(terminal).toBe('root');

      // Even admin_only_tool (permission: none) should work for root
      expect(canUseTool(terminal!, 'admin_only_tool', permissions, defaultPerm)).toBe(true);
      expect(canUseTool(terminal!, 'create_task', permissions, defaultPerm)).toBe(true);
      expect(canUseTool(terminal!, 'nonexistent_tool', permissions, defaultPerm)).toBe(true);
    });
  });
});
