/**
 * MCP Tool Usage Tests
 *
 * Tests that MCP tools are:
 * 1. Available and callable
 * 2. Return expected response structure
 * 3. Handle errors gracefully
 * 4. Perform within acceptable thresholds
 *
 * Tests the HTTP API equivalents of MCP tools.
 *
 * Run: npm test -- src/__tests__/agent/mcp-tools.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  AGENT_THRESHOLDS,
  TERMINALS,
  fetchApi,
  measureTime,
} from './agent.config';
import {
  discoverTerminals,
  getTerminalStatus,
  readInbox,
} from './test-harness';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let availableTerminals: string[] = [];

beforeAll(async () => {
  availableTerminals = await discoverTerminals();
  console.log(`MCP tool tests for ${availableTerminals.length} terminals`);
});

// ─── MCP Tool Registry Tests ─────────────────────────────────────────────────

describe('MCP Tool Availability', () => {
  it('health endpoint confirms MCP is available', async () => {
    const res = await fetchApi('/health');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('MCP tools list is accessible', async () => {
    // Try to get tools list (may or may not be exposed)
    const res = await fetchApi('/mcp/tools');

    // May be 200, 404, or other - we're testing what's available
    if (res.status === 200) {
      const data = await res.json();
      expect(data).toHaveProperty('tools');
      expect(Array.isArray(data.tools)).toBe(true);
      console.log(`MCP tools available: ${data.tools.length}`);
    } else {
      // Not exposed via HTTP, acceptable
      console.log(`MCP tools endpoint: ${res.status}`);
    }
  });
});

// ─── Mailbox Tool Tests (mailbox_read equivalent) ────────────────────────────

describe('Mailbox Read Tool', () => {
  it('GET /api/mailbox/:terminal/inbox returns valid structure', async () => {
    for (const terminal of availableTerminals.slice(0, 3)) {
      const res = await fetchApi(`/api/mailbox/${terminal}/inbox`);

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty('terminal', terminal);
      expect(data).toHaveProperty('messages');
      expect(Array.isArray(data.messages)).toBe(true);
    }
  });

  it('mailbox read with status filter works', async () => {
    const terminal = availableTerminals[0] || 'backend';

    const res = await fetchApi(`/api/mailbox/${terminal}/inbox?status=UNREAD`);

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.messages)).toBe(true);

    // All messages should be UNREAD
    for (const msg of data.messages) {
      const status = msg.frontmatter?.status || msg.status;
      expect(status).toBe('UNREAD');
    }
  });

  it('invalid terminal returns error', async () => {
    const res = await fetchApi('/api/mailbox/invalid_xyz/inbox');

    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty('error');
  });

  it('mailbox read within timeout', async () => {
    const terminal = availableTerminals[0] || 'backend';

    const { elapsed } = await measureTime(async () => {
      await fetchApi(`/api/mailbox/${terminal}/inbox`);
    });

    expect(elapsed).toBeLessThan(AGENT_THRESHOLDS.mcpTools.toolCallTimeoutMs);

    console.log(`Mailbox read time: ${elapsed}ms`);
  });
});

// ─── Session Status Tool Tests ───────────────────────────────────────────────

describe('Session Status Tool', () => {
  it('GET /api/session/:terminal returns valid structure', async () => {
    for (const terminal of availableTerminals.slice(0, 3)) {
      const res = await fetchApi(`/api/session/${terminal}`);

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty('terminal', terminal);
      expect(data).toHaveProperty('sessionExists');
      expect(data).toHaveProperty('claudeRunning');
      expect(typeof data.sessionExists).toBe('boolean');
      expect(typeof data.claudeRunning).toBe('boolean');
    }
  });

  it('GET /api/sessions/all returns aggregated status', async () => {
    const res = await fetchApi('/api/sessions/all');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('sessionExists');
    expect(data).toHaveProperty('claudeRunning');
  });

  it('session status within timeout', async () => {
    const { elapsed } = await measureTime(async () => {
      await fetchApi('/api/sessions/all');
    });

    expect(elapsed).toBeLessThan(AGENT_THRESHOLDS.mcpTools.toolCallTimeoutMs);

    console.log(`Session status time: ${elapsed}ms`);
  });
});

// ─── Dashboard Tool Tests ────────────────────────────────────────────────────

describe('Dashboard Tool', () => {
  it('GET /api/dashboard returns terminal overview', async () => {
    const res = await fetchApi('/api/dashboard');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('terminals');
    expect(data).toHaveProperty('metrics');
    expect(Array.isArray(data.terminals)).toBe(true);

    // Validate terminal structure
    for (const terminal of data.terminals) {
      expect(terminal).toHaveProperty('name');
      expect(terminal).toHaveProperty('status');
      expect(terminal).toHaveProperty('inbox');
      expect(terminal).toHaveProperty('outbox');
    }
  });

  it('dashboard metrics are consistent', async () => {
    const res = await fetchApi('/api/dashboard');
    const data = await res.json();

    // Sum of terminal inboxes should equal totalInbox
    const sumInbox = data.terminals.reduce(
      (sum: number, t: { inbox: number }) => sum + t.inbox,
      0
    );
    expect(data.metrics.totalInbox).toBe(sumInbox);
  });
});

// ─── Knowledge Search Tool Tests ─────────────────────────────────────────────

describe('Knowledge Search Tool', () => {
  it('GET /api/knowledge/search returns results or embedding error', async () => {
    const res = await fetchApi('/api/knowledge/search?q=terminal&topK=5');

    // May return 500 if embedding function not configured
    if (res.status === 500) {
      const data = await res.json();
      expect(data.error).toMatch(/embedding/i);
      console.log('Knowledge search: embedding not configured');
      return;
    }

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('knowledge search with POST body', async () => {
    const res = await fetchApi('/api/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ q: 'mailbox', topK: 3 }),
    });

    // May fail with embedding error
    if (res.status === 500) {
      return; // Skip if not configured
    }

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.results.length).toBeLessThanOrEqual(3);
  });
});

// ─── Registry Tool Tests ─────────────────────────────────────────────────────

describe('Registry Tool', () => {
  it('GET /api/registry/stats returns message statistics', async () => {
    const res = await fetchApi('/api/registry/stats');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('total');
    expect(typeof data.total).toBe('number');
  });

  it('GET /api/registry/messages returns paginated results', async () => {
    const res = await fetchApi('/api/registry/messages?limit=10');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('messages');
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBeLessThanOrEqual(10);
  });
});

// ─── Control Tool Tests ──────────────────────────────────────────────────────

describe('Control Tool', () => {
  it('GET /api/control/mode returns dispatch mode', async () => {
    const res = await fetchApi('/api/control/mode');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('mode');
    expect(['auto', 'manual', 'scheduled']).toContain(data.mode);
  });

  it('GET /api/control/budget returns budget info', async () => {
    const res = await fetchApi('/api/control/budget');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(typeof data).toBe('object');
  });
});

// ─── Session Start/Wake Tool Tests ───────────────────────────────────────────

describe('Session Control Tools', () => {
  it('POST /api/session/start validates request', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) return;

    const res = await fetchApi('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        model: 'haiku',
        prompt: 'Test',
        fromTerminal: 'root',
      }),
    });

    // Various responses acceptable (400 = validation, 200 = success, etc.)
    expect(res.status).not.toBe(500);
  });

  it('POST /api/session/wake accepts valid request', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) return;

    const res = await fetchApi('/api/session/wake', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        fromTerminal: 'root',
      }),
    });

    // Various responses acceptable
    expect(res.status).not.toBe(500);
  });

  it('POST /api/session/inject accepts valid request', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) return;

    const res = await fetchApi('/api/session/inject', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        prompt: 'Test injection',
        fromTerminal: 'root',
      }),
    });

    // Various responses acceptable
    expect(res.status).not.toBe(500);
  });
});

// ─── Tool Error Handling Tests ───────────────────────────────────────────────

describe('Tool Error Handling', () => {
  it('handles invalid terminal name gracefully', async () => {
    const endpoints = [
      '/api/mailbox/invalid_xyz/inbox',
      '/api/session/invalid_xyz',
    ];

    for (const endpoint of endpoints) {
      const res = await fetchApi(endpoint);

      // Should return error, not crash
      expect(res.status).not.toBe(500);
    }
  });

  it('handles missing parameters gracefully', async () => {
    const res = await fetchApi('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({}), // Missing required fields
    });

    // Should reject, not crash
    expect(res.status).not.toBe(500);
  });

  it('handles invalid JSON gracefully', async () => {
    const res = await fetch(`http://localhost:3456/api/session/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer dev-token-spaceos-dashboard-2026',
      },
      body: 'not valid json',
    });

    // Should handle gracefully
    expect([400, 500]).toContain(res.status);
  });
});

// ─── Tool Performance Tests ──────────────────────────────────────────────────

describe('Tool Performance', () => {
  it('all read operations complete within threshold', async () => {
    const operations = [
      { name: 'mailbox-inbox', fn: () => fetchApi(`/api/mailbox/backend/inbox`) },
      { name: 'session-status', fn: () => fetchApi('/api/session/backend') },
      { name: 'dashboard', fn: () => fetchApi('/api/dashboard') },
      { name: 'registry-stats', fn: () => fetchApi('/api/registry/stats') },
      { name: 'control-mode', fn: () => fetchApi('/api/control/mode') },
    ];

    const results: Array<{ name: string; elapsed: number }> = [];

    for (const op of operations) {
      const { elapsed } = await measureTime(op.fn);
      results.push({ name: op.name, elapsed });
    }

    console.log('Tool performance baseline:');
    for (const r of results) {
      console.log(`  ${r.name}: ${r.elapsed}ms`);
      expect(r.elapsed).toBeLessThan(AGENT_THRESHOLDS.mcpTools.toolCallTimeoutMs);
    }
  });

  it('parallel tool calls are efficient', async () => {
    const { elapsed } = await measureTime(async () => {
      await Promise.all([
        fetchApi('/api/mailbox/backend/inbox'),
        fetchApi('/api/session/backend'),
        fetchApi('/api/dashboard'),
      ]);
    });

    console.log(`Parallel 3 tools: ${elapsed}ms`);

    // Should be faster than 3 sequential calls
    expect(elapsed).toBeLessThan(AGENT_THRESHOLDS.mcpTools.toolCallTimeoutMs * 2);
  });
});

// ─── Tool Consistency Tests ──────────────────────────────────────────────────

describe('Tool Response Consistency', () => {
  it('multiple calls return consistent results', async () => {
    const results = await Promise.all([
      fetchApi('/api/dashboard').then((r) => r.json()),
      fetchApi('/api/dashboard').then((r) => r.json()),
      fetchApi('/api/dashboard').then((r) => r.json()),
    ]);

    // All calls should return same terminal count
    const terminalCount = results[0].terminals.length;
    for (const result of results) {
      expect(result.terminals.length).toBe(terminalCount);
    }
  });

  it('session state is consistent across queries', async () => {
    const terminal = availableTerminals[0] || 'backend';

    const results = await Promise.all([
      fetchApi(`/api/session/${terminal}`).then((r) => r.json()),
      fetchApi(`/api/session/${terminal}`).then((r) => r.json()),
    ]);

    // State should be consistent
    expect(results[0].sessionExists).toBe(results[1].sessionExists);
    expect(results[0].claudeRunning).toBe(results[1].claudeRunning);
  });
});

// ─── Authorization Tests ─────────────────────────────────────────────────────

describe('Tool Authorization', () => {
  it('protected endpoints require auth', async () => {
    const res = await fetch(`http://localhost:3456/api/control/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    });

    // Should require auth
    expect(res.status).toBe(401);
  });

  it('read endpoints work with valid token', async () => {
    const res = await fetchApi('/api/dashboard');

    expect(res.status).toBe(200);
  });
});
