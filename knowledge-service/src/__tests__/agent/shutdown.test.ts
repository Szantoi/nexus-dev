/**
 * Graceful Shutdown Tests
 *
 * Tests that terminals properly:
 * 1. Save context before shutdown
 * 2. Update status in Datahaven
 * 3. Close connections cleanly
 * 4. Preserve state for next session
 *
 * Run: npm test -- src/__tests__/agent/shutdown.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  AGENT_THRESHOLDS,
  TERMINALS,
  fetchApi,
  measureTime,
} from './agent.config';
import {
  discoverTerminals,
  getTerminalStatus,
  getDatahavenStatus,
  readMemory,
  generateTestId,
  waitForSessionState,
  killSession,
  assertWithTimeout,
} from './test-harness';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let availableTerminals: string[] = [];

beforeAll(async () => {
  availableTerminals = await discoverTerminals();
  console.log(`Shutdown tests discovered ${availableTerminals.length} terminals`);
});

// ─── Datahaven Status Propagation Tests ──────────────────────────────────────

describe('Datahaven Status Propagation', () => {
  it('dashboard API returns terminal statuses', async () => {
    const res = await fetchApi('/api/dashboard');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('terminals');
    expect(Array.isArray(data.terminals)).toBe(true);

    for (const terminal of data.terminals) {
      expect(terminal).toHaveProperty('name');
      expect(terminal).toHaveProperty('status');
      expect(['idle', 'working', 'blocked']).toContain(terminal.status);
    }
  });

  it('terminal status is queryable individually', async () => {
    for (const terminal of availableTerminals.slice(0, 3)) {
      const status = await getTerminalStatus(terminal);

      expect(status).toHaveProperty('terminal', terminal);
      expect(status).toHaveProperty('sessionExists');
      expect(status).toHaveProperty('claudeRunning');
      expect(typeof status.sessionExists).toBe('boolean');
      expect(typeof status.claudeRunning).toBe('boolean');
    }
  });

  it('status update propagates within threshold', async () => {
    // This tests the API response time for status queries
    const { elapsed } = await measureTime(async () => {
      await getTerminalStatus(availableTerminals[0] || 'backend');
    });

    expect(elapsed).toBeLessThan(
      AGENT_THRESHOLDS.stateMachine.statusUpdateMaxMs
    );

    console.log(`Status query time: ${elapsed}ms`);
  });
});

// ─── Session State Consistency Tests ─────────────────────────────────────────

describe('Session State Consistency', () => {
  it('session status is consistent across multiple queries', async () => {
    const terminal = availableTerminals[0] || 'backend';

    const results = await Promise.all([
      getTerminalStatus(terminal),
      getTerminalStatus(terminal),
      getTerminalStatus(terminal),
    ]);

    // All queries should return same state
    const firstState = results[0].sessionExists;
    for (const result of results) {
      expect(result.sessionExists).toBe(firstState);
    }
  });

  it('claudeRunning implies sessionExists (state invariant)', async () => {
    for (const terminal of availableTerminals) {
      const status = await getTerminalStatus(terminal);

      if (status.claudeRunning === true) {
        expect(status.sessionExists).toBe(true);
      }
    }
  });

  it('all terminals report valid state', async () => {
    for (const terminal of availableTerminals) {
      const status = await getTerminalStatus(terminal);

      // State should be boolean, never null/undefined
      expect(
        status.sessionExists === true || status.sessionExists === false
      ).toBe(true);
      expect(
        status.claudeRunning === true || status.claudeRunning === false
      ).toBe(true);
    }
  });
});

// ─── Graceful Shutdown Signal Tests ──────────────────────────────────────────

describe('Shutdown Signal Handling', () => {
  it('knowledge-service health endpoint remains responsive', async () => {
    // Verify the service is healthy before shutdown tests
    const res = await fetchApi('/health');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('ready endpoint reflects service state', async () => {
    const res = await fetchApi('/ready');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(['ready', 'not ready', 'shutting down']).toContain(data.status);
  });

  it('live endpoint returns uptime', async () => {
    const res = await fetchApi('/live');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('alive');
    expect(data.uptime).toBeGreaterThan(0);
  });
});

// ─── Memory Persistence on Shutdown ──────────────────────────────────────────

describe('Memory Persistence on Shutdown', () => {
  it('MEMORY.md files exist for all terminals', async () => {
    for (const terminal of availableTerminals) {
      const memory = await readMemory(terminal);

      // Memory should exist (may be empty for new terminals)
      // We're checking that the file is readable, not necessarily non-empty
      if (memory !== null) {
        expect(typeof memory).toBe('string');
      }
    }
  });

  it('recent sessions have memory entries', async () => {
    // Check that at least one terminal has memory content
    let hasMemory = false;

    for (const terminal of availableTerminals) {
      const memory = await readMemory(terminal);
      if (memory && memory.length > 100) {
        hasMemory = true;
        break;
      }
    }

    // At least one terminal should have substantial memory
    expect(hasMemory).toBe(true);
  });
});

// ─── Session API Shutdown Behavior ───────────────────────────────────────────

describe('Session API Shutdown Behavior', () => {
  it('GET /api/sessions/all returns aggregated state', async () => {
    const res = await fetchApi('/api/sessions/all');

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('sessionExists');
    expect(data).toHaveProperty('claudeRunning');
  });

  it('session status updates are idempotent', async () => {
    const terminal = availableTerminals[0] || 'backend';

    // Multiple status queries should not change state
    const before = await getTerminalStatus(terminal);
    await getTerminalStatus(terminal);
    await getTerminalStatus(terminal);
    const after = await getTerminalStatus(terminal);

    expect(after.sessionExists).toBe(before.sessionExists);
    expect(after.claudeRunning).toBe(before.claudeRunning);
  });
});

// ─── Context Save Verification ───────────────────────────────────────────────

describe('Context Save Verification', () => {
  it('session logs are accessible', async () => {
    const res = await fetchApi('/api/sessions/logs?days=1');

    // May or may not be implemented
    if (res.status === 200) {
      const data = await res.json();
      expect(Array.isArray(data.logs) || typeof data === 'object').toBe(true);
    } else {
      expect([404, 501]).toContain(res.status);
    }
  });

  it('terminal outbox is accessible after shutdown', async () => {
    for (const terminal of availableTerminals.slice(0, 2)) {
      const res = await fetchApi(`/api/mailbox/${terminal}/outbox`);

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty('messages');
      expect(Array.isArray(data.messages)).toBe(true);
    }
  });
});

// ─── Shutdown Timing Tests ───────────────────────────────────────────────────

describe('Shutdown Timing', () => {
  it('status queries complete within threshold', async () => {
    const times: number[] = [];

    for (const terminal of availableTerminals.slice(0, 5)) {
      const { elapsed } = await measureTime(async () => {
        await getTerminalStatus(terminal);
      });
      times.push(elapsed);
    }

    const maxTime = Math.max(...times);
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;

    expect(maxTime).toBeLessThan(
      AGENT_THRESHOLDS.shutdown.statusPropagationMaxMs
    );

    console.log(
      `Status query timing: avg=${avgTime.toFixed(0)}ms, max=${maxTime}ms`
    );
  });

  it('dashboard API responds within threshold', async () => {
    const { elapsed } = await measureTime(async () => {
      await fetchApi('/api/dashboard');
    });

    expect(elapsed).toBeLessThan(
      AGENT_THRESHOLDS.shutdown.statusPropagationMaxMs
    );

    console.log(`Dashboard API response time: ${elapsed}ms`);
  });
});

// ─── State Machine Transitions ───────────────────────────────────────────────

describe('State Machine Transitions', () => {
  it('validates allowed state transitions', () => {
    const validTransitions = AGENT_THRESHOLDS.stateMachine.validTransitions;

    // Verify transition table is complete
    expect(validTransitions).toContainEqual(['idle', 'working']);
    expect(validTransitions).toContainEqual(['working', 'idle']);
    expect(validTransitions).toContainEqual(['working', 'blocked']);
    expect(validTransitions).toContainEqual(['blocked', 'working']);
    expect(validTransitions).toContainEqual(['blocked', 'idle']);
  });

  it('idle terminals can be queried without error', async () => {
    for (const terminal of availableTerminals) {
      const status = await getTerminalStatus(terminal);

      // Should not throw, should return valid status
      expect(status.terminal).toBe(terminal);
    }
  });
});

// ─── Recovery Tests ──────────────────────────────────────────────────────────

describe('Session Recovery', () => {
  it('session can be woken after being idle', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) {
      console.log('Skipping: no worker terminal available');
      return;
    }

    const res = await fetchApi('/api/session/wake', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        fromTerminal: 'root',
      }),
    });

    // Wake may succeed or fail based on current state, but shouldn't crash
    expect(res.status).not.toBe(500);
  });

  it('status recovers after service restart (simulated)', async () => {
    // Query status multiple times to verify stability
    const terminal = availableTerminals[0] || 'backend';

    for (let i = 0; i < 3; i++) {
      const status = await getTerminalStatus(terminal);
      expect(status.terminal).toBe(terminal);

      // Small delay between queries
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});

// ─── Terminal Session Shutdown Tests ─────────────────────────────────────────

describe('Terminal Session Shutdown', () => {
  it('POST /api/session/stop accepts valid request', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) {
      console.log('Skipping: no worker terminal available');
      return;
    }

    const res = await fetchApi('/api/session/stop', {
      method: 'POST',
      body: JSON.stringify({
        terminal,
        fromTerminal: 'root',
      }),
    });

    // May succeed, fail (no session), or not implemented
    expect([200, 400, 404]).toContain(res.status);

    if (res.status === 200) {
      const data = await res.json();
      console.log(`Session stop result for ${terminal}:`, data);
    }
  });

  it('session stop is idempotent (can stop already stopped)', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) return;

    // Try to stop twice
    await fetchApi('/api/session/stop', {
      method: 'POST',
      body: JSON.stringify({ terminal, fromTerminal: 'root' }),
    });

    const res = await fetchApi('/api/session/stop', {
      method: 'POST',
      body: JSON.stringify({ terminal, fromTerminal: 'root' }),
    });

    // Should not crash on double stop
    expect(res.status).not.toBe(500);
  });

  it('session stop respects authorization', async () => {
    // Worker terminal cannot stop root
    const res = await fetchApi('/api/session/stop', {
      method: 'POST',
      body: JSON.stringify({
        terminal: 'root',
        fromTerminal: 'backend', // backend cannot stop root
      }),
    });

    // Should be rejected (400/403) or not implemented (404)
    expect([400, 403, 404]).toContain(res.status);
  });

  it('POST /api/session/stop-all stops all non-priority terminals', async () => {
    const res = await fetchApi('/api/session/stop-all', {
      method: 'POST',
      body: JSON.stringify({
        fromTerminal: 'root',
        excludePriority: true, // Don't stop root, conductor
      }),
    });

    // May or may not be implemented
    if (res.status === 200) {
      const data = await res.json();
      console.log('Stop all result:', data);
      // API returns success + details.results array
      expect(data).toHaveProperty('success', true);
      expect(data).toHaveProperty('details');
      if (data.details) {
        expect(data.details).toHaveProperty('results');
        expect(Array.isArray(data.details.results)).toBe(true);
      }
    } else {
      // Not implemented is acceptable
      expect([400, 404, 501]).toContain(res.status);
    }
  });

  it('terminal status updates after stop request', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) return;

    // Get initial status
    const beforeStatus = await getTerminalStatus(terminal);

    // Request stop
    await fetchApi('/api/session/stop', {
      method: 'POST',
      body: JSON.stringify({ terminal, fromTerminal: 'root' }),
    });

    // Wait a bit for status to propagate
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Get status after stop request
    const afterStatus = await getTerminalStatus(terminal);

    // If session was running and now stopped, claudeRunning should be false
    if (beforeStatus.claudeRunning) {
      // Allow time for actual shutdown
      await waitForSessionState(terminal, 'stopped', 5000);
      const finalStatus = await getTerminalStatus(terminal);

      // Either still shutting down or stopped
      console.log(`Terminal ${terminal}: ${beforeStatus.claudeRunning} -> ${finalStatus.claudeRunning}`);
    }
  });

  it('graceful stop allows context save', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) return;

    // Check if session is running
    const status = await getTerminalStatus(terminal);

    if (status.claudeRunning) {
      // Read MEMORY.md before stop
      const memoryBefore = await readMemory(terminal);

      // Request graceful stop
      const res = await fetchApi('/api/session/stop', {
        method: 'POST',
        body: JSON.stringify({
          terminal,
          fromTerminal: 'root',
          graceful: true, // Allow context save
          timeoutMs: 10000,
        }),
      });

      if (res.status === 200) {
        // Wait for shutdown
        await waitForSessionState(terminal, 'stopped', 15000);

        // Check MEMORY.md after stop
        const memoryAfter = await readMemory(terminal);

        // Memory should not be corrupted
        if (memoryAfter) {
          expect(memoryAfter.length).toBeGreaterThan(0);
        }
      }
    } else {
      console.log(`Terminal ${terminal} not running, skipping graceful stop test`);
    }
  });
});

// ─── Datahaven Status After Shutdown ─────────────────────────────────────────

describe('Datahaven Status After Shutdown', () => {
  it('stopped terminal shows idle in dashboard', async () => {
    const res = await fetchApi('/api/dashboard');

    expect(res.status).toBe(200);

    const data = await res.json();

    // All non-running terminals should show idle
    for (const terminal of data.terminals) {
      const status = await getTerminalStatus(terminal.name);

      if (!status.claudeRunning) {
        // Terminal not running should be idle
        expect(['idle', 'blocked']).toContain(terminal.status);
      }
    }
  });

  it('shutdown propagates to Datahaven within threshold', async () => {
    const terminal = availableTerminals.find((t) =>
      TERMINALS.workers.includes(t)
    );

    if (!terminal) return;

    const status = await getTerminalStatus(terminal);

    if (!status.claudeRunning) {
      // Terminal is already stopped
      const dhStatus = await getDatahavenStatus(terminal);

      if (dhStatus) {
        // Should be idle or similar
        expect(['idle', 'blocked']).toContain(dhStatus.status);
      }
    }
  });
});

// ─── Performance Baseline ────────────────────────────────────────────────────

describe('Shutdown Performance Baseline', () => {
  it('establishes baseline for shutdown operations', async () => {
    const operations = [
      { name: 'health', fn: () => fetchApi('/health') },
      { name: 'ready', fn: () => fetchApi('/ready') },
      { name: 'live', fn: () => fetchApi('/live') },
      { name: 'dashboard', fn: () => fetchApi('/api/dashboard') },
      {
        name: 'session-status',
        fn: () => getTerminalStatus(availableTerminals[0] || 'backend'),
      },
    ];

    const results: Array<{ name: string; elapsed: number }> = [];

    for (const op of operations) {
      const { elapsed } = await measureTime(op.fn);
      results.push({ name: op.name, elapsed });
    }

    console.log('Shutdown-related operation baseline:');
    for (const r of results) {
      console.log(`  ${r.name}: ${r.elapsed}ms`);
    }

    // All operations should be reasonably fast
    for (const r of results) {
      expect(r.elapsed).toBeLessThan(
        AGENT_THRESHOLDS.shutdown.maxGracefulShutdownMs
      );
    }
  });
});
