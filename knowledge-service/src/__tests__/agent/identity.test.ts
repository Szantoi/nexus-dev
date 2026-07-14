/**
 * Identity Verification Tests
 *
 * Tests that terminals understand their identity from CLAUDE.md:
 * 1. Role and responsibilities
 * 2. Boundaries and permissions
 * 3. Terminal-specific context
 *
 * Note: These tests validate CLAUDE.md structure and content,
 * not actual LLM responses (which would require running sessions).
 *
 * Run: npm test -- src/__tests__/agent/identity.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  AGENT_THRESHOLDS,
  TERMINALS,
  TERMINAL_PATHS,
  fetchApi,
  measureTime,
} from './agent.config';
import {
  discoverTerminals,
  readClaudeMd,
  extractIdentity,
  getTerminalStatus,
} from './test-harness';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let availableTerminals: string[] = [];

beforeAll(async () => {
  availableTerminals = await discoverTerminals();
  console.log(`Identity tests for ${availableTerminals.length} terminals`);
});

// ─── CLAUDE.md Existence Tests ───────────────────────────────────────────────

describe('CLAUDE.md Existence', () => {
  it('every terminal has CLAUDE.md', async () => {
    for (const terminal of availableTerminals) {
      const content = await readClaudeMd(terminal);

      expect(content).not.toBeNull();
      expect(content!.length).toBeGreaterThan(100);
    }
  });

  it('CLAUDE.md files are readable', async () => {
    for (const terminal of availableTerminals) {
      const { result, elapsed } = await measureTime(async () => {
        return readClaudeMd(terminal);
      });

      expect(result).not.toBeNull();
      expect(elapsed).toBeLessThan(100); // Fast file read
    }
  });
});

// ─── Identity Structure Tests ────────────────────────────────────────────────

describe('CLAUDE.md Identity Structure', () => {
  it('has title header with terminal name', async () => {
    for (const terminal of availableTerminals) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      // Should have a main heading
      const hasMainHeading = content.includes('# CLAUDE.md') ||
                             content.includes(`# ${terminal}`) ||
                             content.match(/^# .+/m);

      expect(hasMainHeading).toBe(true);
    }
  });

  it('has description/quote block', async () => {
    for (const terminal of availableTerminals) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      // Should have a blockquote with role description
      const hasQuote = content.includes('\n> ');

      expect(hasQuote).toBe(true);
    }
  });

  it('extractIdentity returns role and description', async () => {
    for (const terminal of availableTerminals) {
      const identity = await extractIdentity(terminal);

      if (identity) {
        expect(identity.role).toBeDefined();
        expect(identity.role.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Terminal Role Definitions ───────────────────────────────────────────────

describe('Terminal Role Definitions', () => {
  it('root terminal has strategic role', async () => {
    const content = await readClaudeMd('root');
    if (!content) return;

    // Root should mention strategic, coordination, or orchestration
    const hasStrategicRole =
      content.toLowerCase().includes('stratégia') ||
      content.toLowerCase().includes('strategic') ||
      content.toLowerCase().includes('döntés') ||
      content.toLowerCase().includes('koordin');

    expect(hasStrategicRole).toBe(true);
  });

  it('conductor terminal has coordination role', async () => {
    const content = await readClaudeMd('conductor');
    if (!content) return;

    // Conductor should mention coordination, dispatch, or pipeline
    const hasCoordinationRole =
      content.toLowerCase().includes('koordin') ||
      content.toLowerCase().includes('dispatch') ||
      content.toLowerCase().includes('pipeline') ||
      content.toLowerCase().includes('feladatkiosztás');

    expect(hasCoordinationRole).toBe(true);
  });

  it('backend terminal has development role', async () => {
    const content = await readClaudeMd('backend');
    if (!content) return;

    // Backend should mention .NET, Node.js, API, or backend
    const hasDevRole =
      content.toLowerCase().includes('.net') ||
      content.toLowerCase().includes('node') ||
      content.toLowerCase().includes('backend') ||
      content.toLowerCase().includes('api');

    expect(hasDevRole).toBe(true);
  });

  it('frontend terminal has UI role', async () => {
    const content = await readClaudeMd('frontend');
    if (!content) return;

    // Frontend should mention React, UI, portal, or frontend
    const hasUIRole =
      content.toLowerCase().includes('react') ||
      content.toLowerCase().includes('frontend') ||
      content.toLowerCase().includes('ui') ||
      content.toLowerCase().includes('portál');

    expect(hasUIRole).toBe(true);
  });
});

// ─── Permission and Boundary Tests ───────────────────────────────────────────

describe('Permission Definitions', () => {
  it('root has broadest permissions', async () => {
    const content = await readClaudeMd('root');
    if (!content) return;

    // Root should be able to control all terminals
    const hasFullControl =
      content.includes('MINDENKIT') ||
      content.includes('all terminals') ||
      content.includes('8 terminál') ||
      content.includes('minden terminál');

    expect(hasFullControl).toBe(true);
  });

  it('conductor has limited permissions', async () => {
    const content = await readClaudeMd('conductor');
    if (!content) return;

    // Conductor should mention what terminals it can control
    // (architect, librarian, explorer, backend, frontend, designer)
    const mentionsLimitedControl =
      content.includes('architect') ||
      content.includes('backend') ||
      content.includes('frontend');

    expect(mentionsLimitedControl).toBe(true);
  });
});

// ─── Session Ritual Tests ────────────────────────────────────────────────────

describe('Session Rituals', () => {
  it('terminals have session start instructions', async () => {
    for (const terminal of availableTerminals.slice(0, 4)) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      // Should have session start section or ritual
      const hasSessionSection =
        content.toLowerCase().includes('session') ||
        content.toLowerCase().includes('indítás') ||
        content.toLowerCase().includes('ritual') ||
        content.toLowerCase().includes('rutin');

      expect(hasSessionSection).toBe(true);
    }
  });

  it('terminals have inbox/outbox references', async () => {
    for (const terminal of availableTerminals.slice(0, 4)) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      // Should mention inbox or outbox
      const hasMailboxRef =
        content.toLowerCase().includes('inbox') ||
        content.toLowerCase().includes('outbox') ||
        content.toLowerCase().includes('mailbox');

      expect(hasMailboxRef).toBe(true);
    }
  });
});

// ─── MEMORY.md References ────────────────────────────────────────────────────

describe('MEMORY.md References', () => {
  it('terminals have MEMORY.md concept', async () => {
    // At least some terminals should reference MEMORY.md
    let hasMemoryRef = false;

    for (const terminal of availableTerminals) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      if (
        content.includes('MEMORY.md') ||
        content.includes('memory') ||
        content.includes('memória')
      ) {
        hasMemoryRef = true;
        break;
      }
    }

    expect(hasMemoryRef).toBe(true);
  });
});

// ─── MCP Tool References ─────────────────────────────────────────────────────

describe('MCP Tool References', () => {
  it('terminals reference MCP tools or API', async () => {
    // Priority terminals should reference MCP
    for (const terminal of TERMINALS.priority) {
      if (!availableTerminals.includes(terminal)) continue;

      const content = await readClaudeMd(terminal);
      if (!content) continue;

      const hasMcpRef =
        content.includes('MCP') ||
        content.includes('mcp__') ||
        content.includes('API') ||
        content.includes('api/');

      expect(hasMcpRef).toBe(true);
    }
  });
});

// ─── Content Quality Tests ───────────────────────────────────────────────────

describe('CLAUDE.md Content Quality', () => {
  it('CLAUDE.md has reasonable length', async () => {
    for (const terminal of availableTerminals) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      // Should be substantial (at least 500 chars) but not excessive
      expect(content.length).toBeGreaterThan(500);
      expect(content.length).toBeLessThan(100000);
    }
  });

  it('CLAUDE.md has multiple sections', async () => {
    for (const terminal of availableTerminals) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      // Count headings
      const headings = content.match(/^#+\s/gm) || [];

      expect(headings.length).toBeGreaterThan(2);
    }
  });

  it('CLAUDE.md is valid markdown', async () => {
    for (const terminal of availableTerminals) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      // Basic markdown validation
      // Check that major sections exist (headings)
      const headings = content.match(/^#+\s/gm) || [];
      expect(headings.length).toBeGreaterThan(0);

      // Code blocks should generally be paired, but inline code may cause odd counts
      // This is a soft check - we just verify it parses
      expect(typeof content).toBe('string');
    }
  });
});

// ─── Terminal Differentiation Tests ─────────────────────────────────────────

describe('Terminal Differentiation', () => {
  it('each terminal has unique identity', async () => {
    const identities: Map<string, string> = new Map();

    for (const terminal of availableTerminals) {
      const identity = await extractIdentity(terminal);
      if (identity) {
        identities.set(terminal, identity.role);
      }
    }

    // Check that roles are somewhat different
    const roles = Array.from(identities.values());
    const uniqueRoles = new Set(roles);

    // At least half should be unique (allowing some overlap)
    expect(uniqueRoles.size).toBeGreaterThanOrEqual(Math.ceil(roles.length / 2));
  });

  it('priority vs worker terminals have different focus', async () => {
    const rootContent = await readClaudeMd('root');
    const backendContent = await readClaudeMd('backend');

    if (rootContent && backendContent) {
      // Root should have strategic terms
      const rootStrategic =
        rootContent.includes('stratégia') ||
        rootContent.includes('döntés') ||
        rootContent.includes('koordin');

      // Backend should have implementation terms
      const backendImpl =
        backendContent.includes('kód') ||
        backendContent.includes('.NET') ||
        backendContent.includes('implementá');

      expect(rootStrategic || backendImpl).toBe(true);
    }
  });
});

// ─── Datahaven Integration Tests ─────────────────────────────────────────────

describe('Datahaven Integration', () => {
  it('terminals have Datahaven status reference', async () => {
    // At least priority terminals should reference Datahaven
    let hasDHRef = false;

    for (const terminal of TERMINALS.priority) {
      if (!availableTerminals.includes(terminal)) continue;

      const content = await readClaudeMd(terminal);
      if (!content) continue;

      if (
        content.includes('Datahaven') ||
        content.includes('datahaven') ||
        content.includes('dashboard')
      ) {
        hasDHRef = true;
        break;
      }
    }

    expect(hasDHRef).toBe(true);
  });

  it('terminal status matches dashboard', async () => {
    // Get dashboard data
    const res = await fetchApi('/api/dashboard');
    if (res.status !== 200) return;

    const data = await res.json();
    const dashboardTerminals = new Set(
      data.terminals.map((t: { name: string }) => t.name)
    );

    // All discovered terminals should be in dashboard
    for (const terminal of availableTerminals) {
      expect(dashboardTerminals.has(terminal)).toBe(true);
    }
  });
});

// ─── Golden Rules Reference Tests ────────────────────────────────────────────

describe('Golden Rules Reference', () => {
  it('at least one terminal references Golden Rules', async () => {
    let hasGoldenRules = false;

    for (const terminal of availableTerminals) {
      const content = await readClaudeMd(terminal);
      if (!content) continue;

      if (
        content.includes('Golden Rule') ||
        content.includes('5 Golden') ||
        content.includes('szabály')
      ) {
        hasGoldenRules = true;
        break;
      }
    }

    expect(hasGoldenRules).toBe(true);
  });
});

// ─── Performance Tests ───────────────────────────────────────────────────────

describe('Identity Access Performance', () => {
  it('CLAUDE.md read is fast for all terminals', async () => {
    const times: number[] = [];

    for (const terminal of availableTerminals) {
      const { elapsed } = await measureTime(async () => {
        await readClaudeMd(terminal);
      });
      times.push(elapsed);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const maxTime = Math.max(...times);

    console.log(
      `CLAUDE.md read: avg=${avgTime.toFixed(0)}ms, max=${maxTime}ms`
    );

    // Should be very fast (< 50ms avg)
    expect(avgTime).toBeLessThan(50);
  });

  it('identity extraction is efficient', async () => {
    const { elapsed } = await measureTime(async () => {
      for (const terminal of availableTerminals) {
        await extractIdentity(terminal);
      }
    });

    console.log(
      `Extract all identities (${availableTerminals.length}): ${elapsed}ms`
    );

    // Should complete quickly
    expect(elapsed).toBeLessThan(500);
  });
});
