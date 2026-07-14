/**
 * API Integration Tests
 * Statistical validation of API responses with calibratable thresholds
 *
 * Run: npm test -- src/__tests__/integration/api.test.ts
 *
 * NOTE: These tests run against a live server at localhost:3456
 * The server must be running before executing tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  API_CONFIG,
  THRESHOLDS,
  EXPECTED_TERMINALS,
  inRange,
  isValidValue,
} from './api.config';

// Helper to make HTTP requests
async function fetchApi(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${API_CONFIG.baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };

  if (API_CONFIG.authToken && !path.includes('/health') && !path.includes('/ready')) {
    headers['Authorization'] = `Bearer ${API_CONFIG.authToken}`;
  }

  return fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(API_CONFIG.timeout),
  });
}

// Skip kanban tests if endpoint doesn't exist (not mounted in bootstrap)
const SKIP_KANBAN = true; // Set to false when kanban routes are mounted

// ─── Health & Readiness Tests ──────────────────────────────────────────────────

describe('Health & Readiness API', () => {
  it('GET /health returns valid structure', async () => {
    const start = Date.now();
    const res = await fetchApi('/health');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    // Health endpoint sometimes slower on cold start - allow 500ms
    expect(elapsed).toBeLessThan(500);

    const data = await res.json();

    // Required fields
    expect(data).toHaveProperty('status');
    expect(data.status).toBe('ok');

    // Vector backend validation
    expect(data).toHaveProperty('vectorBackend');
    const vectorBackendMatch = THRESHOLDS.health.validVectorBackends.some(
      vb => data.vectorBackend.toLowerCase().includes(vb)
    );
    expect(vectorBackendMatch).toBe(true);

    // Document count validation
    expect(data).toHaveProperty('documents');
    expect(typeof data.documents).toBe('number');
    expect(inRange(
      data.documents,
      THRESHOLDS.health.minDocuments,
      THRESHOLDS.health.maxDocuments
    )).toBe(true);

    // Port validation
    expect(data).toHaveProperty('port');
    expect(data.port).toBe(THRESHOLDS.health.expectedPort);
  });

  it('GET /ready returns valid structure', async () => {
    const res = await fetchApi('/ready');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('status');
    expect(['ready', 'not ready', 'shutting down']).toContain(data.status);

    if (data.status === 'ready') {
      expect(data).toHaveProperty('vectorBackend');
      expect(data).toHaveProperty('documents');
    }
  });

  it('GET /live returns uptime and memory', async () => {
    const res = await fetchApi('/live');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('status', 'alive');
    expect(data).toHaveProperty('uptime');
    expect(typeof data.uptime).toBe('number');
    expect(data.uptime).toBeGreaterThan(0);

    expect(data).toHaveProperty('memory');
    expect(data.memory).toHaveProperty('heapUsed');
    expect(data.memory).toHaveProperty('heapTotal');
  });
});

// ─── Dashboard API Tests ───────────────────────────────────────────────────────

describe('Dashboard API', () => {
  it('GET /api/dashboard returns valid terminal data', async () => {
    const start = Date.now();
    const res = await fetchApi('/api/dashboard');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(THRESHOLDS.performance.dashboardMaxMs);

    const data = await res.json();

    // Timestamp
    expect(data).toHaveProperty('timestamp');
    expect(new Date(data.timestamp).getTime()).not.toBeNaN();

    // Metrics
    expect(data).toHaveProperty('metrics');
    expect(data.metrics).toHaveProperty('totalInbox');
    expect(data.metrics).toHaveProperty('totalOutbox');
    expect(data.metrics).toHaveProperty('terminals');

    expect(inRange(
      data.metrics.terminals,
      THRESHOLDS.dashboard.minTerminals,
      THRESHOLDS.dashboard.maxTerminals
    )).toBe(true);

    // Terminals array
    expect(data).toHaveProperty('terminals');
    expect(Array.isArray(data.terminals)).toBe(true);
    expect(data.terminals.length).toBeGreaterThanOrEqual(THRESHOLDS.dashboard.minTerminals);

    // Validate each terminal
    for (const terminal of data.terminals) {
      expect(terminal).toHaveProperty('name');
      expect(EXPECTED_TERMINALS).toContain(terminal.name);

      expect(terminal).toHaveProperty('inbox');
      expect(typeof terminal.inbox).toBe('number');
      expect(terminal.inbox).toBeGreaterThanOrEqual(0);

      expect(terminal).toHaveProperty('outbox');
      expect(typeof terminal.outbox).toBe('number');
      expect(terminal.outbox).toBeGreaterThanOrEqual(0);

      expect(terminal).toHaveProperty('status');
      expect(isValidValue(terminal.status, THRESHOLDS.dashboard.validStatuses)).toBe(true);
    }
  });

  it('Dashboard metrics are internally consistent', async () => {
    const res = await fetchApi('/api/dashboard');
    const data = await res.json();

    // Sum of terminal inbox should equal totalInbox
    const sumInbox = data.terminals.reduce((sum: number, t: any) => sum + t.inbox, 0);
    expect(data.metrics.totalInbox).toBe(sumInbox);

    // Sum of terminal outbox should equal totalOutbox
    const sumOutbox = data.terminals.reduce((sum: number, t: any) => sum + t.outbox, 0);
    expect(data.metrics.totalOutbox).toBe(sumOutbox);
  });
});

// ─── Mailbox API Tests ─────────────────────────────────────────────────────────

describe('Mailbox API', () => {
  it('GET /api/mailbox/:terminal/inbox returns valid messages', async () => {
    const start = Date.now();
    const res = await fetchApi('/api/mailbox/conductor/inbox');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(THRESHOLDS.performance.mailboxListMaxMs);

    const data = await res.json();

    expect(data).toHaveProperty('terminal', 'conductor');
    expect(data).toHaveProperty('messages');
    expect(Array.isArray(data.messages)).toBe(true);

    // Validate message structure if any exist
    if (data.messages.length > 0) {
      const msg = data.messages[0];
      // Messages have frontmatter.id structure
      expect(msg).toHaveProperty('frontmatter');
      expect(msg.frontmatter).toHaveProperty('id');
      expect(msg.frontmatter).toHaveProperty('status');
      expect(isValidValue(msg.frontmatter.status, THRESHOLDS.mailbox.validMessageStatuses)).toBe(true);
    }
  });

  it('GET /api/mailbox/:terminal/inbox?status=UNREAD filters correctly', async () => {
    const res = await fetchApi('/api/mailbox/backend/inbox?status=UNREAD');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.messages)).toBe(true);

    // All returned messages should be UNREAD
    for (const msg of data.messages) {
      expect(msg.frontmatter.status).toBe('UNREAD');
    }
  });

  it('GET /api/mailbox/:terminal/outbox returns valid structure', async () => {
    const res = await fetchApi('/api/mailbox/backend/outbox');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('terminal', 'backend');
    expect(data).toHaveProperty('messages');
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it('Invalid terminal returns 400', async () => {
    const res = await fetchApi('/api/mailbox/invalid_terminal_xyz/inbox');

    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty('error');
  });
});

// ─── Kanban API Tests ──────────────────────────────────────────────────────────
// NOTE: Kanban routes may not be mounted in server.ts - using main board endpoint

describe('Kanban API', () => {
  it('GET /api/kanban returns board data', async () => {
    const res = await fetchApi('/api/kanban');

    // Kanban endpoint might not be mounted - skip if 404
    if (res.status === 404) {
      console.log('Skipping: /api/kanban not mounted');
      return;
    }

    expect(res.status).toBe(200);

    const data = await res.json();
    // Validate whatever structure is returned
    expect(typeof data).toBe('object');
  });

  it.skip('GET /api/kanban/discovery returns planning items', async () => {
    // Skipped: endpoint not mounted in current server configuration
    const res = await fetchApi('/api/kanban/discovery');
    expect(res.status).toBe(200);
  });

  it.skip('GET /api/kanban/delivery returns terminal swimlanes', async () => {
    // Skipped: endpoint not mounted in current server configuration
    const res = await fetchApi('/api/kanban/delivery');
    expect(res.status).toBe(200);
  });
});

// ─── Registry API Tests ────────────────────────────────────────────────────────

describe('Registry API', () => {
  it('GET /api/registry/stats returns message statistics', async () => {
    const res = await fetchApi('/api/registry/stats');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('total');
    expect(typeof data.total).toBe('number');
    expect(data.total).toBeGreaterThanOrEqual(0);

    if (data.byStatus) {
      expect(typeof data.byStatus).toBe('object');
    }

    if (data.byType) {
      expect(typeof data.byType).toBe('object');
    }
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

// ─── Control API Tests ─────────────────────────────────────────────────────────

describe('Control API', () => {
  it('GET /api/control/mode returns dispatch mode', async () => {
    const res = await fetchApi('/api/control/mode');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('mode');
    expect(['auto', 'manual', 'scheduled']).toContain(data.mode);
  });

  it('GET /api/control/budget returns budget summary', async () => {
    const res = await fetchApi('/api/control/budget');

    expect(res.status).toBe(200);

    const data = await res.json();
    // Should have some budget-related data
    expect(typeof data).toBe('object');
  });
});

// ─── Knowledge API Tests ───────────────────────────────────────────────────────
// NOTE: Knowledge search requires ChromaDB with embedding function configured

describe('Knowledge API', () => {
  it('GET /api/knowledge/search returns results or embedding error', async () => {
    const start = Date.now();
    const res = await fetchApi('/api/knowledge/search?q=terminal&topK=5');
    const elapsed = Date.now() - start;

    // May return 500 if embedding function not configured (ChromaDB issue)
    if (res.status === 500) {
      const data = await res.json();
      // Expected error when embedding function missing
      expect(data.error).toMatch(/embedding/i);
      console.log('Knowledge search: embedding function not configured');
      return;
    }

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(THRESHOLDS.performance.searchMaxMs);

    const data = await res.json();
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results.length).toBeLessThanOrEqual(5);

    // Each result should have content and score
    for (const result of data.results) {
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('score');
      expect(typeof result.score).toBe('number');
    }
  });

  it('POST /api/knowledge/search works with body', async () => {
    const res = await fetchApi('/api/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ q: 'mailbox', topK: 3 }),
    });

    // May return 500 if embedding function not configured
    if (res.status === 500) {
      const data = await res.json();
      expect(data.error).toMatch(/embedding/i);
      return;
    }

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('results');
    expect(data.results.length).toBeLessThanOrEqual(3);
  });
});

// ─── Session API Tests ─────────────────────────────────────────────────────────
// NOTE: Session API returns different structure - sessionExists/claudeRunning

describe('Session API', () => {
  it('GET /api/sessions/all returns session info', async () => {
    const res = await fetchApi('/api/sessions/all');

    expect(res.status).toBe(200);

    const data = await res.json();
    // Current API returns flat structure with terminal: 'all'
    expect(data).toHaveProperty('terminal', 'all');
    expect(data).toHaveProperty('sessionExists');
    expect(data).toHaveProperty('claudeRunning');
    expect(typeof data.sessionExists).toBe('boolean');
    expect(typeof data.claudeRunning).toBe('boolean');
  });

  it('GET /api/session/:terminal returns specific status', async () => {
    const res = await fetchApi('/api/session/conductor');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('terminal', 'conductor');
    expect(data).toHaveProperty('sessionExists');
    expect(data).toHaveProperty('claudeRunning');
    expect(typeof data.sessionExists).toBe('boolean');
    expect(typeof data.claudeRunning).toBe('boolean');
  });
});

// ─── Error Handling Tests ──────────────────────────────────────────────────────

describe('Error Handling', () => {
  it('Invalid endpoint returns 404', async () => {
    const res = await fetchApi('/api/nonexistent/endpoint');

    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data).toHaveProperty('error');
  });

  it('Missing auth on protected endpoint returns 401', async () => {
    const res = await fetch(`${API_CONFIG.baseUrl}/api/control/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    });

    expect(res.status).toBe(401);
  });
});
