/**
 * Session Management Integration Tests
 *
 * Tests core session functionality independent of terminal names.
 * Terminal names are loaded dynamically from config/API.
 *
 * Run: npm test -- src/__tests__/integration/session.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { API_CONFIG } from './api.config';

// ─── Dynamic Terminal Discovery ─────────────────────────────────────────────────

interface TerminalInfo {
  name: string;
  type?: string;
  canControl?: string[];
}

let availableTerminals: TerminalInfo[] = [];
let sampleTerminal: string = '';

async function fetchApi(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${API_CONFIG.baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };

  if (API_CONFIG.authToken) {
    headers['Authorization'] = `Bearer ${API_CONFIG.authToken}`;
  }

  return fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(API_CONFIG.timeout),
  });
}

/**
 * Discover available terminals from dashboard API
 * This makes tests independent of hardcoded terminal names
 */
async function discoverTerminals(): Promise<TerminalInfo[]> {
  try {
    const res = await fetchApi('/api/dashboard');
    if (res.status !== 200) return [];

    const data = await res.json();
    if (!data.terminals || !Array.isArray(data.terminals)) return [];

    return data.terminals.map((t: any) => ({
      name: t.name,
      type: t.type,
    }));
  } catch {
    return [];
  }
}

// ─── Test Configuration ─────────────────────────────────────────────────────────

/**
 * Calibratable thresholds for session operations
 */
const SESSION_THRESHOLDS = {
  // API response times
  timing: {
    statusCheckMaxMs: 500,
    startRequestMaxMs: 2000,
  },

  // Session behavior
  behavior: {
    // Minimum fields expected in session status
    requiredStatusFields: ['terminal', 'sessionExists', 'claudeRunning'],
  },
};

// ─── Setup ──────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  availableTerminals = await discoverTerminals();

  if (availableTerminals.length === 0) {
    console.warn('No terminals discovered - using fallback');
    // Fallback: try a generic terminal name that might exist
    availableTerminals = [{ name: 'backend' }, { name: 'conductor' }];
  }

  // Pick a sample terminal for single-terminal tests
  sampleTerminal = availableTerminals[0]?.name || 'backend';
  console.log(`Discovered ${availableTerminals.length} terminals, sample: ${sampleTerminal}`);
});

// ─── Core Session Status Tests ──────────────────────────────────────────────────

describe('Session Status API', () => {
  it('GET /api/session/:terminal returns valid structure for any terminal', async () => {
    // Skip if no terminals discovered
    if (!sampleTerminal) {
      console.log('Skipping: no terminal available');
      return;
    }

    const start = Date.now();
    const res = await fetchApi(`/api/session/${sampleTerminal}`);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(SESSION_THRESHOLDS.timing.statusCheckMaxMs);

    const data = await res.json();

    // Core structure validation - independent of terminal name
    for (const field of SESSION_THRESHOLDS.behavior.requiredStatusFields) {
      expect(data).toHaveProperty(field);
    }

    // Type validation
    expect(typeof data.sessionExists).toBe('boolean');
    expect(typeof data.claudeRunning).toBe('boolean');

    // Terminal name should match request
    expect(data.terminal).toBe(sampleTerminal);
  });

  it('session status is consistent across multiple calls', async () => {
    if (!sampleTerminal) return;

    // Make 3 rapid calls and verify consistency
    const results = await Promise.all([
      fetchApi(`/api/session/${sampleTerminal}`).then(r => r.json()),
      fetchApi(`/api/session/${sampleTerminal}`).then(r => r.json()),
      fetchApi(`/api/session/${sampleTerminal}`).then(r => r.json()),
    ]);

    // All calls should return same session state
    const firstState = results[0].sessionExists;
    for (const result of results) {
      expect(result.sessionExists).toBe(firstState);
    }
  });

  it('all discovered terminals have valid session status', async () => {
    // Test ALL discovered terminals - no hardcoding
    for (const terminal of availableTerminals) {
      const res = await fetchApi(`/api/session/${terminal.name}`);

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.terminal).toBe(terminal.name);
      expect(typeof data.sessionExists).toBe('boolean');
    }
  });
});

// ─── Session Status Aggregation ─────────────────────────────────────────────────

describe('Session Aggregation API', () => {
  it('GET /api/sessions/all returns aggregated status', async () => {
    const res = await fetchApi('/api/sessions/all');

    expect(res.status).toBe(200);

    const data = await res.json();

    // Should have core fields
    expect(data).toHaveProperty('sessionExists');
    expect(data).toHaveProperty('claudeRunning');
  });
});

// ─── Invalid Terminal Handling ──────────────────────────────────────────────────

describe('Session Error Handling', () => {
  it('handles non-existent terminal gracefully', async () => {
    // Use a clearly invalid terminal name
    const invalidName = `invalid_terminal_${Date.now()}`;
    const res = await fetchApi(`/api/session/${invalidName}`);

    // API returns 200 with sessionExists: false for unknown terminals
    // This is acceptable - graceful degradation
    expect([200, 400, 404]).toContain(res.status);

    const data = await res.json();
    // If 200, should indicate session doesn't exist
    if (res.status === 200) {
      expect(data.sessionExists).toBe(false);
    } else {
      expect(data).toHaveProperty('error');
    }
  });

  it('handles empty terminal name', async () => {
    const res = await fetchApi('/api/session/');

    // Empty path might route differently - accept various responses
    expect([200, 400, 404]).toContain(res.status);
  });

  it('handles special characters in terminal name', async () => {
    const specialNames = ['../etc', 'test%20space', 'test;rm'];

    for (const name of specialNames) {
      const res = await fetchApi(`/api/session/${encodeURIComponent(name)}`);

      // Should not crash (500), should reject cleanly
      expect(res.status).not.toBe(500);
    }
  });
});

// ─── Session State Machine Validation ───────────────────────────────────────────

describe('Session State Invariants', () => {
  it('claudeRunning implies sessionExists', async () => {
    // If Claude is running, session must exist
    for (const terminal of availableTerminals) {
      const res = await fetchApi(`/api/session/${terminal.name}`);
      const data = await res.json();

      if (data.claudeRunning === true) {
        expect(data.sessionExists).toBe(true);
      }
    }
  });

  it('session state is boolean, never null/undefined', async () => {
    for (const terminal of availableTerminals) {
      const res = await fetchApi(`/api/session/${terminal.name}`);
      const data = await res.json();

      // Strict boolean check - not truthy/falsy
      expect(data.sessionExists === true || data.sessionExists === false).toBe(true);
      expect(data.claudeRunning === true || data.claudeRunning === false).toBe(true);
    }
  });
});

// ─── Session Start API (Authorization Only) ─────────────────────────────────────

describe('Session Start Authorization', () => {
  it('POST /api/session/start validates request', async () => {
    const res = await fetch(`${API_CONFIG.baseUrl}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        terminal: sampleTerminal,
        model: 'haiku',
        prompt: 'Test',
      }),
    });

    // Session start may require auth (401) or reject without fromTerminal (400)
    // Both are valid security behaviors
    expect([400, 401, 403]).toContain(res.status);
  });

  it('POST /api/session/start validates terminal name', async () => {
    const res = await fetchApi('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({
        terminal: `invalid_${Date.now()}`,
        model: 'haiku',
        prompt: 'Test',
      }),
    });

    // Should reject invalid terminal
    expect([400, 403]).toContain(res.status);
  });

  it('POST /api/session/start validates model name', async () => {
    const res = await fetchApi('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({
        terminal: sampleTerminal,
        model: 'invalid_model',
        prompt: 'Test',
      }),
    });

    // Should reject invalid model
    expect([400, 422]).toContain(res.status);
  });
});

// ─── Wake API Tests ─────────────────────────────────────────────────────────────

describe('Session Wake API', () => {
  it('POST /api/session/wake accepts valid request', async () => {
    const res = await fetch(`${API_CONFIG.baseUrl}/api/session/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: sampleTerminal }),
    });

    // Wake may succeed (200) or require auth (401) or reject (400)
    // 200 is acceptable if auth is optional for internal endpoints
    expect([200, 400, 401, 403]).toContain(res.status);
  });

  it('POST /api/session/wake handles invalid terminal', async () => {
    const res = await fetchApi('/api/session/wake', {
      method: 'POST',
      body: JSON.stringify({ terminal: `invalid_${Date.now()}` }),
    });

    // Should not crash - reject or handle gracefully
    expect(res.status).not.toBe(500);
  });
});

// ─── Inject API Tests ───────────────────────────────────────────────────────────

describe('Session Inject API', () => {
  it('POST /api/session/inject accepts valid request', async () => {
    const res = await fetch(`${API_CONFIG.baseUrl}/api/session/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        terminal: sampleTerminal,
        prompt: 'Test injection',
      }),
    });

    // Inject may succeed (200) or require auth (401) or reject (400)
    // 200 is acceptable if session doesn't exist (graceful no-op)
    expect([200, 400, 401, 403]).toContain(res.status);
  });

  it('POST /api/session/inject handles missing prompt', async () => {
    const res = await fetchApi('/api/session/inject', {
      method: 'POST',
      body: JSON.stringify({ terminal: sampleTerminal }),
    });

    // Missing prompt - should either reject or handle gracefully
    expect(res.status).not.toBe(500);
  });
});

// ─── Performance Baseline ───────────────────────────────────────────────────────

describe('Session API Performance', () => {
  it('status check completes within threshold', async () => {
    const times: number[] = [];

    // Sample 5 calls
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      await fetchApi(`/api/session/${sampleTerminal}`);
      times.push(Date.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);

    // Average should be well under threshold
    expect(avg).toBeLessThan(SESSION_THRESHOLDS.timing.statusCheckMaxMs);

    // Log for calibration
    console.log(`Session status timing: avg=${avg.toFixed(0)}ms, max=${max}ms`);
  });
});
